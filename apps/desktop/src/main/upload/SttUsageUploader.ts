import { ApiError } from '../api/http';
import type { SttUsageRoutes } from '../api/sttUsageClient';
import type { QuitHook } from '../lifecycle';
import { errorMessage, type Logger } from '../logger';
import type { MeetingSttUsage, TranscriptStore } from '../store/TranscriptStore';

export interface SttUsageUploaderOptions {
  store: Pick<TranscriptStore, 'listSttUsageToUpload' | 'markSttUsageSynced'>;
  api: SttUsageRoutes;
  logger: Logger;
  /** Between passes while healthy. */
  intervalMs?: number;
  /** First retry delay after a failed pass; doubles each time up to `maxBackoffMs`. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Rows per pass. A full batch is followed by the next pass at once. */
  batchSize?: number;
  clock?: () => Date;
}

/**
 * Sends each meeting's `stt_usage` row to the API (M3-T19b): every 30 s, and at once when asked
 * after a Stop (`sendNow`), each row that was saved since its last upload (every save clears the
 * mark, so a row saved again after its upload goes again). It runs for the life of the app, beside
 * TranscriptUploader and never through it: nothing here waits on the transcript's upload, so a
 * backlog of lines or an API slow to take them never holds back the cost record.
 *
 * One request at a time, never two: the API's PUT keeps whichever body arrives last, with no
 * ordering guard, so two requests for one meeting could leave it the older totals.
 *
 * A `422` is a refused row, not a failure: sent again unchanged it would be refused forever and
 * keep every other row in backoff. It is logged once and marked like an upload, so it goes again
 * only once a later save changes it. The API refuses nothing a Mac of another release could hold
 * (schemas/stt_usage.py), so a refusal names a bug, which the warning carries.
 */
export class SttUsageUploader {
  /** Stops the polling at quit, once a request still out has answered (the row is then marked). */
  readonly quitHook: QuitHook;
  private readonly intervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly batchSize: number;
  private readonly clock: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inflight: Promise<void> | null = null;
  /** `sendNow` came while a pass was out: the next pass runs as soon as it ends. */
  private passAgain = false;
  private failures = 0;

  constructor(private readonly options: SttUsageUploaderOptions) {
    this.intervalMs = options.intervalMs ?? 30_000;
    this.baseBackoffMs = options.baseBackoffMs ?? 30_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 300_000;
    this.batchSize = options.batchSize ?? 50;
    this.clock = options.clock ?? (() => new Date());
    this.quitHook = {
      name: 'stop the speech-to-text usage uploader',
      // One request at most to wait for: a pass sends no further row once stopped (pass()). Past
      // the bound the store closes under it: the mark fails (logged), and the row goes up again
      // at the next launch, which the PUT takes as a no-op.
      timeoutMs: 1_000,
      run: () => this.stop(),
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  /**
   * Send what is waiting now rather than at the next pass: after a Stop, whose save holds the
   * meeting's last totals and its stop reason. The request goes out in this turn, unless a pass is
   * out; then the next one runs as soon as that ends, never beside it. Never throws. Does nothing
   * before `start` or after `stop`.
   */
  sendNow(): void {
    if (!this.running) return;
    if (this.inflight !== null) {
      this.passAgain = true;
      return;
    }
    this.runPass();
  }

  /**
   * Ends the polling, and resolves once a pass still out has ended, which it does as soon as its
   * request out has answered: it sends no further row. Never rejects.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.clearTimer();
    await this.inflight;
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runPass();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private runPass(): void {
    this.clearTimer();
    // Never rejects: pass() logs every failure and schedules its own retry. A `sendNow` during
    // the pass is taken here, after it, not at its end: a pass with nothing to send ends in the
    // turn it started, before a `sendNow` in that same turn could be seen.
    this.inflight = this.pass().finally(() => {
      this.inflight = null;
      if (this.passAgain) {
        this.passAgain = false;
        this.schedule(0);
      }
    });
  }

  /**
   * One pass over the rows waiting. Never rejects: every failure, the store's included, is logged
   * and retried with backoff. One row's failure does not hold back the rest, but no answer at all
   * (offline, a timeout) ends the pass, since every other row would wait out the same.
   */
  private async pass(): Promise<void> {
    let nextMs = this.intervalMs;
    try {
      const rows = this.options.store.listSttUsageToUpload(this.batchSize);
      let firstError: Error | null = null;
      for (const usage of rows) {
        // Quit came during the pass: send no further row. The quit hook's 1 s bound covers the
        // one request still out, not the rest of a batch of 50; past it the store closes, and
        // every row sent after would fail its mark and go again at the next launch.
        if (!this.running) break;
        try {
          await this.send(usage);
        } catch (error) {
          if (error instanceof ApiError && error.status === 0) throw error;
          firstError ??= error instanceof Error ? error : new Error(String(error));
        }
      }
      if (firstError !== null) throw firstError;
      this.failures = 0;
      // A full batch: more may wait, such as every older meeting's row on the first launch after
      // migration 6.
      if (rows.length === this.batchSize) nextMs = 0;
    } catch (error) {
      this.failures += 1;
      nextMs = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (this.failures - 1));
      this.options.logger.warn('speech-to-text usage upload failed, backing off', {
        failures: this.failures,
        delayMs: nextMs,
        error: errorMessage(error),
      });
    }
    this.schedule(nextMs);
  }

  /**
   * Sends one row and marks it, unless it was saved again while the request was out: then the mark
   * does not land (TranscriptStore.markSttUsageSynced) and the newer row goes on the next pass.
   */
  private async send(usage: MeetingSttUsage): Promise<void> {
    const { api, store, logger } = this.options;
    const { meetingId } = usage;
    try {
      await api.saveMeetingUsage(usage);
      logger.debug('speech-to-text usage uploaded', { meetingId });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 422)) throw error;
      logger.warn('speech-to-text usage refused by the API, not sent again until it changes', {
        meetingId,
        reason: error.message,
      });
    }
    store.markSttUsageSynced(usage, this.clock().toISOString());
  }
}
