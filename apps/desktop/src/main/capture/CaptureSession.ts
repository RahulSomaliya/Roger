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
import { AudioTimeline, type TimelineEdge } from './AudioTimeline';
import type { SttOpenBudget, SttOpenDecision } from './SttOpenBudget';

export interface CaptureSessionListeners {
  onSegment(segment: TranscriptSegment): void;
  onInterim(interim: InterimTranscript): void;
  /** A source's vendor session changed state; `message` says why it is not open, or null. */
  onStreamState(source: AudioSource, state: SttStreamState, message: string | null): void;
  /**
   * A source's stream died, or could not reopen, while recording. `retryAtMs` is when it may reopen
   * (with its next chunk from then on), or null when it will not reopen this meeting. The session
   * keeps the other stream either way.
   */
  onStreamFailure(source: AudioSource, reason: string, retryAtMs: number | null): void;
  /** A final line could not be written to the local store. onSegment still gets it right after. */
  onSaveFailure(source: AudioSource, reason: string): void;
  /** One of the source's streams finished closing mid-meeting (not at Stop): meter it now. */
  onStreamClosed(source: AudioSource): void;
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
  /**
   * The gate every vendor session open passes, Start's included (SttOpenBudget). Shared by both
   * sources; CaptureService keeps it across meetings because the vendor counts per account.
   */
  budget: SttOpenBudget;
  /** First wait before reopening after a failure, doubling per failure in a row, up to the max. */
  reopenBackoffMs: number;
  reopenBackoffMaxMs: number;
  store: TranscriptStore;
  logger: Logger;
  listeners: CaptureSessionListeners;
  clock?: () => number;
}

export interface StreamCredentials {
  accessToken: string;
  settings: SttStreamSettings;
}

/** Bytes per sample of PCM_ENCODING (Int16 mono). */
const SAMPLE_BYTES = 2;

/**
 * A stream that stayed open this long before failing counts as healthy: its failure starts the
 * backoff over instead of doubling it. A minute is the open budget's window.
 */
const HEALTHY_STREAM_MS = 60_000;

interface HeldChunk {
  pcm: Uint8Array;
  /** Wall clock of its first sample, where it was captured: its stream's timeline dates it. */
  capturedAtMs: number;
}

/** One vendor stream, from its open until its close settles. */
interface StreamHandle {
  readonly stream: SttStream;
  readonly source: AudioSource;
  /**
   * When each stretch of the audio this stream was sent was captured: the vendor's times map to
   * the meeting through it. Per stream, not per source: a reopened stream's time zero is its own
   * first chunk (the first one held while it connected), and a late line from a stream already
   * replaced still counts on its own clock.
   */
  readonly timeline: AudioTimeline;
  /** Set once the stream was asked to close; settles when it has. */
  closing: Promise<void> | null;
  readonly openedAtMs: number;
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
  /** Chunks dropped from `held` (over the bound) since the last flush. */
  heldDropped: number;
  /** No reopen starts before this clock time (backoff, or the budget's minute). */
  notBeforeMs: number;
  /** Failures in a row, for the backoff. */
  failures: number;
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
 * that woke it is not lost.
 *
 * Every chunk comes with the wall clock of its first sample, and each stream places the audio it
 * was sent on its own AudioTimeline: a vendor time maps to the meeting through the run of audio
 * that holds it. A stall, a held reconnect or a sleep leaves no hole in what the vendor hears, so
 * dating lines from a stream's first chunk alone (M1) made every line after a gap early by the
 * gap.
 *
 * A stream the vendor ends mid-call (an error, a close, AssemblyAI's 3-hour cap) reopens the same
 * way after a backoff that doubles per failure in a row. Every open, Start's two included, passes
 * the shared SttOpenBudget first; when it says no, the source waits for the minute to pass or, with
 * the meeting's opens spent, stays closed with an error saying why. Nothing reopens without audio.
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
  /** Samples per second of the audio both sources send; every stream's timeline counts in it. */
  private readonly sampleRate: number;
  private segmentsStored = 0;
  private closing = false;

  constructor(private readonly options: CaptureSessionOptions) {
    this.meetingId = options.meetingId;
    this.clock = options.clock ?? (() => Date.now());
    this.sampleRate = options.settings.sampleRate || PCM_SAMPLE_RATE;
    // Checked here, before any socket: track() builds each stream's AudioTimeline only once its
    // socket is open, and the timeline's own refusal there would leave that socket open.
    if (!Number.isInteger(this.sampleRate) || this.sampleRate <= 0) {
      throw new RangeError(
        `Speech-to-text needs a positive whole sample rate, not ${options.settings.sampleRate}.`,
      );
    }
  }

  get storedSegmentCount(): number {
    return this.segmentsStored;
  }

  /**
   * Start: open every stream. If any fails, the ones that opened are closed and the first error is
   * rethrown. The opens are taken from the budget together first (AssemblyAI starts 5 sessions a
   * minute on a free account, and each Start opens two); a refusal throws before any socket.
   */
  async open(): Promise<void> {
    // Both or neither: a Start with one source would look like a working meeting.
    const grant = this.options.budget.acquire(AUDIO_SOURCES.length);
    if (!grant.ok) throw new Error(`Speech-to-text was not started: ${grant.message}`);
    const results = await Promise.allSettled(
      AUDIO_SOURCES.map((source) => this.openStream(source)),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) {
      await this.close();
      throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
    }
  }

  /**
   * One chunk of `source`. `capturedAtMs` is the wall clock (epoch ms) of its first sample, taken
   * where it was captured (renderer or helper), or CaptureService's arrival estimate when the
   * source sent none; the lines from this audio are dated by it, never by when it reached main.
   *
   * CaptureService binds this method straight into its AudioFanout (`onChunk`), so the parameters
   * keep AudioSink.onChunk's order: a wrapper that passed two would drop every capture time. A
   * chunk with no usable time or half a sample throws a RangeError; the fan-out logs it as a
   * failing sink and the vendor gets none of that chunk.
   */
  pushAudio(source: AudioSource, pcm: Uint8Array, capturedAtMs: number): void {
    if (!Number.isFinite(capturedAtMs)) {
      throw new RangeError(
        `A ${source} audio chunk has no usable capture time (${capturedAtMs}): it cannot be dated.`,
      );
    }
    if (pcm.byteLength % SAMPLE_BYTES !== 0) {
      // Half a sample would shift every later sample the vendor hears, and the timeline with it.
      throw new RangeError(
        `A ${source} audio chunk of ${pcm.byteLength} bytes is not whole Int16 samples.`,
      );
    }
    if (this.closing) return;
    const link = this.links[source];
    switch (link.state) {
      case 'open':
        if (link.current !== null) this.send(link.current, pcm, capturedAtMs);
        return;
      case 'connecting':
        this.hold(link, pcm, capturedAtMs);
        return;
      case 'paused':
      case 'retrying':
        this.hold(link, pcm, capturedAtMs);
        if (this.clock() >= link.notBeforeMs) this.startReopen(source);
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
    link.notBeforeMs = 0;
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
    // A reopen still connecting closes its stream itself once it lands (it is stale now). The wait
    // is bounded by the API client's timeout and the adapter's connect timeout (10 s each).
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
    // Asked before the token too, so a spent budget costs no API call.
    const ahead = this.options.budget.check();
    if (!ahead.ok) {
      this.budgetRefused(source, ahead);
      return;
    }
    this.setState(source, 'connecting', null);
    let handle: StreamHandle;
    try {
      const { accessToken, settings } = await this.options.refreshCredentials();
      if (stale()) return;
      // Taken right before the open, the only place an open happens: an adapter never opens one.
      const grant = this.options.budget.acquire();
      if (!grant.ok) {
        this.budgetRefused(source, grant);
        return;
      }
      handle = this.track(
        source,
        await this.options.stt.openStream({ accessToken, settings, label: source }),
      );
    } catch (error) {
      if (stale()) return;
      const reason = `could not reconnect: ${errorMessage(error)}`;
      this.options.logger.warn('speech-to-text stream did not reopen', { source, reason });
      this.scheduleRetry(source, reason, null);
      return;
    }
    if (stale()) {
      await this.retire(handle);
      return;
    }
    this.attach(source, handle);
    this.options.logger.info('speech-to-text stream reopened', { source });
  }

  /**
   * After a failure: reopen with the next chunk once the backoff has passed, unless the meeting's
   * opens are spent. A vendor that fails on every open would otherwise reopen, and bill a
   * handshake, as fast as chunks arrive (ten a second).
   */
  private scheduleRetry(source: AudioSource, reason: string, openedForMs: number | null): void {
    const link = this.links[source];
    link.failures =
      openedForMs !== null && openedForMs >= HEALTHY_STREAM_MS ? 1 : link.failures + 1;
    const budget = this.options.budget.check();
    if (!budget.ok && budget.kind === 'per-meeting') {
      this.giveUp(source, `${reason}; not reconnecting: ${budget.message}`);
      return;
    }
    const { reopenBackoffMs, reopenBackoffMaxMs } = this.options;
    const waitMs = Math.min(reopenBackoffMaxMs, reopenBackoffMs * 2 ** (link.failures - 1));
    link.notBeforeMs = this.clock() + waitMs;
    this.setState(source, 'retrying', reason);
    this.options.listeners.onStreamFailure(source, reason, link.notBeforeMs);
  }

  /** The budget said no to a reopen: wait for the minute to pass, or stop for this meeting. */
  private budgetRefused(
    source: AudioSource,
    decision: Exclude<SttOpenDecision, { ok: true }>,
  ): void {
    this.options.logger.warn('speech-to-text reopen refused by the open budget', {
      source,
      limit: decision.kind,
    });
    if (decision.kind === 'per-meeting') {
      this.giveUp(source, `not reconnecting: ${decision.message}`);
      return;
    }
    const link = this.links[source];
    link.notBeforeMs = decision.retryAtMs;
    const message = `waiting to reconnect: ${decision.message}`;
    this.setState(source, 'retrying', message);
    this.options.listeners.onStreamFailure(source, message, decision.retryAtMs);
  }

  private giveUp(source: AudioSource, message: string): void {
    this.dropHeld(this.links[source]);
    this.setState(source, 'error', message);
    this.options.listeners.onStreamFailure(source, message, null);
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
    // Handed over at once, sent at 1x: AssemblyAI takes no audio faster than real time (3007), so
    // the core paces held audio (SttConnection.pump), and it adds its own length of lag to this
    // session until it closes. Past the held audio nothing is replayed inline: that window is a
    // gap, for M2-T6 to record and M2-T16 to re-run from the backup.
    for (const chunk of held) this.send(handle, chunk.pcm, chunk.capturedAtMs);
  }

  /**
   * Keeps the newest reopenBufferMs of audio. Once the stream opens the core paces it at 1x
   * (AssemblyAI closes a session sent audio faster than real time, 3007), so every held second is
   * lag on that session until it closes: the bound stays a few seconds
   * (costGuards.sttReopenBufferMs); a connect takes about one.
   *
   * Audio from both sides of a gap is kept: each chunk keeps its capture time, so the stream's
   * timeline starts a new run at the gap and the lines on either side keep their own times. (M1
   * dropped the held audio before any gap over 1 s, because it dated lines from the first chunk
   * alone and a gap would have made every later line early.)
   */
  private hold(link: SourceLink, pcm: Uint8Array, capturedAtMs: number): void {
    link.held.push({ pcm, capturedAtMs });
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
    return pcmBytesToMs(pcm.byteLength, this.sampleRate);
  }

  /** Every stream is tracked from the moment it exists, so close() can never miss one. */
  private track(source: AudioSource, stream: SttStream): StreamHandle {
    const handle: StreamHandle = {
      stream,
      source,
      timeline: new AudioTimeline(this.sampleRate),
      closing: null,
      openedAtMs: this.clock(),
    };
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
        // Stop meters every stream at once itself; mid-meeting closes are metered one by one.
        if (!this.closing) this.options.listeners.onStreamClosed(handle.source);
      });
    return handle.closing;
  }

  private send(handle: StreamHandle, pcm: Uint8Array, capturedAtMs: number): void {
    // The timeline counts the vendor's clock in the samples sent here, so adapters must hand the
    // vendor every byte, in order (AssemblyAI regroups them; see SttConnection.sendFrame).
    const run = handle.timeline.append(capturedAtMs, pcm.byteLength / SAMPLE_BYTES);
    if (run !== null && run.jumpMs !== null) {
      this.options.logger.info('audio timeline: new run', {
        source: handle.source,
        jumpMs: Math.round(run.jumpMs),
        runs: handle.timeline.runs.length,
      });
    }
    handle.stream.send(pcm);
  }

  /** A span on one stream's own clock (the vendor's) as meeting offsets: see meetingOffset. */
  private meetingSpan(
    handle: StreamHandle,
    span: { startMs: number; endMs: number },
  ): { startMs: number; endMs: number } {
    const startMs = this.meetingOffset(handle, span.startMs, 'start');
    // A run that starts earlier than its predecessor predicted (the wall clock was set back) would
    // date the end of a span across it before its start, which the API refuses (end_ms >= start_ms).
    return { startMs, endMs: Math.max(startMs, this.meetingOffset(handle, span.endMs, 'end')) };
  }

  /**
   * A time on the stream's own clock (ms from the first byte it was sent) as ms from the meeting
   * start, through the run of audio that holds it. Whole ms: the renderer's capture times are
   * fractional (performance.now) and the API's offsets are integers (OffsetMs), so it would refuse
   * a fraction with a 422 and the uploader would set the line aside for good. Never negative
   * (OffsetMs again): audio captured just before the start counts from 0.
   */
  private meetingOffset(handle: StreamHandle, streamMs: number, edge: TimelineEdge): number {
    const { meetingStartedAtMs } = this.options;
    // No audio sent yet, so no run to map through: a vendor sends no line before it heard any, and
    // the landed rule (the stream's offset 0) stands in if one ever does.
    const capturedAtMs =
      handle.timeline.toCapturedAtMs(streamMs, edge) ?? meetingStartedAtMs + streamMs;
    return Math.max(0, Math.round(capturedAtMs - meetingStartedAtMs));
  }

  private setState(source: AudioSource, state: SttStreamState, message: string | null): void {
    this.links[source].state = state;
    this.options.listeners.onStreamState(source, state, message);
  }

  private handleEvent(source: AudioSource, handle: StreamHandle, event: SttEvent): void {
    const { listeners, logger } = this.options;
    switch (event.type) {
      case 'final': {
        const segment: TranscriptSegment = {
          id: randomUUID(),
          meetingId: this.meetingId,
          source,
          speaker: SPEAKER_FOR_SOURCE[source],
          ...this.meetingSpan(handle, event),
          text: event.text,
          confidence: event.confidence,
          words: event.words.map((word) => ({ ...word, ...this.meetingSpan(handle, word) })),
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
          ...this.meetingSpan(handle, event),
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
    this.scheduleRetry(source, reason, this.clock() - handle.openedAtMs);
  }
}

function newLink(): SourceLink {
  return {
    state: 'closed',
    current: null,
    attempt: 0,
    held: [],
    heldMs: 0,
    heldDropped: 0,
    notBeforeMs: 0,
    failures: 0,
  };
}

function describeClose(code: number | null, reason: string | null): string {
  if (code === null && reason === null) return 'no close code';
  return [code === null ? null : `code ${code}`, reason]
    .filter((part) => part !== null && part !== '')
    .join(': ');
}
