import type { UploadStatus } from '../../shared/capture';
import type { TranscriptSegment } from '../../shared/transcript';
import { ApiError, type UploadApi } from '../api/ApiClient';
import { errorMessage, type Logger } from '../logger';
import type { LocalMeeting, TranscriptStore } from '../store/TranscriptStore';
import { Emitter } from '../util/emitter';

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
}

interface UploaderEvents extends Record<string, unknown> {
  status: UploadStatus;
}

/**
 * Drains the local store into Postgres. It runs for the life of the app, not per meeting, so a
 * crash or an offline stretch is recovered on the next tick: pending meetings are created once
 * they hold a line, unsynced lines are appended in batches, ended meetings are ended remotely.
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

  constructor(private readonly options: TranscriptUploaderOptions) {
    this.intervalMs = options.intervalMs ?? 2_000;
    this.batchSize = options.batchSize ?? 200;
    this.baseBackoffMs = options.baseBackoffMs ?? 2_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.clock = options.clock ?? (() => new Date());
    this.status = {
      state: 'idle',
      pending: options.store.countUnsyncedSegments(),
      rejected: options.store.countRejectedSegments(),
      lastError: null,
      nextAttemptAt: null,
    };
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
   * One sync pass. Never rejects: every failure, the local store's included, is logged, shown in
   * the status and retried with backoff, then handed back for `flush` to rethrow. Anything that can
   * throw belongs inside the try; a throw outside it once ended the loop with no log and no retry.
   */
  private async tick(): Promise<Error | null> {
    try {
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
      this.setStatus({
        state: 'backoff',
        lastError: message,
        nextAttemptAt: this.clock().getTime() + delay,
      });
      this.schedule(delay);
      return error instanceof Error ? error : new Error(message);
    }
  }

  private async syncMeeting(meeting: LocalMeeting): Promise<void> {
    const { store, api, logger } = this.options;
    if (meeting.remoteState === 'pending') {
      // Postgres hears of a meeting only once it holds a line. Creating it at Start put empty
      // meetings in Postgres (MCP's "latest meeting" was a 0-line one) and raced Stop's local
      // delete, leaving a meeting stuck in "recording". CaptureService.doStop deletes an empty
      // meeting outright and relies on this rule: keep both sides in step.
      if (store.listUnsyncedSegments(meeting.id, 1).length === 0) {
        if (meeting.endedAt !== null && store.deleteMeetingIfEmpty(meeting.id)) {
          // Ended without a line, for example a crash right after Start: nothing to keep.
          logger.info('empty meeting discarded', { meetingId: meeting.id });
        }
        // Still recording, or every line was set aside as rejected: nothing to create it for.
        return;
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
        const batch = store.listUnsyncedSegments(meeting.id, this.batchSize);
        if (batch.length === 0) break;
        await this.uploadBatch(meeting.id, batch);
        this.setStatus({});
      }
      if (meeting.endedAt !== null) {
        await api.endMeeting(meeting.id, meeting.endedAt);
        store.setMeetingRemoteState(meeting.id, 'ended');
      }
    } catch (error) {
      // Postgres no longer knows the meeting (for example a reset dev database): recreate it and
      // re-send every line next tick.
      if (error instanceof ApiError && error.isNotFound) {
        store.resetSyncForMeeting(meeting.id);
        store.setMeetingRemoteState(meeting.id, 'pending');
      }
      throw error;
    }
  }

  /**
   * One request per batch. A 422 means at least one line is invalid; retrying would block the
   * queue forever, so the batch is retried line by line and the rejected lines are set aside.
   */
  private async uploadBatch(meetingId: string, batch: TranscriptSegment[]): Promise<void> {
    const { store, api, logger } = this.options;
    try {
      const result = await api.appendSegments(meetingId, batch);
      store.markSegmentsSynced(
        batch.map((segment) => segment.id),
        this.clock().toISOString(),
      );
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
    this.status = {
      ...this.status,
      ...patch,
      pending: this.options.store.countUnsyncedSegments(),
      rejected: this.options.store.countRejectedSegments(),
    };
    this.events.emit('status', this.status);
  }
}
