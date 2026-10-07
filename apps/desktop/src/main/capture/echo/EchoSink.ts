import type { EchoStatus, TranscriptSegmentChange } from '../../../shared/capture';
import type { AudioSource, TranscriptSegment } from '../../../shared/transcript';
import { errorMessage, type LogFields, type Logger } from '../../logger';
import type { StoredSegment, TranscriptStore } from '../../store/TranscriptStore';
import type { SourceWatermark, WatermarkListener } from '../CaptureSession';
import { ECHO_MATCH_WINDOW_MS, type EchoLine, filterEcho, isEchoFilterOn } from './EchoFilter';
import type { RouteProvider } from './RouteProvider';

/**
 * The longest a mic line waits for call audio before it may upload anyway (M2 D2). Only a cap: the
 * call-audio watermark or that stream's close releases a line long before it, unless call audio
 * is reconnecting all that time.
 */
export const ECHO_HOLD_CAP_MS = 120_000;

/** The live CaptureSession, as far as the sink reads it: M2-T6's watermark per source. */
export interface EchoSession {
  watermark(source: AudioSource): SourceWatermark;
  onWatermark(listener: WatermarkListener): () => void;
}

export interface EchoRecordingListener {
  started?(recording: { meetingId: string; session: EchoSession }): void;
  ended?(recording: { meetingId: string }): void;
}

/** CaptureService, as far as the sink follows it: its recordings and each line once stored. */
export interface EchoCapture {
  on(event: 'segment', listener: (segment: TranscriptSegment) => void): () => void;
  onRecording(listener: EchoRecordingListener): () => void;
}

/**
 * What became of a line. `too-late`: the line was left as it was because the uploader has sent it
 * or is sending it (TranscriptStore.markSegmentsSent), so Postgres may already hold it.
 */
export type EchoOutcome = 'hidden' | 'trimmed' | 'kept' | 'too-late';

export interface EchoSinkOptions {
  store: TranscriptStore;
  /** config.json `echoFilter`. Off, nothing is hidden, trimmed or held (M2-T13's smoke run). */
  enabled: boolean;
  route: RouteProvider;
  /** Sends `transcript:segment-changed` to the window. */
  publishChange: (change: TranscriptSegmentChange) => void;
  logger: Logger;
  clock?: () => number;
}

interface HeldLine {
  id: string;
  startMs: number;
  endMs: number;
  /** Clock time its hold ends anyway (the line's `upload_after`). */
  capAtMs: number;
}

/** The recording the sink follows. */
interface LiveMeeting {
  meetingId: string;
  session: EchoSession;
  /** The mic lines this recording holds for their call-audio twins. */
  held: Map<string, HeldLine>;
  /** The meeting's hidden and trimmed mic lines, earlier runs' included: the status counts. */
  hidden: Set<string>;
  trimmed: Set<string>;
  stopWatching: () => void;
}

/**
 * Applies the echo filter (EchoFilter.ts, M2 D2) to stored mic lines. On laptop speakers the mic
 * hears the call, and the vendor writes Them's words a second time under Me: such a line is
 * hidden (it stays in SQLite with `suppressed_reason = 'echo'` and never uploads unless the user
 * shows it again), or its repeated runs are trimmed out (the vendor's text kept locally).
 *
 * A call-audio twin can land after its mic line, for as long as that stream reconnects (its
 * backoff is not the mic's). So while recording, each mic line is held (`upload_after`) until the
 * call-audio watermark passes its end plus ECHO_MATCH_WINDOW_MS, until call audio can send no
 * more, until Stop, or at ECHO_HOLD_CAP_MS; and each call-audio line re-decides the held mic lines
 * it may repeat. Every hide, trim and hold goes through the store, which refuses a line the
 * uploader has sent or is sending: the sink reads that as too late and leaves the line as sent.
 */
export class EchoSink {
  private readonly clock: () => number;
  private live: LiveMeeting | null = null;

  constructor(private readonly options: EchoSinkOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Follows capture's recordings and the lines they store. */
  attach(capture: EchoCapture): void {
    capture.onRecording({
      started: ({ meetingId, session }) => {
        this.follow(meetingId, session);
      },
      ended: ({ meetingId }) => {
        this.unfollow(meetingId);
      },
    });
    capture.on('segment', (segment) => {
      this.onLine(segment);
    });
  }

  /**
   * The recording meeting's counts, from memory: a status contributor runs for every status. Null
   * for any other meeting, and when none records.
   */
  liveStatus(meetingId: string | null): EchoStatus | null {
    const live = this.live;
    if (live?.meetingId !== meetingId) return null;
    const now = this.clock();
    return {
      hidden: live.hidden.size,
      trimmed: live.trimmed.size,
      held: [...live.held.values()].filter((held) => held.capAtMs > now).length,
    };
  }

  /** One meeting's counts, read from the store (its capture report). */
  report(meetingId: string): EchoStatus {
    const { hidden, trimmed } = this.storedEchoLines(meetingId);
    const now = this.clock();
    const held = this.options.store
      .listHeldSegments(meetingId)
      .filter((line) => line.uploadAfter !== null && Date.parse(line.uploadAfter) > now).length;
    return { hidden: hidden.size, trimmed: trimmed.size, held };
  }

  /**
   * Shows a hidden line again: the user says it was not an echo, and it may upload now. Throws,
   * naming the line, when the store does not have it hidden.
   */
  unhide(segment: StoredSegment): void {
    if (!this.options.store.unhideSegment(segment.id)) {
      throw new Error(
        `Line ${segment.id} of meeting ${segment.meetingId} is not hidden: there is nothing to show again.`,
      );
    }
    this.changed(segment, 'unhidden', null, segment.text);
    this.options.logger.info('echo line shown again', {
      meetingId: segment.meetingId,
      segmentId: segment.id,
    });
  }

  /**
   * Settles the holds an earlier run left (a crash, a kill, a quit that outran its stop): each
   * held line created before `launchedAt` is decided once against the call-audio lines stored, and
   * released unless hidden. The uploader runs it before its first tick (`setBeforeFirstTick`), so
   * none of them goes up first. Throws when the store fails; the uploader retries it.
   *
   * Trap: only lines created before `launchedAt`, never every line `listHeldSegments()` lists. A
   * failed settle is retried on later ticks and by Stop's upload flush, when a recording of this
   * run may hold lines for twins still to come: settled then, they would find none, go up in that
   * same tick, and Postgres would get the echo text twice.
   *
   * A held line past its cap may have been mid-upload at the crash, and the store's mark of a line
   * being sent lives in memory (TranscriptStore.markSegmentsSent): hiding it here can leave
   * Postgres holding a line this Mac hides. Accepted: not hiding it uploads the echo for certain
   * whenever it was never sent.
   */
  settleAll(launchedAt: string): void {
    const launch = Date.parse(launchedAt);
    if (!Number.isFinite(launch)) {
      throw new Error(
        `could not settle the echo holds left before launch: "${launchedAt}" is not an instant`,
      );
    }
    const { store, logger } = this.options;
    const left = store.listHeldSegments().filter((line) => Date.parse(line.createdAt) < launch);
    if (left.length === 0) return;
    const filterOn = this.filterOn();
    const released: string[] = [];
    for (const line of left) {
      const outcome = filterOn && line.source === 'mic' ? this.decide(line) : 'kept';
      if (outcome !== 'hidden') released.push(line.id);
    }
    store.releaseSegments(released);
    logger.info('echo holds left by an earlier run settled', {
      lines: left.length,
      hidden: left.length - released.length,
    });
  }

  /**
   * Decides one stored line against the call-audio lines stored now, and holds nothing: M2-T16's
   * gap re-run, after Stop, when call audio has sent all it will. Store the re-run's call-audio
   * lines first, and call this in the same turn as `appendSegment`, with no await between: the
   * uploader could otherwise send the line first, and the hide would come too late. A call-audio
   * line is kept. Throws for a line that is not stored.
   */
  filterStored(segmentId: string): EchoOutcome {
    const line = this.options.store.getSegment(segmentId);
    if (line === null) {
      throw new Error(`Line ${segmentId} is not stored: store a re-run line before filtering it.`);
    }
    if (line.source !== 'mic' || !this.filterOn()) return 'kept';
    return this.decide(line);
  }

  private follow(meetingId: string, session: EchoSession): void {
    let counted = { hidden: new Set<string>(), trimmed: new Set<string>() };
    // A resumed meeting (M2 D7) has lines from its earlier run.
    this.guard('reading the counts of a meeting', { meetingId }, () => {
      counted = this.storedEchoLines(meetingId);
    });
    const stopWatching = session.onWatermark((source, watermark) => {
      const live = this.live;
      if (source !== 'system' || live?.meetingId !== meetingId) return;
      this.onCallAudioMark(live, watermark);
    });
    this.live = { meetingId, session, held: new Map(), ...counted, stopWatching };
  }

  private unfollow(meetingId: string): void {
    const live = this.live;
    if (live?.meetingId !== meetingId) return;
    this.live = null;
    live.stopWatching();
    // Stop's session close has delivered the last call-audio lines, each twin has had its chance,
    // and Stop's upload flush runs right after this. A release that fails leaves the lines to
    // their cap, or to the next launch's settle; the uploader does not end the meeting meanwhile.
    const ids = [...live.held.keys()];
    this.guard('releasing the held lines at Stop', { meetingId, lines: ids.length }, () => {
      this.options.store.releaseSegments(ids);
    });
  }

  private onLine(segment: TranscriptSegment): void {
    const live = this.live;
    // CaptureService sends only its recording's lines, between `started` and `ended`.
    if (live?.meetingId !== segment.meetingId || !this.filterOn()) return;
    if (segment.source === 'mic') {
      this.guard(
        'filtering a mic line',
        { meetingId: live.meetingId, segmentId: segment.id },
        () => {
          this.onMicLine(live, segment.id);
        },
      );
      return;
    }
    for (const held of [...live.held.values()]) {
      // Words lie inside their line's span, so a held line this far off repeats none of it.
      const apart =
        held.startMs > segment.endMs + ECHO_MATCH_WINDOW_MS ||
        held.endMs < segment.startMs - ECHO_MATCH_WINDOW_MS;
      if (apart) continue;
      this.guard(
        'checking a held mic line against a new call-audio line',
        { meetingId: live.meetingId, segmentId: held.id, callAudioSegmentId: segment.id },
        () => {
          const line = this.options.store.getSegment(held.id);
          const outcome = line === null ? 'too-late' : this.decide(line);
          if (outcome === 'hidden' || outcome === 'too-late') live.held.delete(held.id);
        },
      );
    }
  }

  private onMicLine(live: LiveMeeting, segmentId: string): void {
    const { store, logger } = this.options;
    const line = store.getSegment(segmentId);
    // Not stored: the session could not save it, and has said so. Nothing to hide or hold.
    if (line === null) return;
    const outcome = this.decide(line);
    if (outcome === 'hidden' || outcome === 'too-late') return;
    const { finalEndMs, closed } = live.session.watermark('system');
    if (closed || passes(finalEndMs, line)) return;
    // Stored in this same turn: now is the line's creation, which the cap counts from.
    const capAtMs = this.clock() + ECHO_HOLD_CAP_MS;
    if (store.holdSegment(line.id, new Date(capAtMs).toISOString())) {
      live.held.set(line.id, { id: line.id, startMs: line.startMs, endMs: line.endMs, capAtMs });
    } else {
      logger.warn('mic line could not be held for its call-audio twin', {
        meetingId: line.meetingId,
        segmentId: line.id,
      });
    }
  }

  /** Releases the held lines call audio has gone past, or all of them once it can send no more. */
  private onCallAudioMark(live: LiveMeeting, watermark: SourceWatermark): void {
    const due = [...live.held.values()].filter(
      (held) => watermark.closed || passes(watermark.finalEndMs, held),
    );
    if (due.length === 0) return;
    this.guard('releasing held lines', { meetingId: live.meetingId, lines: due.length }, () => {
      this.options.store.releaseSegments(due.map((held) => held.id));
      for (const held of due) live.held.delete(held.id);
    });
  }

  /**
   * Decides one stored mic line against the call-audio lines stored now, and applies it: the one
   * place a line is hidden or trimmed, so the window and the counts hear of every change.
   */
  private decide(line: StoredSegment): EchoOutcome {
    const { store, route, logger } = this.options;
    const callAudio = store.listSegmentsOverlapping(
      line.meetingId,
      'system',
      line.startMs - ECHO_MATCH_WINDOW_MS,
      line.endMs + ECHO_MATCH_WINDOW_MS,
    );
    const decision = filterEcho(asTheVendorWroteIt(line), callAudio, route.current());
    const ids = { meetingId: line.meetingId, segmentId: line.id };
    switch (decision.action) {
      case 'keep':
        return 'kept';
      case 'hide':
        if (!store.suppressSegment(line.id, 'echo', decision.echoOf)) return 'too-late';
        logger.debug('echo line hidden', { ...ids, echoOf: decision.echoOf });
        this.changed(line, 'hidden', decision.echoOf, line.text);
        return 'hidden';
      case 'trim': {
        // The same cut as before: a later call-audio line repeated nothing else of it.
        if (decision.text === line.text) return 'trimmed';
        const trim = { text: decision.text, words: decision.words, echoOf: decision.echoOf };
        if (!store.trimSegment(line.id, trim)) return 'too-late';
        logger.debug('echo line trimmed', { ...ids, echoOf: decision.echoOf });
        this.changed(line, 'trimmed', decision.echoOf, decision.text);
        return 'trimmed';
      }
    }
  }

  /** Counts a change of the recording meeting, and tells the window. `line` is as it was before. */
  private changed(
    line: StoredSegment,
    change: TranscriptSegmentChange['change'],
    echoOf: string | null,
    text: string,
  ): void {
    const live = this.live;
    if (live?.meetingId === line.meetingId) {
      if (change === 'hidden') {
        live.hidden.add(line.id);
        live.trimmed.delete(line.id);
      } else if (change === 'trimmed') {
        live.trimmed.add(line.id);
      } else {
        live.hidden.delete(line.id);
        if (line.originalText !== null) live.trimmed.add(line.id);
      }
    }
    // The store has the change already: a window that misses it reads the meeting's lines again
    // when it opens it (a hidden line is not among them).
    this.guard(
      'telling the window of an echo change',
      { meetingId: line.meetingId, segmentId: line.id },
      () => {
        this.options.publishChange({
          meetingId: line.meetingId,
          segmentId: line.id,
          source: line.source,
          change,
          reason: 'echo',
          echoOf,
          text,
        });
      },
    );
  }

  /** The meeting's hidden mic lines, and the trimmed ones that are not hidden. */
  private storedEchoLines(meetingId: string): { hidden: Set<string>; trimmed: Set<string> } {
    const hidden = new Set<string>();
    const trimmed = new Set<string>();
    const lines = this.options.store.listSegmentsOverlapping(
      meetingId,
      'mic',
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    for (const line of lines) {
      if (line.suppressedReason !== null) hidden.add(line.id);
      else if (line.originalText !== null) trimmed.add(line.id);
    }
    return { hidden, trimmed };
  }

  private filterOn(): boolean {
    return this.options.enabled && isEchoFilterOn(this.options.route.current());
  }

  /**
   * Runs one piece of the sink's work. A failure is logged with the ids it concerns (never a
   * line's text) and goes no further: it must not cost capture the line, its watermark or the
   * window's copy, which the listeners after the sink deliver.
   */
  private guard(what: string, fields: LogFields, run: () => void): void {
    try {
      run();
    } catch (error) {
      this.options.logger.error(`echo sink failed ${what}`, {
        ...fields,
        error: errorMessage(error),
      });
    }
  }
}

/** Whether call audio's watermark has gone past `line`'s end by the match window. */
function passes(finalEndMs: number | null, line: { endMs: number }): boolean {
  return finalEndMs !== null && finalEndMs >= line.endMs + ECHO_MATCH_WINDOW_MS;
}

/**
 * The line as its vendor wrote it. A trimmed line is re-decided on every word it had, never on
 * what a trim left (filterEcho's doc says why): `original_text` and its words.
 */
function asTheVendorWroteIt(line: StoredSegment): EchoLine {
  if (line.originalText === null) return line;
  return {
    id: line.id,
    startMs: line.startMs,
    endMs: line.endMs,
    text: line.originalText,
    words: line.originalWords,
  };
}
