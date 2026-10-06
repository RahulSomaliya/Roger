import { randomUUID } from 'node:crypto';
import type { SttStreamState } from '../../shared/capture';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import { pcmBytesToMs } from '../../shared/pcm';
import {
  AUDIO_SOURCES,
  SPEAKER_FOR_SOURCE,
  type AudioSource,
  type InterimTranscript,
  type TranscriptSegment,
} from '../../shared/transcript';
import { errorMessage, type Logger } from '../logger';
import type { TranscriptStore } from '../store/TranscriptStore';
import type { SpeechToText, SttEvent, SttStream, SttStreamSettings } from '../stt/SpeechToText';

export interface CaptureSessionListeners {
  onSegment(segment: TranscriptSegment): void;
  onInterim(interim: InterimTranscript): void;
  /** A source's vendor session changed state; `message` says why it is not open, or null. */
  onStreamState(source: AudioSource, state: SttStreamState, message: string | null): void;
  /** A stream died while the session was still recording. The session keeps the other stream. */
  onStreamFailure(source: AudioSource, reason: string): void;
  /** A final line could not be written to the local store. onSegment still gets it right after. */
  onSaveFailure(source: AudioSource, reason: string): void;
}

export interface CaptureSessionOptions {
  meetingId: string;
  /** Epoch ms of the meeting start; all offsets are relative to it. */
  meetingStartedAtMs: number;
  stt: SpeechToText;
  accessToken: string;
  settings: SttStreamSettings;
  /**
   * A fresh token for a reopen. Start's token is only good for opening within its TTL (AssemblyAI:
   * 30 s by default), so a source that reopens minutes later needs a new one from the API.
   */
  refreshCredentials: () => Promise<StreamCredentials>;
  /** Audio held while a source reopens (costGuards: sttReopenBufferMs). */
  reopenBufferMs: number;
  store: TranscriptStore;
  logger: Logger;
  listeners: CaptureSessionListeners;
  clock?: () => number;
}

export interface StreamCredentials {
  accessToken: string;
  settings: SttStreamSettings;
}

/**
 * Buffered audio is dropped when chunks stop for longer than this: the vendor hears its audio as
 * one continuous stream, so a gap kept in the buffer would date every later line too early.
 */
const BUFFER_GAP_MS = 1_000;

interface HeldChunk {
  pcm: Uint8Array;
  /** Clock time it arrived, which dates it once it is sent. */
  atMs: number;
}

/** One vendor stream, from its open until its close settles. */
interface StreamHandle {
  readonly stream: SttStream;
  /**
   * Meeting offset of the stream's first audio byte, the vendor's time zero. Per stream, not per
   * source: a reopened stream starts its own clock. Null until its first chunk is sent.
   */
  offsetMs: number | null;
  /** Set once the stream was asked to close; settles when it has. */
  closing: Promise<void> | null;
}

/** What one audio source has with the vendor right now. */
interface SourceLink {
  state: SttStreamState;
  /** The stream carrying this source's audio, or null. Only `open` has one. */
  current: StreamHandle | null;
  /** Bumped by every open and every close, so an open that lands late knows it is stale. */
  attempt: number;
  /** Audio that arrived while the source reconnects, oldest first, sent once it is open. */
  held: HeldChunk[];
  heldMs: number;
  /** Chunks dropped from `held` (over the bound, or before a gap) since the last flush. */
  heldDropped: number;
}

/**
 * One meeting's live pipeline: one speech-to-text stream per audio source, finals written to the
 * local store the moment they arrive (house rule 1), interims passed straight to the UI.
 *
 * Vendors bill every second a session is open, silent or not, so a source that has no audio must
 * not hold one: a source that fails or ends closes its own session at once (closeSource), one that
 * sends nothing for the stall window closes it until its audio returns (pauseSource), and the other
 * source keeps going either way. A paused source reopens on its next chunk with a fresh token; the
 * chunks that arrive meanwhile are held (bounded) and sent in order once it is open, so the chunk
 * that woke it is not lost and each stream's clock starts at its own first byte.
 *
 * Every stream this class ever opened is tracked until its close settles, and close() waits for
 * all of them, and for reopens still connecting.
 */
export class CaptureSession {
  readonly meetingId: string;
  private readonly links: Record<AudioSource, SourceLink> = { mic: newLink(), system: newLink() };
  /** Every stream not yet closed, the ones closing included: close() waits for each. */
  private readonly handles = new Set<StreamHandle>();
  /** Reopens in flight: close() waits for them, so a late stream cannot outlive Stop. */
  private readonly reopening = new Set<Promise<void>>();
  private readonly clock: () => number;
  private segmentsStored = 0;
  private closing = false;

  constructor(private readonly options: CaptureSessionOptions) {
    this.meetingId = options.meetingId;
    this.clock = options.clock ?? (() => Date.now());
  }

  get storedSegmentCount(): number {
    return this.segmentsStored;
  }

  /**
   * Open every stream. If any fails, the ones that opened are closed and the first error is
   * rethrown. Each open starts one vendor session per source, and vendors meter sessions started
   * (AssemblyAI: 5 a minute on a free account), so a retry or reconnect loop around this spends
   * that budget fast.
   */
  async open(): Promise<void> {
    const results = await Promise.allSettled(
      AUDIO_SOURCES.map((source) => this.openStream(source)),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) {
      await this.close();
      throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
    }
  }

  pushAudio(source: AudioSource, pcm: Uint8Array): void {
    if (this.closing) return;
    const link = this.links[source];
    const now = this.clock();
    switch (link.state) {
      case 'open':
        if (link.current !== null) this.send(link.current, pcm, now);
        return;
      case 'connecting':
        this.hold(link, pcm, now);
        return;
      case 'paused':
        this.hold(link, pcm, now);
        this.startReopen(source);
        return;
      case 'closed':
      case 'error':
        // No session for this source and none coming: a failed source never reopens itself.
        return;
    }
  }

  /**
   * The source sent no audio for the stall window (CaptureService decides when): close its session
   * so it stops billing, and reopen it with the next chunk. Only an open or connecting source
   * pauses; one already closed or failed stays as it is.
   */
  pauseSource(source: AudioSource, silentForMs: number): void {
    if (this.closing) return;
    const link = this.links[source];
    if (link.state !== 'open' && link.state !== 'connecting') return;
    link.attempt += 1;
    const handle = link.current;
    link.current = null;
    this.dropHeld(link);
    const seconds = Math.round(silentForMs / 1000);
    this.options.logger.info('speech-to-text stream paused: no audio', { source, silentForMs });
    this.setState(source, 'paused', `no audio for ${seconds} s; reconnects when audio returns`);
    if (handle !== null) void this.retire(handle);
  }

  /**
   * The source failed or ended: close its vendor session now, without waiting for Stop. The
   * renderer reports this once the track is gone for good, so the session would only bill silence
   * (Deepgram even kept it alive with KeepAlive) for the rest of the meeting. It stays closed: a
   * dead track never comes back, only a new Start reopens the device.
   */
  closeSource(source: AudioSource, reason: string): void {
    if (this.closing) return;
    const link = this.links[source];
    link.attempt += 1;
    const handle = link.current;
    link.current = null;
    this.dropHeld(link);
    if (link.state === 'closed') return;
    this.setState(source, 'closed', reason);
    if (handle !== null) {
      this.options.logger.info('speech-to-text stream closed: the source has no audio', {
        source,
        reason,
      });
      void this.retire(handle);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const link of Object.values(this.links)) {
      link.attempt += 1;
      if (link.current !== null) void this.retire(link.current);
      link.current = null;
      this.dropHeld(link);
    }
    // A reopen still connecting closes its stream itself once it lands (it is stale now).
    await Promise.all([...this.reopening]);
    await Promise.all([...this.handles].map((handle) => this.retire(handle)));
  }

  private async openStream(source: AudioSource): Promise<void> {
    const { stt, accessToken, settings } = this.options;
    const link = this.links[source];
    const attempt = (link.attempt += 1);
    this.setState(source, 'connecting', null);
    const handle = this.track(
      source,
      await stt.openStream({ accessToken, settings, label: source }),
    );
    if (this.closing || link.attempt !== attempt) {
      // Another stream failed, or the source closed, while this one was connecting: do not leak it.
      await this.retire(handle);
      return;
    }
    this.attach(source, handle);
  }

  private startReopen(source: AudioSource): void {
    const reopen = this.reopen(source);
    this.reopening.add(reopen);
    void reopen.finally(() => {
      this.reopening.delete(reopen);
    });
  }

  /** Never rejects: a failure becomes the source's state, and the stream it may have opened closes. */
  private async reopen(source: AudioSource): Promise<void> {
    const link = this.links[source];
    const attempt = (link.attempt += 1);
    const stale = (): boolean => this.closing || link.attempt !== attempt;
    this.setState(source, 'connecting', null);
    let handle: StreamHandle;
    try {
      const { accessToken, settings } = await this.options.refreshCredentials();
      if (stale()) return;
      handle = this.track(
        source,
        await this.options.stt.openStream({ accessToken, settings, label: source }),
      );
    } catch (error) {
      if (stale()) return;
      this.reopenFailed(source, errorMessage(error));
      return;
    }
    if (stale()) {
      await this.retire(handle);
      return;
    }
    this.attach(source, handle);
    this.options.logger.info('speech-to-text stream reopened', { source });
  }

  private reopenFailed(source: AudioSource, reason: string): void {
    const link = this.links[source];
    this.dropHeld(link);
    const message = `could not reconnect: ${reason}`;
    this.options.logger.warn('speech-to-text stream did not reopen', { source, reason });
    this.setState(source, 'error', message);
    this.options.listeners.onStreamFailure(source, message);
  }

  /** The stream now carries the source: send what was held while it connected, in order. */
  private attach(source: AudioSource, handle: StreamHandle): void {
    const link = this.links[source];
    link.current = handle;
    this.setState(source, 'open', null);
    const held = link.held;
    if (link.heldDropped > 0) {
      this.options.logger.warn('audio dropped while reconnecting', {
        source,
        chunks: link.heldDropped,
      });
    }
    this.dropHeld(link);
    for (const chunk of held) this.send(handle, chunk.pcm, chunk.atMs);
  }

  /**
   * Keeps the newest reopenBufferMs of audio. It is sent all at once when the stream opens, and
   * AssemblyAI closes a session sent audio faster than real time (3007), so the bound stays a few
   * seconds (costGuards.sttReopenBufferMs); a connect takes about one.
   */
  private hold(link: SourceLink, pcm: Uint8Array, now: number): void {
    const last = link.held.at(-1);
    if (last !== undefined && now - last.atMs > BUFFER_GAP_MS) {
      link.heldDropped += link.held.length;
      link.held = [];
      link.heldMs = 0;
    }
    link.held.push({ pcm, atMs: now });
    link.heldMs += this.chunkMs(pcm);
    while (link.heldMs > this.options.reopenBufferMs && link.held.length > 1) {
      const oldest = link.held.shift();
      if (oldest === undefined) break;
      link.heldMs -= this.chunkMs(oldest.pcm);
      link.heldDropped += 1;
    }
  }

  private dropHeld(link: SourceLink): void {
    link.held = [];
    link.heldMs = 0;
    link.heldDropped = 0;
  }

  private chunkMs(pcm: Uint8Array): number {
    return pcmBytesToMs(pcm.byteLength, this.options.settings.sampleRate || PCM_SAMPLE_RATE);
  }

  /** Every stream is tracked from the moment it exists, so close() can never miss one. */
  private track(source: AudioSource, stream: SttStream): StreamHandle {
    const handle: StreamHandle = { stream, offsetMs: null, closing: null };
    this.handles.add(handle);
    stream.on((event) => {
      this.handleEvent(source, handle, event);
    });
    return handle;
  }

  /** Asks the stream to close (idempotent); the handle is forgotten once it has. */
  private retire(handle: StreamHandle): Promise<void> {
    handle.closing ??= handle.stream
      .close()
      .catch((error: unknown) => {
        this.options.logger.warn('stream close failed', { error: errorMessage(error) });
      })
      .finally(() => {
        this.handles.delete(handle);
      });
    return handle.closing;
  }

  private send(handle: StreamHandle, pcm: Uint8Array, arrivedAtMs: number): void {
    if (handle.offsetMs === null) {
      // The vendor's clock starts at its first audio byte. That byte was captured one chunk
      // before it reached us, so the offset is its arrival minus the chunk's own duration.
      // Adapters must hand the vendor every byte, in order (AssemblyAI regroups them; see
      // SttConnection.sendFrame).
      const captured = arrivedAtMs - this.chunkMs(pcm);
      handle.offsetMs = Math.max(0, captured - this.options.meetingStartedAtMs);
    }
    handle.stream.send(pcm);
  }

  private setState(source: AudioSource, state: SttStreamState, message: string | null): void {
    this.links[source].state = state;
    this.options.listeners.onStreamState(source, state, message);
  }

  private handleEvent(source: AudioSource, handle: StreamHandle, event: SttEvent): void {
    const offset = handle.offsetMs ?? 0;
    const { listeners, logger } = this.options;
    switch (event.type) {
      case 'final': {
        const segment: TranscriptSegment = {
          id: randomUUID(),
          meetingId: this.meetingId,
          source,
          speaker: SPEAKER_FOR_SOURCE[source],
          startMs: offset + event.startMs,
          endMs: offset + event.endMs,
          text: event.text,
          confidence: event.confidence,
          words: event.words.map((word) => ({
            ...word,
            startMs: offset + word.startMs,
            endMs: offset + word.endMs,
          })),
          createdAt: new Date(this.clock()).toISOString(),
        };
        try {
          this.options.store.appendSegment(segment);
          this.segmentsStored += 1;
        } catch (error) {
          // Disk full, or SQLite busy past its timeout. Uncaught, this became a non-fatal vendor
          // error that was only logged: the line was gone and the screen said nothing. The session
          // keeps recording (see CaptureService's onSaveFailure for why) and still shows the line.
          const reason = errorMessage(error);
          logger.error('line not saved locally', {
            meetingId: this.meetingId,
            source,
            segmentId: segment.id,
            reason,
          });
          listeners.onSaveFailure(source, reason);
        }
        listeners.onSegment(segment);
        return;
      }
      case 'interim':
        listeners.onInterim({
          meetingId: this.meetingId,
          source,
          text: event.text,
          startMs: offset + event.startMs,
          endMs: offset + event.endMs,
        });
        return;
      case 'error':
        logger.error('speech-to-text error', {
          source,
          message: event.message,
          fatal: event.fatal,
        });
        if (event.fatal) this.streamFailed(source, handle, event.message);
        return;
      case 'closed': {
        const reason = describeClose(event.code, event.reason);
        logger.info('speech-to-text stream closed', { source, reason });
        // Not asked to close: the vendor or the network ended the stream mid-call.
        this.streamFailed(source, handle, `connection closed (${reason})`);
      }
    }
  }

  /**
   * The source's current stream died mid-call. A stream we asked to close (Stop, a failed source)
   * is no longer current, so its "closed" is not a failure. The dead stream is closed too: the core
   * closes itself after a fatal error, but a stream that only reported one must not stay open.
   */
  private streamFailed(source: AudioSource, handle: StreamHandle, reason: string): void {
    const link = this.links[source];
    if (this.closing || link.current !== handle) return;
    link.current = null;
    link.attempt += 1;
    void this.retire(handle);
    this.setState(source, 'error', reason);
    this.options.listeners.onStreamFailure(source, reason);
  }
}

function newLink(): SourceLink {
  return { state: 'closed', current: null, attempt: 0, held: [], heldMs: 0, heldDropped: 0 };
}

function describeClose(code: number | null, reason: string | null): string {
  if (code === null && reason === null) return 'no close code';
  return [code === null ? null : `code ${code}`, reason]
    .filter((part) => part !== null && part !== '')
    .join(': ');
}
