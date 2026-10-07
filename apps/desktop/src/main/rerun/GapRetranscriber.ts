import { randomUUID } from 'node:crypto';
import type { CapturePhase, CaptureStatus, RerunStatus } from '../../shared/capture';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import { SPEAKER_FOR_SOURCE, type TranscriptSegment } from '../../shared/transcript';
import { AudioTimeline } from '../capture/AudioTimeline';
import type { RecordingEnded, StatusContributor } from '../capture/CaptureService';
import type { EchoSink } from '../capture/echo/EchoSink';
import type { SttOpenBudget } from '../capture/SttOpenBudget';
import { errorMessage, type Logger } from '../logger';
import type { TranscriptGap, TranscriptStore } from '../store/TranscriptStore';
import type { SpeechToTextFactory } from '../stt/createSpeechToText';
import {
  SttConnectError,
  type SpeechToText,
  type SttStream,
  type SttStreamSettings,
} from '../stt/SpeechToText';
import { recordCrashTails } from './crashTails';
import { type GapAudioPiece, type GapAudioReader, heldMs } from './gapAudio';
import { mapFinal, missingPart, type RerunFinal } from './rerunLines';
import type { RerunCredentials } from './rerunStt';
import { addRerunUsage } from './rerunUsage';

/** Audio streamed on each side of a gap (M2 design, "Gap re-run"): context for its edge words. */
export const RERUN_PAD_MS = 1_000;

/** The re-run sends its audio in chunks of this length, one per chunk's worth of real time. */
const CHUNK_MS = 100;
const BYTES_PER_MS = (PCM_SAMPLE_RATE / 1_000) * 2;
const CHUNK_BYTES = CHUNK_MS * BYTES_PER_MS;

/** Opens a Start takes at once (both sources): what a re-run leaves free in the minute window. */
const START_OPENS = 2;

/** The vendor's window (SttOpenBudget): the longest a refused open can wait. */
const MINUTE_MS = 60_000;

/** CaptureService, as far as the re-run follows it (its seams, M2-T4). */
export interface RerunCapture {
  /** Read before every open: none starts unless capture is idle. */
  readonly phase: CapturePhase;
  /** Every status: a phase other than idle stops the re-run, idle lets it go on. */
  on(event: 'status', listener: (status: CaptureStatus) => void): () => void;
  onRecording(listener: { ended?(recording: RecordingEnded): void }): () => void;
  addStatusContributor(name: string, read: StatusContributor): () => void;
  refreshStatus(): void;
}

export interface GapRetranscriberOptions {
  store: TranscriptStore;
  capture: RerunCapture;
  /** The one budget createCaptureRuntime.ts shares with CaptureService (house rule 9). */
  budget: Pick<SttOpenBudget, 'check' | 'acquire'>;
  /** config costGuards.sttOpensPerMinute: how much of the minute a re-run may take (START_OPENS). */
  opensPerMinute: number;
  /** A fresh token per session (rerunStt.ts). */
  credentials: () => Promise<RerunCredentials>;
  /** A fresh adapter per session, so its usage() is that session's alone. */
  createSpeechToText: SpeechToTextFactory;
  audio: Pick<GapAudioReader, 'read'>;
  echo: Pick<EchoSink, 'filterStored'>;
  /** A gap of this meeting was filled: its backup status reads again (AudioBackup.refresh). */
  onRecovered: (meetingId: string) => void;
  logger: Logger;
  /** Wall clock (epoch ms): the budget's, and the stored instants. */
  clock?: () => number;
  /** Monotonic ms for the pace: never the wall clock (AudioPacer says why). */
  paceClock?: () => number;
  /** Waits `ms`, or less once `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type GapOutcome = 'recovered' | 'failed' | 'interrupted';

/** What one vendor session heard. */
interface Heard {
  /** On the stream's own clock. */
  finals: RerunFinal[];
  fatal: string | null;
  closed: boolean;
}

interface Session {
  /** Meeting offsets. */
  finals: RerunFinal[];
  interrupted: boolean;
  /** Why the gap is not filled; null when the session heard all of it. */
  error: string | null;
}

type Opened =
  | { kind: 'open'; stt: SpeechToText; stream: SttStream; provider: string }
  | { kind: 'interrupted' }
  | { kind: 'failed'; error: string };

/**
 * The gap re-run (M2-T16, M2 design "Gap re-run"): audio that reached main but not the vendor (a
 * failure, offline, a budget wait, a sleep, a crash: `transcript_gaps`) is streamed again from the
 * local backup, each gap with RERUN_PAD_MS either side, through a fresh session of the vendor the
 * API names now, at real time. Words the stored lines already hold are dropped (missingPart), mic
 * lines go through the echo filter against the call audio stored by then (EchoSink.filterStored),
 * and the rest is stored with `origin = 'rerun'`, which the uploader sends like any line. A gap
 * is marked recovered, or keeps why not (`recover_error`), and stays for the next try.
 *
 * When: at launch (after the crash tails are recorded, recordCrashTails), after every Stop, and on
 * demand (`capture:rerun-gaps`). Never while capture is anything but idle: a Start mid-session
 * ends that session at once (its gap stays as it was) and the meeting waits for the next idle.
 * One meeting at a time, one session at a time.
 *
 * The open budget (house rule 9; SttOpenBudget names this caller): every session takes a slot in
 * the per-minute window right before `openStream` (`acquire(1, 'minute')`), never the meeting's
 * allowance, which after Stop still holds the last meeting's opens (the meeting with gaps is the
 * one whose failures spent it). It waits while the minute could not also take a Start's two opens
 * (START_OPENS): Stop, then Start of the next call within the minute is the common case, and a
 * re-run that filled the window would refuse that Start. Its usage is added to the meeting's
 * `stt_usage` row: the vendor bills it.
 */
export class GapRetranscriber {
  private readonly clock: () => number;
  private readonly paceClock: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Room a re-run leaves in the minute window for a Start (see the class comment). */
  private readonly reserve: number;
  /** Meetings to re-run, in order; the first is the one running. */
  private readonly queue: string[] = [];
  /** Each on-demand caller waiting for its meeting's run to end. */
  private readonly waiters = new Map<string, (() => void)[]>();
  private worker: Promise<void> | null = null;
  /** Aborts the run in progress: a Start, or quit. */
  private running: AbortController | null = null;
  private progress: RerunStatus | null = null;
  private stopped = false;

  constructor(private readonly options: GapRetranscriberOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.paceClock = options.paceClock ?? (() => performance.now());
    this.sleep = options.sleep ?? sleepUnlessAborted;
    // Never all of it: with a minute of one or two opens the re-run would wait for good.
    this.reserve = Math.max(0, Math.min(START_OPENS, options.opensPerMinute - 1));
  }

  /**
   * At launch, once AudioBackup.start() has repaired the WAVs a crash left open: records the crash
   * tails, queues every meeting with an unrecovered gap and audio left to re-run it from, and
   * follows capture from here on. A store failure here is logged; the runtime still starts.
   */
  start(): void {
    const { capture, store, logger } = this.options;
    capture.addStatusContributor('rerun', () =>
      this.progress === null ? {} : { rerun: { ...this.progress } },
    );
    capture.on('status', (status) => {
      if (status.phase === 'idle') this.kick();
      else this.running?.abort();
    });
    capture.onRecording({
      ended: ({ meetingId, discarded, stopFailed }) => {
        // A failed Stop may have left the meeting open: the next launch ends it, and re-runs it.
        if (!discarded && !stopFailed) this.enqueue(meetingId);
      },
    });
    try {
      const tails = recordCrashTails(store, this.now());
      if (tails > 0) logger.info('gap re-run: crash tails recorded as gaps', { gaps: tails });
      const withAudio = new Set(store.listMeetingIdsWithAudio());
      for (const gap of store.listUnrecoveredGaps()) {
        if (withAudio.has(gap.meetingId)) this.enqueue(gap.meetingId);
      }
    } catch (error) {
      logger.error(
        'gap re-run: the launch check failed; gaps wait for a Stop or a re-run asked for',
        {
          error: errorMessage(error),
        },
      );
    }
    this.kick();
  }

  /**
   * `capture:rerun-gaps`: re-runs the meeting's unrecovered gaps next, and resolves once its run
   * has ended (filled, given up with a reason, or cut short by a Start). Refused while capture is
   * not idle, for a meeting that has not ended, and at quit.
   */
  async rerunMeeting(meetingId: string): Promise<void> {
    if (this.stopped) throw new Error('Roger is quitting: gaps are re-run at the next launch.');
    if (this.options.capture.phase !== 'idle') {
      throw new Error('Roger is recording: gaps are re-run once the recording stops.');
    }
    if (this.options.store.getMeeting(meetingId)?.endedAt == null) {
      throw new Error(`Meeting ${meetingId} has not ended: its gaps are re-run once it has.`);
    }
    const done = new Promise<void>((resolve) => {
      this.waiters.set(meetingId, [...(this.waiters.get(meetingId) ?? []), resolve]);
    });
    this.enqueue(meetingId, 'next');
    this.kick();
    await done;
  }

  /** At quit: ends the session under way, then takes no more. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.running?.abort();
    await this.worker;
    for (const meetingId of [...this.waiters.keys()]) this.release(meetingId);
  }

  /** Resolves once no re-run is under way (tests). */
  async idle(): Promise<void> {
    while (this.worker !== null) await this.worker;
  }

  /** `next`: after the run under way (an on-demand ask goes before the launch's backlog). */
  private enqueue(meetingId: string, where: 'last' | 'next' = 'last'): void {
    const at = this.queue.indexOf(meetingId);
    const running = this.worker !== null;
    if (at === 0 && running) return;
    if (where === 'last' && at !== -1) return;
    if (at !== -1) this.queue.splice(at, 1);
    if (where === 'last') this.queue.push(meetingId);
    else this.queue.splice(running ? 1 : 0, 0, meetingId);
  }

  private kick(): void {
    if (this.worker !== null || this.stopped || this.queue.length === 0) return;
    if (this.options.capture.phase !== 'idle') return;
    this.worker = this.drain().finally(() => {
      this.worker = null;
      this.kick();
    });
  }

  /** Never rejects: a meeting whose run throws is logged and left for the next launch. */
  private async drain(): Promise<void> {
    const { capture, logger } = this.options;
    while (!this.stopped && capture.phase === 'idle') {
      const meetingId = this.queue[0];
      if (meetingId === undefined) return;
      const controller = new AbortController();
      this.running = controller;
      let interrupted = false;
      try {
        interrupted = !(await this.runMeeting(meetingId, controller.signal));
      } catch (error) {
        logger.error('gap re-run failed for a meeting', { meetingId, error: errorMessage(error) });
      } finally {
        this.running = null;
        this.setProgress(null);
      }
      // Cut short: it stays first in line for the next idle, and whoever asked hears now.
      if (!interrupted) this.queue.splice(this.queue.indexOf(meetingId), 1);
      this.release(meetingId);
      if (interrupted) return;
    }
  }

  private release(meetingId: string): void {
    const waiting = this.waiters.get(meetingId) ?? [];
    this.waiters.delete(meetingId);
    for (const resolve of waiting) resolve();
  }

  /** Re-runs one meeting's unrecovered gaps. False when a Start or quit cut it short. */
  private async runMeeting(meetingId: string, signal: AbortSignal): Promise<boolean> {
    const { store } = this.options;
    // Open: being recorded, or left open for M2-T23's resume. Its gaps wait for its end.
    if (store.getMeeting(meetingId)?.endedAt == null) return true;
    const gaps = store.listUnrecoveredGaps(meetingId);
    if (gaps.length === 0) return true;
    // Call audio first: a re-run mic line is checked against the call-audio lines stored by then
    // (EchoSink.filterStored), and an outage cuts both sources, so its call-audio twin is one of
    // these. Mic first would keep the echo of every such window.
    const ordered = [
      ...gaps.filter((gap) => gap.source === 'system'),
      ...gaps.filter((gap) => gap.source === 'mic'),
    ];
    let progress: RerunStatus = { meetingId, state: 'running', gaps: ordered.length, finished: 0 };
    this.setProgress(progress);
    let recovered = 0;
    try {
      for (const gap of ordered) {
        const outcome = await this.runGap(gap, signal);
        if (outcome === 'interrupted') return false;
        if (outcome === 'recovered') recovered += 1;
        progress = { ...progress, state: 'running', finished: progress.finished + 1 };
        this.setProgress(progress);
      }
      return true;
    } finally {
      if (recovered > 0) this.recovered(meetingId);
    }
  }

  private async runGap(gap: TranscriptGap, signal: AbortSignal): Promise<GapOutcome> {
    const fromMs = Math.max(0, gap.startMs - RERUN_PAD_MS);
    const toMs = gap.endMs + RERUN_PAD_MS;
    let pieces: GapAudioPiece[];
    try {
      pieces = await this.options.audio.read(gap.meetingId, gap.source, fromMs, toMs, signal);
    } catch (error) {
      if (this.interrupted(signal)) return 'interrupted';
      return this.fail(
        gap,
        `Roger could not read this part of the call from its audio backup: ${errorMessage(error)}`,
      );
    }
    if (this.interrupted(signal)) return 'interrupted';
    const held = heldMs(pieces, gap.startMs, gap.endMs);
    if (held === 0) {
      return this.fail(
        gap,
        'The audio backup holds none of this part of the call, so it cannot be transcribed again.',
      );
    }
    const session = await this.transcribe(gap, pieces, signal);
    let lines: number;
    try {
      // Whatever ended the session, the lines it sent are kept: a later try drops their words.
      lines = this.saveLines(gap, session.finals, fromMs, toMs);
    } catch (error) {
      return this.fail(gap, `Roger could not save the re-run's lines: ${errorMessage(error)}`);
    }
    if (session.interrupted) return 'interrupted';
    if (session.error !== null) return this.fail(gap, session.error);
    this.options.store.markGapRecovered(gap.id, this.now());
    this.options.logger.info('gap re-run: gap filled', {
      meetingId: gap.meetingId,
      gapId: gap.id,
      source: gap.source,
      reason: gap.reason,
      lines,
      // Audio the backup never held (paused, a hole): it is not coming back.
      missingMs: Math.max(0, gap.endMs - gap.startMs - held),
    });
    return 'recovered';
  }

  /** One vendor session over the pieces, at real time. */
  private async transcribe(
    gap: TranscriptGap,
    pieces: readonly GapAudioPiece[],
    signal: AbortSignal,
  ): Promise<Session> {
    const opened = await this.open(gap, signal);
    if (opened.kind === 'interrupted') return { finals: [], interrupted: true, error: null };
    if (opened.kind === 'failed') return { finals: [], interrupted: false, error: opened.error };
    const { stt, stream, provider } = opened;
    // On an object, not in `let`s: the listener sets them, which TypeScript's narrowing never sees.
    const heard: Heard = { finals: [], fatal: null, closed: false };
    const stopListening = stream.on((event) => {
      if (event.type === 'final') {
        heard.finals.push({
          startMs: event.startMs,
          endMs: event.endMs,
          text: event.text,
          confidence: event.confidence,
          words: event.words,
        });
      } else if (event.type === 'error') {
        if (event.fatal) heard.fatal ??= event.message;
        else this.logSessionError(gap, event.message);
      } else if (event.type === 'closed') {
        heard.closed = true;
      }
    });
    // The stream's clock runs over the pieces back to back; their meeting offsets map it back.
    const timeline = new AudioTimeline(PCM_SAMPLE_RATE);
    let interrupted = false;
    let endedEarly = false;
    try {
      const startedAt = this.paceClock();
      let sentMs = 0;
      sending: for (const piece of pieces) {
        for (let offset = 0; offset < piece.pcm.byteLength; offset += CHUNK_BYTES) {
          // Never ahead of real time: AssemblyAI closes a session sent audio faster (3007). The
          // core paces too, but only from its queue: the whole gap at once would sit there, with
          // the keep-alive and the liveness check reading it as a source gone quiet.
          const waitMs = startedAt + sentMs - this.paceClock();
          if (waitMs > 0) await this.sleep(waitMs, signal);
          if (this.interrupted(signal)) {
            interrupted = true;
            break sending;
          }
          if (heard.fatal !== null || heard.closed) {
            endedEarly = heard.fatal === null;
            break sending;
          }
          const chunk = piece.pcm.subarray(offset, offset + CHUNK_BYTES);
          timeline.append(piece.startMs + offset / BYTES_PER_MS, chunk.byteLength / 2);
          stream.send(chunk);
          sentMs += chunk.byteLength / BYTES_PER_MS;
        }
      }
      // A Start or quit: drop the session now, no finish (the next call's opens are under way).
      if (interrupted) await (stream.terminate?.() ?? stream.close());
      else await stream.close();
    } catch (error) {
      heard.fatal ??= errorMessage(error);
    } finally {
      stopListening();
      this.saveUsage(gap, stt, provider);
    }
    const finals = heard.finals.map((final) => mapFinal(timeline, final));
    if (interrupted) return { finals, interrupted, error: null };
    if (heard.fatal !== null) {
      return {
        finals,
        interrupted,
        error: `${stt.vendorName} failed during the re-run: ${heard.fatal}`,
      };
    }
    if (endedEarly) {
      return {
        finals,
        interrupted,
        error: `${stt.vendorName} ended the session before it was sent all of this part of the call.`,
      };
    }
    return { finals, interrupted, error: null };
  }

  /**
   * A token, a slot, an open: in that order, the slot taken right before `openStream` (house rule
   * 9). A vendor that refuses the jargon list is opened once more without it, through the budget
   * like any open (CaptureSession.connect does the same for a recording, M3-T4b).
   */
  private async open(gap: TranscriptGap, signal: AbortSignal): Promise<Opened> {
    const { budget, logger } = this.options;
    let withoutKeyterms = false;
    for (;;) {
      if (!(await this.slotFree(signal))) return { kind: 'interrupted' };
      let credentials: RerunCredentials;
      try {
        credentials = await this.options.credentials();
      } catch (error) {
        return {
          kind: 'failed',
          error: `Roger could not get a speech-to-text token: ${errorMessage(error)}`,
        };
      }
      if (this.interrupted(signal)) return { kind: 'interrupted' };
      // Taken by another open since slotFree said yes: wait for the next.
      if (!budget.acquire(1, 'minute').ok) continue;
      const stt = this.options.createSpeechToText(credentials.provider);
      const settings = withoutKeyterms ? noKeyterms(credentials) : credentials.settings;
      try {
        const stream = await stt.openStream({
          accessToken: credentials.accessToken,
          settings,
          label: gap.source,
        });
        if (this.interrupted(signal)) {
          await (stream.terminate?.() ?? stream.close());
          this.saveUsage(gap, stt, credentials.provider);
          return { kind: 'interrupted' };
        }
        return { kind: 'open', stt, stream, provider: credentials.provider };
      } catch (error) {
        // A failed connect may still have been billed (SttUsage.sessionsOpened).
        this.saveUsage(gap, stt, credentials.provider);
        const terms = settings.keyterms?.length ?? 0;
        if (
          !withoutKeyterms &&
          terms > 0 &&
          error instanceof SttConnectError &&
          error.keytermsRejected
        ) {
          logger.warn('gap re-run: jargon list rejected; re-running without it', {
            meetingId: gap.meetingId,
            gapId: gap.id,
            terms,
          });
          withoutKeyterms = true;
          continue;
        }
        return {
          kind: 'failed',
          error: `${stt.vendorName} could not start a session: ${errorMessage(error)}`,
        };
      }
    }
  }

  /**
   * Waits until the minute window has room for this open and a Start's (see the class comment).
   * False once a Start or quit cuts the run short.
   */
  private async slotFree(signal: AbortSignal): Promise<boolean> {
    for (;;) {
      if (this.interrupted(signal)) return false;
      const decision = this.options.budget.check(1 + this.reserve, 'minute');
      if (decision.ok) {
        this.setState('running');
        return true;
      }
      // A minute-only check never reads the meeting's count; were it ever refused for that, a
      // minute's wait keeps this from spinning.
      const retryAtMs =
        decision.kind === 'per-minute' ? decision.retryAtMs : this.clock() + MINUTE_MS;
      if (this.progress?.state !== 'waiting') {
        this.options.logger.info('gap re-run: waiting for the open budget', {
          reason: decision.message,
        });
      }
      this.setState('waiting');
      await this.sleep(Math.max(1, retryAtMs - this.clock()), signal);
    }
  }

  /**
   * Stores what the stored lines lack (missingPart), call audio as it is, each mic line through
   * the echo filter right after it is stored. Returns how many lines it stored.
   */
  private saveLines(
    gap: TranscriptGap,
    finals: readonly RerunFinal[],
    fromMs: number,
    toMs: number,
  ): number {
    const { store } = this.options;
    if (finals.length === 0) return 0;
    // Read before any of these is stored: they are what is new.
    const stored = store.listSegmentsOverlapping(gap.meetingId, gap.source, fromMs, toMs);
    const createdAt = this.now();
    let saved = 0;
    for (const final of finals) {
      const part = missingPart(final, stored);
      if (part === null || part.text.trim() === '') continue;
      const segment: TranscriptSegment = {
        id: randomUUID(),
        meetingId: gap.meetingId,
        source: gap.source,
        speaker: SPEAKER_FOR_SOURCE[gap.source],
        startMs: part.startMs,
        endMs: part.endMs,
        text: part.text,
        confidence: part.confidence,
        words: part.words,
        createdAt,
      };
      store.appendSegment(segment, 'rerun');
      // Trap: in the same turn as appendSegment, no await between (EchoSink.filterStored). Across
      // an await the uploader could send the line first, and the hide would come too late.
      if (gap.source === 'mic') this.filterEcho(segment);
      saved += 1;
    }
    return saved;
  }

  private filterEcho(segment: TranscriptSegment): void {
    try {
      this.options.echo.filterStored(segment.id);
    } catch (error) {
      // The line stays and uploads as said: a double of Them's words, never a lost line.
      this.options.logger.error('gap re-run: the echo filter failed on a re-run line; it stays', {
        meetingId: segment.meetingId,
        segmentId: segment.id,
        error: errorMessage(error),
      });
    }
  }

  private fail(gap: TranscriptGap, reason: string): GapOutcome {
    this.options.logger.warn('gap re-run: a gap was not filled', {
      meetingId: gap.meetingId,
      gapId: gap.id,
      source: gap.source,
      reason: gap.reason,
      error: reason,
    });
    this.options.store.setGapRecoverError(gap.id, reason);
    return 'failed';
  }

  /** The session's use into the meeting's `stt_usage` row; a failure there is logged only. */
  private saveUsage(gap: TranscriptGap, stt: SpeechToText, provider: string): void {
    const usage = stt.usage();
    if (usage.sessionsOpened === 0 && usage.connectedMs === 0) return;
    const { logger, store } = this.options;
    logger.info('gap re-run: stt meter', {
      meetingId: gap.meetingId,
      gapId: gap.id,
      source: gap.source,
      provider,
      usage,
    });
    try {
      addRerunUsage(store, {
        meetingId: gap.meetingId,
        provider,
        source: gap.source,
        usage,
        updatedAt: this.now(),
      });
    } catch (error) {
      // The log line above keeps the numbers.
      logger.error('gap re-run: speech-to-text usage not saved locally', {
        meetingId: gap.meetingId,
        error: errorMessage(error),
      });
    }
  }

  private logSessionError(gap: TranscriptGap, message: string): void {
    this.options.logger.warn('gap re-run: speech-to-text error', {
      meetingId: gap.meetingId,
      gapId: gap.id,
      error: message,
    });
  }

  private recovered(meetingId: string): void {
    try {
      this.options.onRecovered(meetingId);
    } catch (error) {
      this.options.logger.error('gap re-run: the backup status was not read again', {
        meetingId,
        error: errorMessage(error),
      });
    }
  }

  /** A Start began (or quit): checked again after every wait, before any open or chunk. */
  private interrupted(signal: AbortSignal): boolean {
    return signal.aborted || this.stopped || this.options.capture.phase !== 'idle';
  }

  private setState(state: RerunStatus['state']): void {
    if (this.progress === null || this.progress.state === state) return;
    this.setProgress({ ...this.progress, state });
  }

  private setProgress(progress: RerunStatus | null): void {
    if (progress === null && this.progress === null) return;
    this.progress = progress;
    this.options.capture.refreshStatus();
  }

  private now(): string {
    return new Date(this.clock()).toISOString();
  }
}

/** A stream opened with no jargon list is billed at the price without it (StreamCredentials). */
function noKeyterms(credentials: RerunCredentials): SttStreamSettings {
  return {
    ...credentials.settings,
    keyterms: [],
    pricePerHourUsd:
      credentials.pricePerHourUsdWithoutKeyterms ?? credentials.settings.pricePerHourUsd,
  };
}

/** A timer that ends early once `signal` aborts, and leaves no listener behind either way. */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
