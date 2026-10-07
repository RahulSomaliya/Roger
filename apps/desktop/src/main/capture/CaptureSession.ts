import { randomUUID } from 'node:crypto';
import type { CaptureWarningKind, SttStreamState } from '../../shared/capture';
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
import type { GapReason, JsonObject, TranscriptStore } from '../store/TranscriptStore';
import { LatencyMeter } from '../stt/LatencyMeter';
import {
  type SpeechToText,
  SttConnectError,
  type SttEvent,
  type SttStream,
  type SttStreamSettings,
} from '../stt/SpeechToText';
import { AudioTimeline } from './AudioTimeline';
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
  /**
   * Something the session worked around on its own that the person should know: the vendor
   * refused the jargon list, so this source transcribes without it for the rest of the meeting
   * (M3-T4b). CaptureService shows it as a quiet capture warning. Optional, so a session built
   * without a warning sink (a test) still runs.
   */
  onWarning?(source: AudioSource, warning: SessionWarning): void;
}

/** A warning the session raises (onWarning). */
export interface SessionWarning {
  kind: Extract<CaptureWarningKind, 'keyterms-rejected'>;
  /** For people: what happened and what to do. Never transcript text, never a term of the list. */
  message: string;
}

export interface CaptureSessionOptions {
  meetingId: string;
  /** Epoch ms of the meeting start; all offsets are relative to it. */
  meetingStartedAtMs: number;
  stt: SpeechToText;
  accessToken: string;
  settings: SttStreamSettings;
  /** Start's token's price without the jargon list (StreamCredentials). */
  pricePerHourUsdWithoutKeyterms?: number | null;
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
  /**
   * USD per hour of one stream opened with no jargon list (the token's
   * `price_per_hour_usd_without_keyterms`): the price of a source whose list the vendor refused,
   * since the vendor bills a stream by what it was opened with. Null or missing (an API older than
   * the field) meters such a stream at `settings.pricePerHourUsd`, which errs high, never low.
   */
  pricePerHourUsdWithoutKeyterms?: number | null;
}

/**
 * A connect's outcome (connect): the stream, or the budget's refusal of the open without the
 * jargon list, which each caller handles as it handles its own refusals.
 */
type Connected =
  | { ok: true; stream: SttStream }
  | { ok: false; refusal: Exclude<SttOpenDecision, { ok: true }>; rejection: string };

/**
 * Why both sources are suspended at once (suspendStreams): `offline` while main's network poll
 * sees the Mac offline (stt/networkStatus.ts), `asleep` while the Mac sleeps (M2-T18).
 */
export type SuspendReason = 'offline' | 'asleep';

/**
 * How far one source's vendor streams have got (M2-T6), for the echo sink's holds (M2-T14b): a mic
 * line waits until call audio's watermark passes its end, or until call audio can send no more.
 */
export interface SourceWatermark {
  /**
   * Meeting offset where the source's latest final line ends: the furthest its vendor finished.
   * Null before its first line. Never moves back: a late line of a replaced stream that ends
   * earlier leaves it where it is.
   */
  finalEndMs: number | null;
  /**
   * True once no stream of this source can still send a line for audio it already got: none is
   * open, connecting or still closing (a closing stream's last lines arrive before its close
   * settles), none holds audio for a reopen, and it is not waiting to reconnect. A stall pause, a
   * closed or failed source and sleep count; `retrying` and `offline` do not: the audio they hold
   * may still bring lines once they reopen.
   */
  closed: boolean;
}

export type WatermarkListener = (source: AudioSource, watermark: SourceWatermark) => void;

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
  /**
   * How long this stream's words took to show (M3-T6b). Per stream like the timeline, pooled per
   * source at close: a late line from a stream already replaced is timed with its own stream's
   * events, where one meter across both would count its words as already measured.
   */
  readonly latency: LatencyMeter;
  /** Set once the stream was asked to close; settles when it has. */
  closing: Promise<void> | null;
  /** Dropped with no finish sequence (the offline suspend): never asked twice. */
  terminated: boolean;
  readonly openedAtMs: number;
  /** Meeting offset where this stream's latest line ends, or null before its first (loseTail). */
  lineEndMs: number | null;
  /** Meeting offset just past the last audio this stream was sent, or null before any. */
  audioEndMs: number | null;
  /**
   * Its lost audio is counted already, and never twice: in its source's window when it died as
   * the source's stream (loseStream), or as its own tail when a finish was cut short.
   */
  lost: boolean;
  /** Its finish was cut short: its tail becomes a gap once its close settles (loseTail). */
  cutShort: GapReason | null;
  /**
   * Why its finish would fail (finishFailed): `asleep` for the sleep's finish, else `stt_failed`.
   * Stamped when the sleep retires it (suspendSource), never read from `suspended` when the finish
   * fails: macOS timers do not count sleep, so its deadline runs out after the wake has already
   * lifted the suspend, and the closed lid would read as a vendor failure (M2-T18).
   */
  finishLostAs: GapReason;
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
  /**
   * The vendor refused this source's jargon list (M3-T4b): every open of it for the rest of the
   * meeting goes without the list (streamSettings), though each fresh token carries it again.
   */
  withoutKeyterms: boolean;
  /** Meeting offset where this source's latest final line ends (SourceWatermark.finalEndMs). */
  finalEndMs: number | null;
  /** The watermark the listeners last heard, so each change is told once. */
  published: SourceWatermark;
  /** Meeting offset just past the last chunk of this source that reached the session, sent or not. */
  audioEndMs: number | null;
  /**
   * Gap accounting: this source's audio that reached main and got no line. gapStartMs decides
   * where it starts and endLoss records it as one transcript_gaps row.
   * - lostStreamFromMs: the first audio of a stream lost mid-call (it failed, or was terminated
   *   offline), which its vendor turned into lines only up to the watermark
   * - heldFromMs: the first chunk held since the source last had a stream, kept when the hold's
   *   bound drops that chunk: a dropped chunk never reaches a vendor
   * - lostReason: why, the first cause since the source last had a stream; none for a hold that
   *   overflowed while an ordinary reopen connected, which counts as `stt_failed`
   */
  lostStreamFromMs: number | null;
  heldFromMs: number | null;
  lostReason: GapReason | null;
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
 * gap; and a word edge the vendor puts just across a gap is cut back to it (meetingSpan), or the
 * line would stretch over the whole gap.
 *
 * A stream the vendor ends mid-call (an error, a close, AssemblyAI's 3-hour cap, a socket the core
 * found dead) reopens the same way after a backoff that doubles per failure in a row. Every open,
 * Start's two included, passes the shared SttOpenBudget first; when it says no, the source waits
 * for the minute to pass or, with the meeting's opens spent, stays closed with an error saying
 * why. Nothing reopens without audio.
 *
 * A connect the vendor refuses over the jargon list is opened once more without it, through the
 * budget, and that source goes without the list until Stop (connect): a call without the list
 * loses a few names, a refused Start loses the meeting.
 *
 * The Mac going offline or to sleep suspends both sources at once (suspendStreams, M2-T6): offline
 * terminates each socket, asleep finishes and closes it, and either way audio is held as for a
 * pause, and no token is fetched and nothing opens until resumeStreams() has lifted every reason.
 *
 * Audio that reached main and got no line (its stream failed or went offline, the budget refused
 * the reopen, the hold overflowed) becomes a transcript_gaps row, from the source's watermark to
 * the first audio its next stream carries, for M2-T16 to re-run from the audio backup; a window
 * with no audio at all (a stall) is only a capture event. A stream asked to finish (a pause, a
 * closed source, the sleep, Stop) whose finish never completes (cut short offline, or a vendor
 * that never sent its last lines) loses its tail, from its own latest line to its last audio: one
 * row too, since the source has moved on and nothing else would count it. Capture events record
 * every pause, failure, suspend and reopen for the capture report, and each source's watermark,
 * the end of its latest line, is published for the echo sink (onWatermark).
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
  /** Every stream's latency meter, closed ones too, by source: close() logs them pooled. */
  private readonly latencyMeters: Record<AudioSource, LatencyMeter[]> = { mic: [], system: [] };
  /** The suspend reasons in force, each with the clock time it began (suspendStreams). */
  private readonly suspended = new Map<SuspendReason, number>();
  private readonly watermarkListeners = new Set<WatermarkListener>();
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
   * minute on a free account, and each Start opens two); a refusal throws before any socket. A
   * source whose jargon list the vendor refuses takes one more, right before its open without the
   * list (connect), so a Start can take four, and a refusal of that one fails the Start too.
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
    // Every chunk, sent or not: the end of a gap that lasts until Stop (endLoss).
    link.audioEndMs = this.meetingOffset(capturedAtMs + this.chunkMs(pcm));
    switch (link.state) {
      case 'open':
        if (link.current !== null) this.send(link.current, pcm, capturedAtMs);
        return;
      case 'connecting':
      case 'offline':
        // Offline: no token and no open until the network is back; resumeStreams makes it paused.
        this.hold(source, pcm, capturedAtMs);
        return;
      case 'paused':
      case 'retrying':
        this.hold(source, pcm, capturedAtMs);
        // The one place a source with no session decides to reopen: never while a suspend holds
        // (offline, asleep), nor before its backoff or the budget's minute has passed. M3-T20 (wave
        // 6) adds its silence gate to this one condition, so a source the gate closed reopens only
        // on speech, after resumeStreams() and the wake too (resumeStreams leaves every source
        // paused for that reason). A copy of the decision anywhere else would reopen a gated source.
        if (this.suspended.size === 0 && this.clock() >= link.notBeforeMs) {
          this.startReopen(source);
        }
        return;
      case 'closed':
      case 'error':
        // No session for this source and none coming: a failed source never reopens itself. Once it
        // gave up mid-call (giveUp), what arrives still counts in its gap, up to Stop.
        return;
    }
  }

  /**
   * Suspends both sources' speech-to-text at once (M2-T6): `offline` when main's network poll sees
   * the Mac offline, `asleep` when it goes to sleep (M2-T18). Offline terminates each socket, with
   * no finish sequence (the network is gone: a finish could only wait out its deadline while a
   * half-open socket may still bill), and what its vendor had not turned into lines becomes a gap;
   * asleep finishes and closes each stream, its last lines saved, unless the finish never completes
   * (sockets do not survive sleep), which leaves that stream's tail a gap (finishCutShort): an
   * `asleep` one when its deadline runs out on wake (finishLostAs), an `offline` one when going
   * offline cuts it short first, as offline outranks asleep in hold. Either way audio is held as for
   * a paused source (the newest reopenBufferMs), and no token is fetched and nothing opens until
   * resumeStreams() has lifted every reason: offline and asleep stack. A closed or failed source
   * stays as it is.
   */
  suspendStreams(reason: SuspendReason): void {
    if (this.closing || this.suspended.has(reason)) return;
    this.suspended.set(reason, this.clock());
    this.options.logger.info('speech-to-text suspended', { reason });
    this.recordEvent(null, 'stt-suspended', { reason });
    for (const source of AUDIO_SOURCES) this.suspendSource(source, reason);
    if (reason === 'offline') {
      // Streams still finishing (a pause, a closed source, the sleep's finish) would wait out their
      // finish deadline on a network that is gone: drop them too. A finish cut short never brings
      // its last lines, so each one's tail is a gap; the streams just terminated above were counted
      // already. A stream whose vendor had finished and only its close was still on the way is
      // counted too: a few seconds of silence for M2-T16 to re-run, never lost speech.
      for (const handle of this.handles) {
        this.finishCutShort(handle, 'offline');
        void this.retire(handle, 'terminate');
      }
    }
  }

  /**
   * Lifts one reason suspendStreams set. Once none is left, every suspended source is `paused`
   * with no backoff wait, and reopens with its next chunk through the open budget, as after a
   * stall: whether and when it reopens is then decided where a paused source's always is
   * (pushAudio), which is how M3-T20 keeps a gated source shut until speech.
   */
  resumeStreams(reason: SuspendReason): void {
    const since = this.suspended.get(reason);
    if (this.closing || since === undefined) return;
    this.suspended.delete(reason);
    const suspendedForMs = this.clock() - since;
    this.options.logger.info('speech-to-text resumed', { reason, suspendedForMs });
    this.recordEvent(null, 'stt-resumed', { reason, suspendedForMs });
    for (const source of AUDIO_SOURCES) {
      const link = this.links[source];
      // While suspended a source is offline or paused, or closed or failed for good.
      if (link.state !== 'offline' && link.state !== 'paused') continue;
      if (this.suspended.size > 0) {
        this.showSuspended(source);
      } else {
        link.notBeforeMs = 0;
        this.setState(source, 'paused', 'reconnects with its next audio');
      }
    }
  }

  /** The source's watermark now (SourceWatermark). */
  watermark(source: AudioSource): SourceWatermark {
    const link = this.links[source];
    const closed =
      (link.state === 'paused' || link.state === 'closed' || link.state === 'error') &&
      link.held.length === 0 &&
      ![...this.handles].some((handle) => handle.source === source);
    return { finalEndMs: link.finalEndMs, closed };
  }

  /**
   * Tells `listener` each change of a source's watermark, a new line's end after the line itself
   * has gone out (onSegment). Returns a function that stops it. A listener that throws is logged
   * and never stops the session.
   */
  onWatermark(listener: WatermarkListener): () => void {
    this.watermarkListeners.add(listener);
    return () => {
      this.watermarkListeners.delete(listener);
    };
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
    // Audio held for a reopen still connecting will never be sent: lost, up to the last of it.
    this.endLoss(source, link.audioEndMs);
    this.dropHeld(link);
    const seconds = Math.round(silentForMs / 1000);
    this.options.logger.info('speech-to-text stream paused: no audio', { source, silentForMs });
    this.setState(source, 'paused', `no audio for ${seconds} s; reconnects when audio returns`);
    // A stall is a window with no audio: a capture event, never a gap.
    this.recordEvent(source, 'stt-paused', { silentForMs: Math.round(silentForMs) });
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
    this.endLoss(source, link.audioEndMs);
    this.dropHeld(link);
    if (link.state === 'closed') return;
    this.setState(source, 'closed', reason);
    this.recordEvent(source, 'stt-closed', { reason });
    if (handle !== null) {
      this.options.logger.info('speech-to-text stream closed: the source has no audio', {
        source,
        reason,
      });
      void this.retire(handle);
    }
  }

  async close(): Promise<void> {
    // A failed Start closes twice (open() itself, then CaptureService): one latency line a session.
    const firstClose = !this.closing;
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
    // Once every stream has closed and its last lines moved the watermark as far as they go:
    // audio held for a reopen, or lost with a stream that never came back, is lost up to here.
    // Before the latency line, so a summary that fails can never cost a gap row M2-T16 re-runs.
    for (const source of AUDIO_SOURCES) this.endLoss(source, this.links[source].audioEndMs);
    // Logged once every stream has closed, so the lines each close flushed are timed too. M3's exit
    // check reads this line from a real call: word display p95 for mic and for system.
    if (firstClose) {
      this.options.logger.info('stt latency', {
        mic: LatencyMeter.pool(this.latencyMeters.mic),
        system: LatencyMeter.pool(this.latencyMeters.system),
      });
    }
  }

  private async openStream(source: AudioSource): Promise<void> {
    const { accessToken, settings, pricePerHourUsdWithoutKeyterms = null } = this.options;
    const link = this.links[source];
    const attempt = (link.attempt += 1);
    this.setState(source, 'connecting', null);
    const connected = await this.connect(
      source,
      { accessToken, settings, pricePerHourUsdWithoutKeyterms },
      () => this.closing || link.attempt !== attempt,
    );
    if (!connected.ok) {
      // Start takes its opens before any socket and fails whole when refused (open()): so here.
      throw new Error(
        `${connected.rejection}; not opened again without the jargon list: ${connected.refusal.message}`,
      );
    }
    const handle = this.track(source, connected.stream);
    if (this.closing || link.attempt !== attempt) {
      // Another stream failed, or the source closed, while this one was connecting: do not leak it.
      await this.retire(handle);
      return;
    }
    this.attach(source, handle, false);
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
      const credentials = await this.options.refreshCredentials();
      if (stale()) return;
      // Taken right before the open, the only place an open happens: an adapter never opens one.
      const grant = this.options.budget.acquire();
      if (!grant.ok) {
        this.budgetRefused(source, grant);
        return;
      }
      const connected = await this.connect(source, credentials, stale);
      if (!connected.ok) {
        // Its list stays off: the open after the wait goes without it.
        this.budgetRefused(source, connected.refusal);
        return;
      }
      handle = this.track(source, connected.stream);
    } catch (error) {
      if (stale()) return;
      const reason = `could not reconnect: ${errorMessage(error)}`;
      this.options.logger.warn('speech-to-text stream did not reopen', { source, reason });
      const retryAtMs = this.scheduleRetry(source, reason, null);
      this.recordEvent(source, 'stt-failed', {
        stage: 'reopen',
        reason,
        retryInMs: this.retryInMs(retryAtMs),
      });
      return;
    }
    if (stale()) {
      // Never left open. Offline it is dropped with no finish: the network it would finish over
      // is gone.
      await this.retire(handle, this.suspended.has('offline') ? 'terminate' : 'finish');
      return;
    }
    this.attach(source, handle, true);
    this.options.logger.info('speech-to-text stream reopened', { source });
  }

  /**
   * Opens one vendor stream for `source`, its open already taken from the budget. A connect the
   * vendor refused over the jargon list (SttConnectError.keytermsRejected: the core set it with
   * the socket already closed, and never retries) is opened once more without the list, through
   * the budget like any open (M3-T4b), and the source goes without it until Stop. Once, never a
   * loop: the second open carries no list, so the core never blames one, and a source already
   * without its list is never retried. A retry anywhere else (the core, an adapter) would open a
   * billed session the budget never saw (house rule 9).
   *
   * Answers the stream, or the budget's refusal of the second open. When the second open fails,
   * the error carries both reasons. `stale` (the session closed, or the source moved on) skips the
   * second open: the first failure is rethrown, and the caller drops it as it drops any. Asked
   * before listRejected, whose warn line, capture event and warning each say the source reopens
   * without the list: after Stop nothing reopens. The list stays on, so an open that is refused
   * again later says so then.
   */
  private async connect(
    source: AudioSource,
    credentials: StreamCredentials,
    stale: () => boolean,
  ): Promise<Connected> {
    try {
      return { ok: true, stream: await this.openVendorStream(source, credentials) };
    } catch (error) {
      if (stale() || !this.listRejected(source, credentials, error)) throw error;
      const grant = this.options.budget.acquire();
      if (!grant.ok) return { ok: false, refusal: grant, rejection: errorMessage(error) };
      try {
        return { ok: true, stream: await this.openVendorStream(source, credentials) };
      } catch (retryError) {
        throw new Error(
          `${errorMessage(error)}; and without the jargon list: ${errorMessage(retryError)}`,
          { cause: retryError },
        );
      }
    }
  }

  private openVendorStream(
    source: AudioSource,
    credentials: StreamCredentials,
  ): Promise<SttStream> {
    return this.options.stt.openStream({
      accessToken: credentials.accessToken,
      settings: this.streamSettings(source, credentials),
      label: source,
    });
  }

  /**
   * What `source` opens with: the token's settings, or, once the vendor refused the list for this
   * source, the same with no list, metered at the price without the list's surcharge (the vendor
   * bills a stream by what it was opened with; StreamCredentials).
   */
  private streamSettings(source: AudioSource, credentials: StreamCredentials): SttStreamSettings {
    if (!this.links[source].withoutKeyterms) return credentials.settings;
    return {
      ...credentials.settings,
      keyterms: [],
      pricePerHourUsd:
        credentials.pricePerHourUsdWithoutKeyterms ?? credentials.settings.pricePerHourUsd,
    };
  }

  /**
   * Whether `error` is the vendor refusing the jargon list this source just sent. If so, the source
   * goes without the list from now on, and that is logged at warn with the term count (never the
   * terms: they name clients and colleagues), recorded for the capture report and raised as a
   * quiet warning. Never for a source already without its list, nor for an empty list: the open
   * without it would be the same open again.
   */
  private listRejected(
    source: AudioSource,
    credentials: StreamCredentials,
    error: unknown,
  ): boolean {
    const link = this.links[source];
    const terms = credentials.settings.keyterms?.length ?? 0;
    if (!(error instanceof SttConnectError) || !error.keytermsRejected) return false;
    if (link.withoutKeyterms || terms === 0) return false;
    link.withoutKeyterms = true;
    this.options.logger.warn('speech-to-text jargon list rejected: reopening without it', {
      source,
      terms,
    });
    this.recordEvent(source, 'stt-keyterms-rejected', { terms });
    this.options.listeners.onWarning?.(source, {
      kind: 'keyterms-rejected',
      message: `Jargon list rejected by ${this.options.stt.vendorName}, transcribing without it. Check the list in Settings.`,
    });
    return true;
  }

  /**
   * After a failure: reopen with the next chunk once the backoff has passed, unless the meeting's
   * opens are spent. A vendor that fails on every open would otherwise reopen, and bill a
   * handshake, as fast as chunks arrive (ten a second). Returns when it may reopen, or null when
   * it gave up.
   */
  private scheduleRetry(
    source: AudioSource,
    reason: string,
    openedForMs: number | null,
  ): number | null {
    const link = this.links[source];
    link.lostReason ??= 'stt_failed';
    link.failures =
      openedForMs !== null && openedForMs >= HEALTHY_STREAM_MS ? 1 : link.failures + 1;
    const budget = this.options.budget.check();
    if (!budget.ok && budget.kind === 'per-meeting') {
      this.giveUp(source, `${reason}; not reconnecting: ${budget.message}`);
      return null;
    }
    const { reopenBackoffMs, reopenBackoffMaxMs } = this.options;
    const waitMs = Math.min(reopenBackoffMaxMs, reopenBackoffMs * 2 ** (link.failures - 1));
    link.notBeforeMs = this.clock() + waitMs;
    this.setState(source, 'retrying', reason);
    this.options.listeners.onStreamFailure(source, reason, link.notBeforeMs);
    return link.notBeforeMs;
  }

  /** The budget said no to a reopen: wait for the minute to pass, or stop for this meeting. */
  private budgetRefused(
    source: AudioSource,
    decision: Exclude<SttOpenDecision, { ok: true }>,
  ): void {
    const link = this.links[source];
    link.lostReason ??= 'budget';
    this.options.logger.warn('speech-to-text reopen refused by the open budget', {
      source,
      limit: decision.kind,
    });
    this.recordEvent(source, 'stt-budget-refused', {
      limit: decision.kind,
      retryInMs: this.retryInMs(decision.kind === 'per-minute' ? decision.retryAtMs : null),
    });
    if (decision.kind === 'per-meeting') {
      this.giveUp(source, `not reconnecting: ${decision.message}`);
      return;
    }
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
  private attach(source: AudioSource, handle: StreamHandle, reopened: boolean): void {
    const link = this.links[source];
    link.current = handle;
    const held = link.held;
    // Audio lost while the source had no stream ends where this one's begins: its first held chunk
    // (T5's timeline dates it). A reconnect that lost nothing held from that very chunk: no row.
    const first = held[0];
    this.endLoss(
      source,
      first === undefined ? link.audioEndMs : this.meetingOffset(first.capturedAtMs),
    );
    this.setState(source, 'open', null);
    if (link.heldDropped > 0) {
      this.options.logger.warn('audio dropped while reconnecting', {
        source,
        chunks: link.heldDropped,
      });
    }
    if (reopened) {
      this.recordEvent(source, 'stt-reopened', {
        heldMs: Math.round(link.heldMs),
        droppedChunks: link.heldDropped,
      });
    }
    this.dropHeld(link);
    // Handed over at once, sent at 1x: AssemblyAI takes no audio faster than real time (3007), so
    // the core paces held audio (SttConnection.pump), and it adds its own length of lag to this
    // session until it closes. Past the held audio nothing is replayed inline: that window is a
    // gap (endLoss above), for M2-T16 to re-run from the backup.
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
  private hold(source: AudioSource, pcm: Uint8Array, capturedAtMs: number): void {
    const link = this.links[source];
    // Kept when the bound below drops this chunk: a dropped chunk never reaches a vendor (endLoss).
    link.heldFromMs ??= this.meetingOffset(capturedAtMs);
    // Held because the Mac is offline or asleep: if any of it is lost, that is why. Asleep, it is
    // lost when a Stop at wake comes first (PowerCoordinator) or the hold overflows; left
    // unnamed it read as `stt_failed`, a vendor failure that never happened (M2-T18).
    if (this.suspended.has('offline')) link.lostReason ??= 'offline';
    else if (this.suspended.has('asleep')) link.lostReason ??= 'asleep';
    link.held.push({ pcm, capturedAtMs });
    link.heldMs += this.chunkMs(pcm);
    while (link.heldMs > this.options.reopenBufferMs && link.held.length > 1) {
      const oldest = link.held.shift();
      if (oldest === undefined) break;
      link.heldMs -= this.chunkMs(oldest.pcm);
      link.heldDropped += 1;
    }
    this.publishWatermark(source);
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
      // Its events come already dated as meeting offsets (measureLatency), so its clock is the
      // meeting's.
      latency: new LatencyMeter((meetingMs) => this.options.meetingStartedAtMs + meetingMs),
      closing: null,
      terminated: false,
      openedAtMs: this.clock(),
      lineEndMs: null,
      audioEndMs: null,
      lost: false,
      cutShort: null,
      finishLostAs: 'stt_failed',
    };
    this.handles.add(handle);
    this.latencyMeters[source].push(handle.latency);
    stream.on((event) => {
      this.handleEvent(source, handle, event);
    });
    return handle;
  }

  /**
   * Asks the stream to close (idempotent); the handle is forgotten once it has. `terminate` drops
   * it with no finish sequence (the offline suspend), and also cuts short a finish asked for
   * before, whose tail the caller counts (finishCutShort); a stream with no socket to drop (the
   * fake) closes as usual.
   */
  private retire(handle: StreamHandle, how: 'finish' | 'terminate' = 'finish'): Promise<void> {
    let dropping: Promise<void> | undefined;
    if (how === 'terminate' && !handle.terminated) {
      handle.terminated = true;
      dropping = handle.stream.terminate?.();
    }
    if (handle.closing === null) {
      handle.closing = (dropping ?? handle.stream.close())
        .catch((error: unknown) => {
          this.options.logger.warn('stream close failed', { error: errorMessage(error) });
        })
        .finally(() => {
          this.handles.delete(handle);
          // Every line it will ever send is in: its tail starts after the last of them.
          if (handle.cutShort !== null) this.loseTail(handle, handle.cutShort);
          // Stop meters every stream at once itself; mid-meeting closes are metered one by one.
          if (!this.closing) this.options.listeners.onStreamClosed(handle.source);
          // Its last lines are in: the source may have nothing left that could send one.
          this.publishWatermark(handle.source);
        });
    } else if (dropping !== undefined) {
      void dropping.catch((error: unknown) => {
        this.options.logger.warn('stream terminate failed', { error: errorMessage(error) });
      });
    }
    return handle.closing;
  }

  private send(handle: StreamHandle, pcm: Uint8Array, capturedAtMs: number): void {
    // The timeline counts the vendor's clock in the samples sent here, so adapters must hand the
    // vendor every byte, in order (AssemblyAI regroups them; see SttConnection.sendFrame).
    const run = handle.timeline.append(capturedAtMs, pcm.byteLength / SAMPLE_BYTES);
    handle.audioEndMs = this.meetingOffset(capturedAtMs + this.chunkMs(pcm));
    if (run !== null && run.jumpMs !== null) {
      this.options.logger.info('audio timeline: new run', {
        source: handle.source,
        jumpMs: Math.round(run.jumpMs),
        runs: handle.timeline.runs.length,
      });
    }
    handle.stream.send(pcm);
  }

  /**
   * A span on one stream's own clock (the vendor's: ms from the first byte it was sent) as meeting
   * offsets, through the runs of audio that hold it. Always the span, never its two edges one at a
   * time: only AudioTimeline.toCapturedSpan cuts a vendor's spill across a run boundary, and an edge
   * mapped alone lands on the far side of the gap. See meetingOffset for the units.
   */
  private meetingSpan(
    handle: StreamHandle,
    span: { startMs: number; endMs: number },
  ): { startMs: number; endMs: number } {
    const { meetingStartedAtMs } = this.options;
    // No audio sent yet, so no run to map through: a vendor sends no line before it heard any, and
    // the landed rule (the stream's offset 0) stands in if one ever does.
    const captured = handle.timeline.toCapturedSpan(span.startMs, span.endMs) ?? {
      startMs: meetingStartedAtMs + span.startMs,
      endMs: meetingStartedAtMs + span.endMs,
    };
    const startMs = this.meetingOffset(captured.startMs);
    // A run that starts earlier than its predecessor predicted (the wall clock was set back) would
    // date the end of a span across it before its start, which the API refuses (end_ms >= start_ms).
    return { startMs, endMs: Math.max(startMs, this.meetingOffset(captured.endMs)) };
  }

  /**
   * A final's span as meeting offsets, widened to hold its words (already meeting offsets). The
   * line and each word are cut at a run boundary on their own evidence, so they can disagree: a
   * line whose first 100 ms sit before a stall reads them as spill and starts after it, while a
   * whole word in those 100 ms is real audio from before it. The word wins, and the line keeps it:
   * EchoFilter reaches call-audio lines by their spans, trusting every word to lie inside its line
   * ("Words lie inside their own line's span"), so a word outside it would go unmatched and its
   * echo on the mic would be kept.
   */
  private lineSpan(
    handle: StreamHandle,
    line: { startMs: number; endMs: number },
    words: readonly { startMs: number; endMs: number }[],
  ): { startMs: number; endMs: number } {
    const span = this.meetingSpan(handle, line);
    return {
      startMs: Math.min(span.startMs, ...words.map((word) => word.startMs)),
      endMs: Math.max(span.endMs, ...words.map((word) => word.endMs)),
    };
  }

  /**
   * A capture time (wall clock) as ms from the meeting start. Whole ms: the renderer's capture
   * times are fractional (performance.now) and the API's offsets are integers (OffsetMs), so it
   * would refuse a fraction with a 422 and the uploader would set the line aside for good. Never
   * negative (OffsetMs again): audio captured just before the start counts from 0.
   */
  private meetingOffset(capturedAtMs: number): number {
    return Math.max(0, Math.round(capturedAtMs - this.options.meetingStartedAtMs));
  }

  private setState(source: AudioSource, state: SttStreamState, message: string | null): void {
    this.links[source].state = state;
    this.options.listeners.onStreamState(source, state, message);
    this.publishWatermark(source);
  }

  /** One source's part of suspendStreams. */
  private suspendSource(source: AudioSource, reason: SuspendReason): void {
    const link = this.links[source];
    if (link.state === 'closed' || link.state === 'error') return;
    // A reopen still fetching its token or connecting is stale now: it opens nothing, or drops
    // what it opened (reopen).
    link.attempt += 1;
    const handle = link.current;
    link.current = null;
    if (handle !== null) {
      if (reason === 'offline') this.loseStream(link, handle, 'offline');
      else handle.finishLostAs = 'asleep';
      void this.retire(handle, reason === 'offline' ? 'terminate' : 'finish');
    }
    if (reason === 'offline' && link.held.length > 0) link.lostReason ??= 'offline';
    this.showSuspended(source);
  }

  /** A suspended source's state: offline while the network is gone, else paused while asleep. */
  private showSuspended(source: AudioSource): void {
    if (this.suspended.has('offline')) {
      this.setState(source, 'offline', 'the Mac is offline; reconnects when the network is back');
    } else {
      this.setState(
        source,
        'paused',
        'the Mac is asleep; reconnects with its audio after it wakes',
      );
    }
  }

  /**
   * `handle` carried the source's audio and is gone without finishing it (its vendor failed, or the
   * Mac went offline): what the vendor had not turned into lines by then is lost (gapStartMs).
   */
  private loseStream(link: SourceLink, handle: StreamHandle, reason: GapReason): void {
    handle.lost = true;
    link.lostReason ??= reason;
    const first = handle.timeline.runs[0];
    if (first === undefined) return; // it was sent no audio, so it lost none
    const fromMs = this.meetingOffset(first.capturedAtMs);
    link.lostStreamFromMs = Math.min(link.lostStreamFromMs ?? fromMs, fromMs);
  }

  /**
   * `handle` was asked to finish (a pause, a closed source, the sleep, Stop) and that finish will
   * not complete: the offline suspend cuts it short, or its vendor never sent the completion signal
   * (the core's fatal error, finishFailed). The source has moved on, so no window of its counts this
   * loss: the stream's tail becomes its own gap once its close settles (loseTail). Uncounted, a
   * sleep's finish cut short on wake lost the last seconds before the lid closed, with no row.
   */
  private finishCutShort(handle: StreamHandle, reason: GapReason): void {
    if (handle.lost) return;
    handle.lost = true;
    handle.cutShort = reason;
  }

  /**
   * A fatal error from a stream that is no longer the source's (or arrives during Stop): its
   * finish failed, and its last lines will not come. Never a reopen: the source left this stream.
   * Its tail is named for why it was finishing (finishLostAs): a sleep's, for the sleep.
   */
  private finishFailed(source: AudioSource, handle: StreamHandle, reason: string): void {
    if (handle.lost) return;
    this.finishCutShort(handle, handle.finishLostAs);
    this.recordEvent(source, 'stt-failed', { stage: 'finish', reason });
  }

  /**
   * A stream's cut-short tail as one gap: from its own latest line to the end of the audio it was
   * sent. Its own line, not the source's watermark: a newer stream's lines lie past this tail and
   * would hide it.
   */
  private loseTail(handle: StreamHandle, reason: GapReason): void {
    const first = handle.timeline.runs[0];
    if (first === undefined) return; // it was sent no audio, so it lost none
    const startMs = this.gapStartMs([this.meetingOffset(first.capturedAtMs)], handle.lineEndMs);
    this.recordGap(handle.source, startMs, handle.audioEndMs, reason);
  }

  /**
   * Where a gap starts (a meeting offset), or null when nothing is lost: the earliest of `fromMs`
   * (a lost stream's first audio, the first chunk held since), never before `watermarkMs` (audio up
   * to the end of a line got its lines). endLoss asks it for a source's window, loseTail for a
   * stream's cut-short tail.
   *
   * The one place a gap's start is decided. M3-T20 (wave 6) makes it the speech onset for a source
   * its silence gate had closed: a gated window is billed silence the gate chose to drop, never a
   * gap, or M2-T16 would re-run minutes of it. A copy of this rule elsewhere would miss that change.
   */
  private gapStartMs(
    fromMs: readonly (number | null)[],
    watermarkMs: number | null,
  ): number | null {
    const candidates = fromMs.filter((ms): ms is number => ms !== null);
    if (candidates.length === 0) return null;
    const startMs = Math.min(...candidates);
    return watermarkMs === null ? startMs : Math.max(startMs, watermarkMs);
  }

  /**
   * The source's lost audio, if any, ends at `untilMs` (a meeting offset): one transcript_gaps row
   * for M2-T16 to re-run from the audio backup. The count then starts afresh.
   */
  private endLoss(source: AudioSource, untilMs: number | null): void {
    const link = this.links[source];
    const startMs = this.gapStartMs([link.lostStreamFromMs, link.heldFromMs], link.finalEndMs);
    const reason = link.lostReason ?? 'stt_failed';
    link.lostStreamFromMs = null;
    link.heldFromMs = null;
    link.lostReason = null;
    this.recordGap(source, startMs, untilMs, reason);
  }

  /** One transcript_gaps row, when the window holds any audio: never one that ends at its start. */
  private recordGap(
    source: AudioSource,
    startMs: number | null,
    untilMs: number | null,
    reason: GapReason,
  ): void {
    if (startMs === null || untilMs === null || untilMs <= startMs) return;
    const createdAt = new Date(this.clock()).toISOString();
    const gap = { meetingId: this.meetingId, source, startMs, endMs: untilMs, reason };
    try {
      this.options.store.addGap({ id: randomUUID(), createdAt, ...gap });
      this.options.logger.info('speech-to-text gap recorded', gap);
    } catch (error) {
      // Not thrown on: the session must go on. Without the row this window is never re-run.
      this.options.logger.error('speech-to-text gap not saved', {
        ...gap,
        error: errorMessage(error),
      });
    }
  }

  /** A capture event for the meeting's capture report: codes, counts and timings, never text. */
  private recordEvent(source: AudioSource | null, kind: string, detail: JsonObject): void {
    const now = this.clock();
    try {
      this.options.store.addCaptureEvent({
        meetingId: this.meetingId,
        at: new Date(now).toISOString(),
        offsetMs: this.meetingOffset(now),
        source,
        kind,
        detail,
      });
    } catch (error) {
      this.options.logger.error('capture event not saved', {
        meetingId: this.meetingId,
        kind,
        error: errorMessage(error),
      });
    }
  }

  private retryInMs(retryAtMs: number | null): number | null {
    return retryAtMs === null ? null : Math.max(0, retryAtMs - this.clock());
  }

  /** Tells the listeners when the source's watermark changed (onWatermark). */
  private publishWatermark(source: AudioSource): void {
    const link = this.links[source];
    const next = this.watermark(source);
    if (next.finalEndMs === link.published.finalEndMs && next.closed === link.published.closed) {
      return;
    }
    link.published = next;
    for (const listener of [...this.watermarkListeners]) {
      try {
        listener(source, { ...next });
      } catch (error) {
        this.options.logger.error('watermark listener failed', {
          source,
          error: errorMessage(error),
        });
      }
    }
  }

  private handleEvent(source: AudioSource, handle: StreamHandle, event: SttEvent): void {
    const { listeners, logger } = this.options;
    switch (event.type) {
      case 'final': {
        const words = event.words.map((word) => ({ ...word, ...this.meetingSpan(handle, word) }));
        const segment: TranscriptSegment = {
          id: randomUUID(),
          meetingId: this.meetingId,
          source,
          speaker: SPEAKER_FOR_SOURCE[source],
          ...this.lineSpan(handle, event, words),
          text: event.text,
          confidence: event.confidence,
          words,
          createdAt: new Date(this.clock()).toISOString(),
        };
        const link = this.links[source];
        link.finalEndMs = Math.max(link.finalEndMs ?? segment.endMs, segment.endMs);
        handle.lineEndMs = Math.max(handle.lineEndMs ?? segment.endMs, segment.endMs);
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
        // After the line went out: the echo sink sees a call-audio line before the watermark that
        // passes it, or it could release a mic line whose twin this very line is (M2-T14b).
        this.publishWatermark(source);
        // Last: a meter that throws must cost neither the line nor the watermark (measureLatency).
        this.measureLatency(handle, {
          ...event,
          startMs: segment.startMs,
          endMs: segment.endMs,
          words,
        });
        return;
      }
      case 'interim': {
        const span = this.meetingSpan(handle, event);
        listeners.onInterim({ meetingId: this.meetingId, source, text: event.text, ...span });
        this.measureLatency(handle, { ...event, ...span });
        return;
      }
      case 'error':
        logger.error('speech-to-text error', {
          source,
          message: event.message,
          fatal: event.fatal,
        });
        if (!event.fatal) return;
        if (!this.closing && this.links[source].current === handle) {
          this.streamFailed(source, handle, event.message);
        } else {
          // Asked to finish already: the core reports a finish that never completed (SttConnection).
          this.finishFailed(source, handle, event.message);
        }
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
   * One meter call per transcript event (M3-T6b), with the event dated as the transcript dates it:
   * meeting offsets, through the stream's timeline and its span cut (meetingSpan, lineSpan). Never
   * give the meter the vendor's own times with the timeline's toCapturedAtMs as its clock instead:
   * it maps a word's end alone, so a word the vendor ends just past a stall would be timed from the
   * far side of the gap, its wait read short by the whole stall while its line is dated before it.
   * LatencyMeter's CaptureClock doc says the same for any new meter.
   *
   * Called after the line is saved and shown and its watermark published, never before: the meter
   * throws a RangeError on a time that is not a number (the adapters' parsers already drop those),
   * which SttConnection.deliver reports as "stt listener failed", and that must never cost a line
   * (house rule 1), nor the watermark the echo sink waits on (M2-T14b).
   */
  private measureLatency(handle: StreamHandle, event: SttEvent): void {
    handle.latency.record(event, this.clock());
  }

  /**
   * The source's current stream died mid-call. A stream we asked to close (Stop, a failed source)
   * is no longer current, so its "closed" is not a failure (its fatal error is: finishFailed). The
   * dead stream is closed too: the core closes itself after a fatal error, but a stream that only
   * reported one must not stay open.
   */
  private streamFailed(source: AudioSource, handle: StreamHandle, reason: string): void {
    const link = this.links[source];
    if (this.closing || link.current !== handle) return;
    link.current = null;
    link.attempt += 1;
    this.loseStream(link, handle, 'stt_failed');
    void this.retire(handle);
    const retryAtMs = this.scheduleRetry(source, reason, this.clock() - handle.openedAtMs);
    this.recordEvent(source, 'stt-failed', {
      stage: 'stream',
      reason,
      retryInMs: this.retryInMs(retryAtMs),
    });
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
    withoutKeyterms: false,
    finalEndMs: null,
    // Before Start a source has no stream and holds nothing: watermark() reads it as closed.
    published: { finalEndMs: null, closed: true },
    audioEndMs: null,
    lostStreamFromMs: null,
    heldFromMs: null,
    lostReason: null,
  };
}

function describeClose(code: number | null, reason: string | null): string {
  if (code === null && reason === null) return 'no close code';
  return [code === null ? null : `code ${code}`, reason]
    .filter((part) => part !== null && part !== '')
    .join(': ');
}
