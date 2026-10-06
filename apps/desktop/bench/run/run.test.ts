import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ECHO_FILTER_VERSION } from '../../src/main/capture/echo/EchoFilter';
import { SttConnectError } from '../../src/main/stt/SpeechToText';
import { readEvents, readRun, runPaths } from '../core/events';
import { NORMALISER_VERSION } from '../core/normalise';
import { MAX_ATTEMPTS, type RunDeps, type RunOptions, runBench } from './run';
import { tone, writeTestItem } from './testing/benchFolder';
import {
  FakeVendor,
  type FakeVendorScript,
  ScriptedTokenApi,
  freshTokens,
  tokenResponse,
} from './testing/fakes';
import { ManualTimers } from './testing/manualTimers';

const T0 = Date.UTC(2026, 9, 6, 10, 0, 0);

describe('runBench', () => {
  let bench = '';

  beforeEach(async () => {
    bench = await mkdtemp(join(tmpdir(), 'roger-bench-run-'));
  });

  afterEach(async () => {
    await rm(bench, { recursive: true, force: true });
  });

  async function items(count: number, ms = 300): Promise<void> {
    for (let index = 1; index <= count; index += 1) {
      await writeTestItem(bench, `item-${index}`, { audio: { mic: tone(ms), system: tone(ms) } });
    }
  }

  function start(
    options: Partial<RunOptions> = {},
    setup: { api?: ScriptedTokenApi; vendor?: FakeVendorScript; opensPerMinute?: number } = {},
  ): {
    timers: ManualTimers;
    vendor: FakeVendor;
    api: ScriptedTokenApi;
    lines: string[];
    done: ReturnType<typeof runBench>;
  } {
    const timers = new ManualTimers(T0);
    const vendor = new FakeVendor(timers, setup.vendor);
    const api = setup.api ?? new ScriptedTokenApi(freshTokens({ pricePerHourUsd: 0.19 }));
    const lines: string[] = [];
    const deps: RunDeps = {
      benchDir: bench,
      api,
      adapters: vendor.adapters,
      opensPerMinute: setup.opensPerMinute ?? 4,
      retryBackoffMs: { first: 2_000, max: 60_000 },
      timers,
      out: (line) => lines.push(line),
    };
    const done = timers.settle(
      runBench({ itemIds: null, keyterms: true, parallel: 3, ...options }, deps),
    );
    return { timers, vendor, api, lines, done };
  }

  it("writes run.json with the first token's label and every item's events", async () => {
    await items(2);
    const { done } = start({}, { vendor: { connectQuery: () => 'speech_model=universal' } });

    const outcome = await done;

    expect(outcome).toMatchObject({ ok: 2, failed: 0, stopped: null });
    const paths = runPaths(bench, outcome.runId);
    expect(outcome.runId).toBe('20261006-100000');
    const run = await readRun(paths.runJson);
    expect(run).toMatchObject({
      runId: '20261006-100000',
      startedAt: '2026-10-06T10:00:00.000Z',
      provider: 'assemblyai',
      model: 'universal-streaming-english',
      adapterQuery: 'speech_model=universal',
      keyterms: { enabled: true, terms: ['Linkt', 'Roger'] },
      normaliserVersion: NORMALISER_VERSION,
      echoFilterVersion: ECHO_FILTER_VERSION,
      gate: false,
    });
    expect(run.finishedAt).not.toBeNull();
    expect(run.items.map((item) => [item.itemId, item.status, item.attempts.length])).toEqual([
      ['item-1', 'ok', 1],
      ['item-2', 'ok', 1],
    ]);
    const closed = await readEvents(paths.events('item-1', 'mic'));
    expect(closed.at(-1)?.event.type).toBe('closed');
    expect((await stat(paths.events('item-1', 'system'))).mode & 0o777).toBe(0o600);
  });

  it('gives each item its own token, so the 4th round of --parallel 3 uses a new one', async () => {
    await items(4);
    const { vendor, api, done } = start();

    await done;

    expect(api.calls).toBe(4);
    const tokens = vendor.streams.map((stream) => stream.options.accessToken);
    expect(new Set(tokens)).toEqual(new Set(['tok-1', 'tok-2', 'tok-3', 'tok-4']));
    // Both streams of an item share its token.
    expect(tokens.filter((token) => token === 'tok-4')).toHaveLength(2);
  });

  it("waits for the bench's open budget: 5 a minute is never exceeded", async () => {
    await items(4);
    const openedAt: number[] = [];
    const { timers, done } = start(
      {},
      {
        opensPerMinute: 5,
        vendor: {
          onOpen: () => {
            openedAt.push(timers.now());
          },
        },
      },
    );

    await done;

    expect(openedAt).toHaveLength(8);
    for (const from of openedAt) {
      expect(openedAt.filter((at) => at >= from && at < from + 60_000).length).toBeLessThanOrEqual(
        5,
      );
    }
  });

  it('retries an injected 3009 with a fresh token and records both attempts', async () => {
    await items(1);
    const { lines, done } = start(
      {},
      {
        vendor: {
          onOpen: (options) => {
            if (options.accessToken === 'tok-1' && options.label === 'system') {
              throw new SttConnectError('AssemblyAI: Too many concurrent sessions (3009)', null);
            }
          },
        },
      },
    );

    const outcome = await done;

    const run = await readRun(runPaths(bench, outcome.runId).runJson);
    const [item] = run.items;
    expect(item?.status).toBe('ok');
    expect(item?.attempts.map((attempt) => attempt.error)).toEqual([
      'system: AssemblyAI: Too many concurrent sessions (3009)',
      null,
    ]);
    // The retry waited the backoff and asked for a new token.
    const [first, second] = item?.attempts ?? [];
    expect(
      (second?.tokenRequestedAtMs ?? 0) - (first?.tokenRequestedAtMs ?? 0),
    ).toBeGreaterThanOrEqual(2_000);
    expect(lines.some((line) => line.includes('attempt 1 of 3 failed'))).toBe(true);
  });

  it(`fails an item after ${MAX_ATTEMPTS} attempts and keeps the other items`, async () => {
    await items(2);
    const { done } = start(
      { parallel: 1 },
      {
        vendor: {
          onOpen: (options) => {
            if (options.label === 'mic' && options.accessToken !== 'tok-4') {
              throw new SttConnectError('Deepgram: rejected with HTTP 503', 503);
            }
          },
        },
      },
    );

    const outcome = await done;

    expect(outcome).toMatchObject({ ok: 1, failed: 1, stopped: null });
    const run = await readRun(runPaths(bench, outcome.runId).runJson);
    expect(run.items.map((item) => [item.itemId, item.status, item.attempts.length])).toEqual([
      ['item-1', 'failed', 3],
      ['item-2', 'ok', 1],
    ]);
    expect(run.finishedAt).not.toBeNull();
  });

  it('stops the run, naming both, when the API changes provider mid-run', async () => {
    await items(3);
    const { lines, done } = start(
      { parallel: 1 },
      {
        api: new ScriptedTokenApi(
          tokenResponse({ token: 'tok-1' }),
          tokenResponse({ token: 'tok-2', provider: 'deepgram', model: 'nova-3' }),
        ),
      },
    );

    const outcome = await done;

    expect(outcome.stopped).toMatch(
      /now serves deepgram nova-3, but this run began on assemblyai universal-streaming-english/,
    );
    const run = await readRun(runPaths(bench, outcome.runId).runJson);
    expect(run.finishedAt).toBeNull();
    expect(run.items.map((item) => item.itemId)).toEqual(['item-1']);
    expect(lines.at(-1)).toMatch(/stopped: the API now serves deepgram nova-3/);
  });

  it('keeps the list in run.json and sends none with --no-keyterms', async () => {
    await items(1);
    const { vendor, done } = start({ keyterms: false });

    const outcome = await done;

    const run = await readRun(runPaths(bench, outcome.runId).runJson);
    expect(run.keyterms).toEqual({ enabled: false, terms: ['Linkt', 'Roger'] });
    expect(vendor.streams.every((stream) => stream.options.settings.keyterms?.length === 0)).toBe(
      true,
    );
  });

  it('runs only the items asked for, and never reuses a run folder', async () => {
    await items(3);

    const first = await start({ itemIds: ['item-2'] }).done;
    const second = await start({ itemIds: ['item-2'] }).done;

    expect(first.runId).toBe('20261006-100000');
    expect(second.runId).toBe('20261006-100000-2');
    const run = await readRun(runPaths(bench, first.runId).runJson);
    expect(run.items.map((item) => item.itemId)).toEqual(['item-2']);
    expect(await readdir(join(bench, 'runs'))).toEqual(['20261006-100000', '20261006-100000-2']);
  });

  it('refuses a clip in the wrong format before any session opens', async () => {
    await items(1);
    await writeFile(join(bench, 'items', 'item-1', 'system.wav'), 'not a wav');
    const { vendor, api, done } = start();

    await expect(done).rejects.toThrow(/system\.wav: not a WAV file/);
    expect(api.calls).toBe(0);
    expect(vendor.opens).toBe(0);
  });

  it('writes nothing when no item ever got a token', async () => {
    await items(1);
    const { done } = start({}, { api: new ScriptedTokenApi(new Error('connection refused')) });

    const outcome = await done;

    expect(outcome).toMatchObject({ ok: 0, failed: 1, runJson: null });
    await expect(readdir(join(bench, 'runs', outcome.runId))).rejects.toThrow(/ENOENT/);
  });
});
