import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SttTokenApi } from '../../src/main/api/ApiClient';
import { ECHO_FILTER_VERSION } from '../../src/main/capture/echo/EchoFilter';
import { errorMessage } from '../../src/main/logger';
import {
  RUN_SCHEMA_VERSION,
  type RunAttempt,
  type RunItem,
  type RunPaths,
  runPaths,
  writeEvents,
  writeRun,
} from '../core/events';
import { NORMALISER_VERSION } from '../core/normalise';
import type { BenchAdapterFactory } from './adapters';
import { BenchCredentialSource, RunStoppedError } from './credentials';
import { type BenchItem, listItems, readItemAudio } from './items';
import { BenchOpener } from './opens';
import { type ItemAttempt, replayItemAttempt } from './replay';
import type { BenchTimers } from './timers';

/**
 * `bench run`: replays every item (or `--items`) through the adapter the API's token names, a few
 * items at a time, and stores what the vendor sent (M3 design, "Benchmark replay" and "Benchmark
 * credentials"). A failed item is retried up to 2 times, each attempt with a fresh token and through
 * the open budget; every attempt and its error goes into run.json, so a vendor is judged on "no
 * item failed after its retries", never on one network blip. Nothing is scored here: `score` reads
 * the files, so a new normaliser rescores old runs.
 */

/** One try and up to 2 retries per item. */
export const MAX_ATTEMPTS = 3;

export interface RunOptions {
  /** Null: every item. */
  itemIds: readonly string[] | null;
  /** False for `--no-keyterms`. */
  keyterms: boolean;
  /**
   * `--gate`: replay through M3-T20's silence gate. Parsed and recorded here so that M3-T20 adds
   * the gated replay in replay.ts alone; until then replay.ts refuses it.
   */
  gate: boolean;
  /** Items replayed at once; each holds one session per stream. */
  parallel: number;
}

export interface RunDeps {
  benchDir: string;
  api: SttTokenApi;
  adapters: BenchAdapterFactory;
  /** The desktop's sttOpensPerMinute: the bench's open budget (opens.ts). */
  opensPerMinute: number;
  /** Wait before a retry, doubling per retry up to `max`: the desktop's reopen backoff. */
  retryBackoffMs: { first: number; max: number };
  timers: BenchTimers;
  /** Progress for the person running it: ids, counts and vendor errors, never transcript text. */
  out: (line: string) => void;
}

export interface RunOutcome {
  runId: string;
  /** Null when no item ever got a token, so there was nothing to label the run with. */
  runJson: string | null;
  ok: number;
  failed: number;
  /** Why the run stopped before its end, or null. */
  stopped: string | null;
}

export async function runBench(options: RunOptions, deps: RunDeps): Promise<RunOutcome> {
  const items = await listItems(deps.benchDir, options.itemIds);
  // Every clip is decoded once before the first session opens: a WAV in the wrong format stops
  // the run here, naming the file, instead of halfway through with sessions billed.
  for (const item of items) await readItemAudio(item);
  const runId = await freeRunId(deps.benchDir, deps.timers.now());
  return new BenchRun(runId, items, options, deps).run();
}

class BenchRun {
  private readonly paths: RunPaths;
  private readonly startedAt: string;
  private readonly credentials: BenchCredentialSource;
  private readonly opener: BenchOpener;
  private readonly abort = new AbortController();
  private readonly finished = new Map<string, RunItem>();
  private adapterQuery: string | null = null;
  private stopped: string | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly runId: string,
    private readonly items: readonly BenchItem[],
    private readonly options: RunOptions,
    private readonly deps: RunDeps,
  ) {
    this.paths = runPaths(deps.benchDir, runId);
    this.startedAt = new Date(deps.timers.now()).toISOString();
    this.credentials = new BenchCredentialSource(deps.api, { keyterms: options.keyterms });
    this.opener = new BenchOpener({ opensPerMinute: deps.opensPerMinute }, deps.timers);
  }

  async run(): Promise<RunOutcome> {
    this.deps.out(
      `run ${this.runId}: ${this.items.length} items, ${this.options.parallel} at a time, ` +
        `keyterms ${this.options.keyterms ? 'on' : 'off'}`,
    );
    const queue = [...this.items];
    const worker = async (): Promise<void> => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        if (this.abort.signal.aborted) return;
        try {
          await this.runItem(item);
        } catch (error) {
          // A disk or code failure: every other item stops too, closing its sessions, before the
          // error is thrown, so no billed session outlives the run.
          this.stop(`${item.id}: ${errorMessage(error)}`);
          throw error;
        }
      }
    };
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(this.options.parallel, this.items.length) }, worker),
    );
    await this.persist(this.stopped === null);
    const crashed = workers.find((result) => result.status === 'rejected');
    if (crashed !== undefined) throw crashed.reason;

    const statuses = [...this.finished.values()].map((item) => item.status);
    const outcome: RunOutcome = {
      runId: this.runId,
      runJson: this.credentials.label === null ? null : this.paths.runJson,
      ok: statuses.filter((status) => status === 'ok').length,
      failed: statuses.filter((status) => status === 'failed').length,
      stopped: this.stopped,
    };
    this.deps.out(summaryLine(outcome));
    return outcome;
  }

  private async runItem(item: BenchItem): Promise<void> {
    const audio = await readItemAudio(item);
    const attempts: RunAttempt[] = [];
    let last: ItemAttempt | null = null;
    for (let number = 1; number <= MAX_ATTEMPTS; number += 1) {
      if (number > 1) await this.deps.timers.sleep(this.backoffMs(number - 1), this.abort.signal);
      if (this.abort.signal.aborted) break;
      try {
        last = await replayItemAttempt({
          item,
          audio,
          credentials: this.credentials,
          opener: this.opener,
          adapters: this.deps.adapters,
          timers: this.deps.timers,
          signal: this.abort.signal,
          gate: this.options.gate,
        });
      } catch (error) {
        if (!(error instanceof RunStoppedError)) throw error;
        this.stop(error.message);
        break;
      }
      attempts.push(last.record);
      this.adapterQuery ??= last.adapterQuery;
      if (last.record.error === null) break;
      this.deps.out(
        `${item.id}: attempt ${number} of ${MAX_ATTEMPTS} failed: ${last.record.error}`,
      );
    }
    // Stopped before its first attempt: the item never ran, so run.json does not list it.
    if (last === null) return;

    await this.writeEvents(item, last);
    const status = last.record.error === null ? 'ok' : 'failed';
    this.finished.set(item.id, { itemId: item.id, status, attempts });
    this.deps.out(
      `${item.id}: ${status}` +
        (attempts.length > 1 ? ` after ${attempts.length} attempts` : '') +
        (status === 'failed' ? ` (${last.record.error ?? ''})` : ''),
    );
    await this.persist(false);
  }

  /** The item's events files hold its last attempt only (core/events.ts); stale ones go. */
  private async writeEvents(item: BenchItem, last: ItemAttempt): Promise<void> {
    for (const source of item.sources) {
      const path = this.paths.events(item.id, source);
      const events = last.events.get(source);
      if (events === undefined) await rm(path, { force: true });
      else await writeEvents(path, events);
    }
  }

  /**
   * Stops every item: a wait for open slots or a backoff ends at once, an item still waiting fetches
   * no token and opens nothing, an open attempt ends early and closes its sessions, and no new
   * attempt starts. Each wait gets `abort.signal`: one without it would hold the stop (and a
   * crash's error) back for up to a minute and then open billed sessions only to close them.
   */
  private stop(reason: string): void {
    if (this.stopped !== null) return;
    this.stopped = reason;
    this.abort.abort(reason);
  }

  private backoffMs(retry: number): number {
    const { first, max } = this.deps.retryBackoffMs;
    return Math.min(first * 2 ** (retry - 1), max);
  }

  /**
   * Writes run.json as it stands, one write at a time. Not before the first token: the run is
   * labelled with its provider and model. A failed write rejects this and every later call, so a
   * run whose record cannot be kept ends loudly.
   */
  private persist(finished: boolean): Promise<void> {
    const write = this.writes.then(() => this.writeRunJson(finished));
    this.writes = write;
    return write;
  }

  private async writeRunJson(finished: boolean): Promise<void> {
    const label = this.credentials.label;
    if (label === null) return;
    await writeRun(this.paths.runJson, {
      schemaVersion: RUN_SCHEMA_VERSION,
      runId: this.runId,
      startedAt: this.startedAt,
      finishedAt: finished ? new Date(this.deps.timers.now()).toISOString() : null,
      provider: label.provider,
      model: label.model,
      adapterQuery: this.adapterQuery,
      keyterms: { enabled: this.options.keyterms, terms: label.terms },
      normaliserVersion: NORMALISER_VERSION,
      echoFilterVersion: ECHO_FILTER_VERSION,
      gate: this.options.gate,
      items: this.items.flatMap((item) => {
        const done = this.finished.get(item.id);
        return done === undefined ? [] : [done];
      }),
    });
  }
}

function summaryLine(outcome: RunOutcome): string {
  const counts = `${outcome.ok} ok, ${outcome.failed} failed`;
  if (outcome.runJson === null) {
    // A stop before the first token (a refused --gate, an open budget no item fits) is not the
    // API's doing: say why, or the owner goes looking at the API.
    const why =
      outcome.stopped === null
        ? 'no item got a token from the API'
        : `stopped before any item got a token: ${outcome.stopped}`;
    return `run ${outcome.runId}: ${why}; nothing was written (${counts})`;
  }
  if (outcome.stopped !== null) {
    return `run ${outcome.runId}: stopped: ${outcome.stopped} (${counts}; ${outcome.runJson})`;
  }
  return `run ${outcome.runId}: ${counts} (${outcome.runJson})`;
}

/** `YYYYMMDD-HHMMSS` in UTC, with `-2`, `-3`, ... when that folder exists: a run is never reused. */
async function freeRunId(benchDir: string, nowMs: number): Promise<string> {
  const base = new Date(nowMs).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  for (let suffix = 1; ; suffix += 1) {
    const runId = suffix === 1 ? base : `${base}-${suffix}`;
    if (!(await exists(join(benchDir, 'runs', runId)))) return runId;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
