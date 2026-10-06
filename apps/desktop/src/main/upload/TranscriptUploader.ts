import type { UploadStatus } from '../../shared/capture';
import type { TranscriptSegment } from '../../shared/transcript';
import { ApiError, type UploadApi } from '../api/ApiClient';
import { errorMessage, type Logger } from '../logger';
import type { LocalMeeting, TranscriptStore } from '../store/TranscriptStore';
import { Emitter } from '../util/emitter';

/**
 * What runs before the uploader's first tick (`TranscriptUploader.setBeforeFirstTick`).
 * `launchedAt` is when the uploader was built (ISO 8601, UTC), the same on every attempt: main
 * builds it before anything can store a line (CaptureService takes it), so a line created before
 * that instant is from an earlier run.
 */
export type BeforeFirstTick = (launchedAt: string) => void | Promise<void>;

export interface TranscriptUploaderOptions {
  store: TranscriptStore;
  api: UploadApi;
  logger: Logger;
  /** Poll interval while healthy. */
  intervalMs?: number;
  batchSize?: number;
  /** First retry delay after a failure; doubles each time up to `maxBackoffMs`. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  clock?: () => Date;
  /**
   * Whether the meeting holds notes with text in them (`NotesStore.hasNotes`, notes.sqlite). A
   * meeting nobody spoke in is kept for them, and created in Postgres once it has ended. Left out,
   * no meeting has notes: M1's rule, right while nothing writes notes. M4-T16 wires it here, and
   * only here: CaptureService asks the uploader (`hasNotes` below), so the three delete sites share
   * one check and none can be wired without the others.
   */
  hasNotes?: (meetingId: string) => boolean;
}

interface UploaderEvents extends Record<string, unknown> {
  status: UploadStatus;
}

/**
 * Drains the local store into Postgres. It runs for the life of the app, not per meeting, so a
 * crash or an offline stretch is recovered on the next tick: pending meetings are created once
 * they hold a line, or once they have ended with notes, unsynced lines are appended in batches,
 * ended meetings are ended remotely once they hold no line back. It is the only code that creates
 * meetings in Postgres (NotesSync waits for it; see syncMeeting). A meeting ended remotely is synced again whenever it gets a line that
 * can upload (a re-run, an unhidden or a released line), so no later line is stranded.
 * Everything it sends is idempotent (house rule 7), so a retry after a half-failed tick is always
 * safe.
 */
export class TranscriptUploader {
  private readonly events = new Emitter<UploaderEvents>();
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly clock: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inflight: Promise<Error | null> | null = null;
  private failures = 0;
  private status: UploadStatus;
  /** Null until set, and again once it has run. */
  private beforeFirstTick: BeforeFirstTick | null = null;
  /** True from the moment the first tick starts: a hook set after that could not run first. */
  private ticked = false;
  /** Handed to the hook on every attempt (`BeforeFirstTick`). */
  private readonly launchedAt: string;

  constructor(private readonly options: TranscriptUploaderOptions) {
    this.intervalMs = options.intervalMs ?? 2_000;
    this.batchSize = options.batchSize ?? 200;
    this.baseBackoffMs = options.baseBackoffMs ?? 2_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.clock = options.clock ?? (() => new Date());
    this.launchedAt = this.clock().toISOString();
    this.status = {
      state: 'idle',
      pending: options.store.countUnsyncedSegments(),
      rejected: options.store.countRejectedSegments(),
      lastError: null,
      nextAttemptAt: null,
    };
  }

  /**
   * Set what runs once, awaited, before the first tick (a scheduled one or a flush): the echo
   * sink's startup settle (M2-T14b), so the holds a crash left are decided before any line goes
   * up. A failure is a failed tick (logged, backed off, shown in the status) and the hook runs
   * again on the next one: no line goes up before it succeeds, or one it would have hidden could.
   *
   * Trap for M2-T14b and M2-T23: the hook can run long after launch. The first attempt runs on
   * start's 0 ms tick, before any window exists, but a failed one is retried on every later tick
   * (2 s, doubling to 30 s), and a flush at Stop reaches it too. By then a Start, or an M2-T23
   * resume, may hold mic lines for their call-audio twins. So the settle touches only holds on
   * lines created before `launchedAt`, never every line `listHeldSegments()` lists: a live hold
   * checked now finds no twin yet, is released, goes up in this same tick, and Postgres gets the
   * echo text twice.
   *
   * A setter, not a constructor option: main builds the uploader before the capture runtime
   * (CaptureService takes it), and the echo sink that settles exists only inside that runtime's
   * M2-T14b slot. index.ts starts the uploader after the runtime is built, so the slot is in time.
   * Throws once the first tick has started, since the hook could no longer run before it, and
   * when one is already set, since a second would silently replace it.
   */
  setBeforeFirstTick(hook: BeforeFirstTick): void {
    if (this.ticked) {
      throw new Error(
        "the step before the first upload must be set before the uploader's first tick, which has started",
      );
    }
    if (this.beforeFirstTick !== null) {
      throw new Error('a step before the first upload is already set');
    }
    this.beforeFirstTick = hook;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Run one full sync now (after any tick in flight). Rejects if this sync fails. */
  async flush(): Promise<void> {
    // A tick already in flight has reported its own outcome (log line, status, backoff); its
    // result is not this flush's answer, so wait for it and then run a fresh tick.
    if (this.inflight) await this.inflight;
    const error = await this.runTick();
    if (error !== null) throw error;
  }

  getStatus(): UploadStatus {
    return {
      ...this.status,
      pending: this.options.store.countUnsyncedSegments(),
      rejected: this.options.store.countRejectedSegments(),
    };
  }

  onStatus(listener: (status: UploadStatus) => void): () => void {
    return this.events.on('status', listener);
  }

  /**
   * Whether a meeting nobody spoke in must be kept for its notes: the one check every delete site
   * makes (the pending rule in syncMeeting, and CaptureService's after a failed Start and at Stop).
   * Throws, naming the meeting, when notes.sqlite cannot be read.
   */
  hasNotes(meetingId: string): boolean {
    const check = this.options.hasNotes;
    if (check === undefined) return false;
    try {
      return check(meetingId);
    } catch (error) {
      throw new Error(`could not read the notes of meeting ${meetingId}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Postgres does not know a meeting this Mac thinks it sent (a notes `PUT` answered `404`; a reset
   * dev database): take it back to pending and forget that its lines went up, so the next tick
   * creates it again by the pending rule, re-sends every line and ends it again. Everything it
   * sends is idempotent. An unknown meeting is left alone.
   *
   * Synchronous on purpose: NotesSync calls it from `onMeetingMissing` and reads the meeting's
   * state right after. Seen pending, its notes wait until the uploader has created the meeting; a
   * state not yet pending would leave them stranded until some uploader status showed it pending.
   * NotesSync never creates the meeting itself (see syncMeeting).
   */
  markMeetingMissing(meetingId: string): void {
    const { store, logger } = this.options;
    if (store.getMeeting(meetingId) === null) return;
    store.resetSyncForMeeting(meetingId);
    store.setMeetingRemoteState(meetingId, 'pending');
    logger.info('meeting missing from the API, sending it again', { meetingId });
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // Never rejects: tick() logs a failure, shows it in the status and schedules the retry.
      void this.runTick();
    }, delayMs);
  }

  private runTick(): Promise<Error | null> {
    if (this.inflight) return this.inflight;
    this.inflight = this.tick().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * One sync pass. Never rejects: every failure, the local store's included, is logged, retried
   * with backoff and shown in the status, then handed back for `flush` to rethrow. Anything that can
   * throw belongs inside the try, or inside the catch's own try; a throw outside them once ended the
   * loop with no log and no retry.
   */
  private async tick(): Promise<Error | null> {
    this.ticked = true;
    try {
      // Awaited only while it is due: an await yields, and every later tick keeps M1's timing, in
      // which a tick reaches the store and the API in the turn that started it.
      if (this.beforeFirstTick !== null) await this.runBeforeFirstTick(this.beforeFirstTick);
      const meetings = this.options.store.listMeetingsNeedingSync();
      if (meetings.length > 0)
        this.setStatus({ state: 'uploading', lastError: null, nextAttemptAt: null });
      // One meeting's problem must not hold the others hostage; the first error is still reported.
      let firstError: Error | null = null;
      for (const meeting of meetings) {
        try {
          await this.syncMeeting(meeting);
        } catch (error) {
          firstError ??= error instanceof Error ? error : new Error(String(error));
        }
      }
      if (firstError !== null) throw firstError;
      this.failures = 0;
      this.setStatus({ state: 'idle', lastError: null, nextAttemptAt: null });
      this.schedule(this.intervalMs);
      return null;
    } catch (error) {
      this.failures += 1;
      const delay = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (this.failures - 1));
      const message = errorMessage(error);
      this.options.logger.warn('upload failed, backing off', {
        failures: this.failures,
        delayMs: delay,
        error: message,
      });
      // Retry first, then report: setStatus reads the store's counts and runs the status
      // listeners, which read them again. A store that fails every call (closed at quit, corrupt,
      // I/O errors) throws there too, and that throw once rejected tick() before the retry was
      // set, so the loop stopped for good right after logging that it was backing off.
      this.schedule(delay);
      try {
        this.setStatus({
          state: 'backoff',
          lastError: message,
          nextAttemptAt: this.clock().getTime() + delay,
        });
      } catch (statusError) {
        this.options.logger.error('upload status could not be updated', {
          error: errorMessage(statusError),
          uploadError: message,
        });
      }
      return error instanceof Error ? error : new Error(message);
    }
  }

  private async runBeforeFirstTick(hook: BeforeFirstTick): Promise<void> {
    try {
      await hook(this.launchedAt);
    } catch (error) {
      throw new Error(`could not run the step before the first upload: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    this.beforeFirstTick = null;
  }

  private async syncMeeting(meeting: LocalMeeting): Promise<void> {
    const { store, api, logger } = this.options;
    if (meeting.remoteState === 'pending') {
      // Postgres hears of a meeting only once it has content: a line, or, once it has ended,
      // notes. Creating it at Start put empty meetings in Postgres (MCP's "latest meeting" was a
      // 0-line one) and raced Stop's local delete, leaving a meeting stuck in "recording"; so a
      // meeting is never in Postgres with no line while it is still recording.
      //
      // Trap: this is the only code that creates meetings in Postgres, and three sites must agree
      // with it on which lineless meetings to keep: this one, and CaptureService's two
      // deleteMeetingIfEmpty calls (after a failed Start, and at Stop), which delete a meeting no
      // one spoke in outright. All three ask `this.hasNotes` first. A site that deletes a meeting
      // with notes leaves them stranded: NotesSync never creates a meeting (its class comment) and
      // waits for this rule, and markMeetingMissing cannot take back a meeting that is gone.
      if (store.listUnsyncedSegments(meeting.id, 1).length === 0) {
        // Still recording: nothing to create it for, notes or not. notes.sqlite is read only past
        // this point, not on every tick of every meeting being recorded.
        if (meeting.endedAt === null) return;
        if (!this.hasNotes(meeting.id)) {
          if (store.deleteMeetingIfEmpty(meeting.id)) {
            // Ended without a line or notes, for example a crash right after Start.
            logger.info('empty meeting discarded', { meetingId: meeting.id });
          }
          // No line can upload yet (rejected, hidden or held): nothing to create it for. One with
          // a held line is kept, and created once the line is released.
          return;
        }
        // Ended with notes and no line that can upload: created and ended in this one pass (the
        // end below waits only for held lines), so a notes-only meeting is never left "recording".
      }
      await api.createMeeting({
        id: meeting.id,
        title: meeting.title,
        startedAt: meeting.startedAt,
      });
      store.setMeetingRemoteState(meeting.id, 'created');
    }
    try {
      for (;;) {
        // Nothing async between this list and uploadBatch, which marks the batch sent before its
        // first await: an echo hide or trim landing in between would change a line already listed.
        const batch = store.listUnsyncedSegments(meeting.id, this.batchSize);
        if (batch.length === 0) break;
        await this.uploadBatch(meeting.id, batch);
        this.setStatus({});
      }
      // Never while the meeting holds lines: Postgres reads an ended meeting as finished, and a held
      // mic line has not gone up yet (the echo sink releases it at its twin's watermark, at Stop or
      // at its 120 s cap; a crash leaves it to the startup settle). A meeting not yet ended
      // remotely stays listed, so the end goes out on the tick after the last release or cap; one
      // ended remotely comes back with the released line (listMeetingsNeedingSync), and its end is
      // re-sent after it (the API's end is idempotent).
      if (meeting.endedAt !== null && store.countHeldSegments(meeting.id) === 0) {
        await api.endMeeting(meeting.id, meeting.endedAt);
        store.setMeetingRemoteState(meeting.id, 'ended');
      }
    } catch (error) {
      // Postgres no longer knows the meeting (for example a reset dev database): recreate it and
      // re-send every line next tick.
      if (error instanceof ApiError && error.isNotFound) this.markMeetingMissing(meeting.id);
      throw error;
    }
  }

  /**
   * One request per batch. A 422 means at least one line is invalid; retrying would block the
   * queue forever, so the batch is retried line by line and the rejected lines are set aside.
   */
  private async uploadBatch(meetingId: string, batch: TranscriptSegment[]): Promise<void> {
    const { store, api, logger } = this.options;
    const ids = batch.map((segment) => segment.id);
    // Before the request and in the turn that listed the batch (no await may come between): from
    // here the store refuses an echo hide, trim or hold of these lines, which would otherwise land
    // while the request is out and leave the local copy disagreeing with what Postgres got.
    store.markSegmentsSent(ids);
    try {
      const result = await api.appendSegments(meetingId, batch);
      store.markSegmentsSynced(ids, this.clock().toISOString());
      logger.debug('segments uploaded', { meetingId, ...result });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 422)) throw error;
      if (batch.length === 1) {
        const [segment] = batch;
        if (segment) {
          store.markSegmentRejected(segment.id, error.message, this.clock().toISOString());
          logger.error('segment rejected by the API and set aside', {
            meetingId,
            segmentId: segment.id,
            reason: error.message,
          });
        }
        return;
      }
      for (const segment of batch) await this.uploadBatch(meetingId, [segment]);
    }
  }

  private setStatus(patch: Partial<UploadStatus>): void {
    // Kept before the counts are read: when the store fails them, the backoff and its error still
    // show as soon as the store reads again.
    this.status = { ...this.status, ...patch };
    this.status = {
      ...this.status,
      pending: this.options.store.countUnsyncedSegments(),
      rejected: this.options.store.countRejectedSegments(),
    };
    this.events.emit('status', this.status);
  }
}
