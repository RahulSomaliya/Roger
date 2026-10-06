import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COST_GUARDS } from '../../src/main/costGuards';
import { createLogger } from '../../src/main/logger';
import { BOOTSTRAP_SEED } from '../core/bootstrap';
import { readRun, runPaths, writeRun } from '../core/events';
import { registryAdapters } from '../run/adapters';
import { runBench } from '../run/run';
import { tone, writeTestItem } from '../run/testing/benchFolder';
import { ScriptedTokenApi, tokenResponse } from '../run/testing/fakes';
import { ManualTimers } from '../run/testing/manualTimers';
import {
  REPORT_VERSION,
  buildReport,
  readSummaryRows,
  renderReportMarkdown,
  renderSummary,
  scoreRuns,
} from './report';
import { T0, at, finalEvent, runFixture } from './testing/runFixture';

const SCORED_AT = '2026-10-06T11:00:00.000Z';

/** Item A: Me said exactly; Them got one inserted word. Item B: a meet recording, Them only. */
function twoItems(): ReturnType<typeof runFixture> {
  return runFixture(
    [
      {
        id: 'item-a',
        reference:
          '[00:00] Me: we ship the quokka build on friday\n[00:04] Them: sounds good to me\n',
        streams: {
          mic: [at(3_500, finalEvent('we ship the quokka build on friday', 0))],
          system: [at(6_000, finalEvent('sounds good to me too', 4_000))],
        },
      },
      {
        id: 'item-b',
        origin: 'meet-recording',
        setup: 'unknown',
        reference: '[00:00] Them: the zebrafish demo is ready\n',
        streams: { system: [at(2_500, finalEvent('the zebra fish demo is ready', 0))] },
      },
    ],
    { keyterms: ['Quokka', 'Zebrafish'] },
  );
}

describe('buildReport', () => {
  it('pools WER by summing errors and words, Me after the filter and Them apart', () => {
    const { run, inputs } = twoItems();

    const report = buildReport(run, inputs, { echoFilter: true, scoredAt: SCORED_AT });

    expect(report.wer.pooled).toMatchObject({ errors: 3, referenceWords: 16, rate: 3 / 16 });
    expect(report.wer.me).toEqual({ errors: 0, referenceWords: 7, rate: 0 });
    expect(report.wer.meRawMic).toEqual({ errors: 0, referenceWords: 7, rate: 0 });
    expect(report.wer.them).toEqual({ errors: 3, referenceWords: 9, rate: 3 / 9 });
    expect(report.wer.pooled.interval95).toMatchObject({ seed: BOOTSTRAP_SEED });
    expect(report.items).toEqual({
      total: 2,
      scored: 2,
      retried: 0,
      failed: 0,
      leftOut: [],
      // The meet recording is scored on Them only; the report says how many there were.
      scoredByOrigin: { backup: 1, 'meet-recording': 1 },
    });
  });

  it('counts jargon recall and false alarms on the text the user sees', () => {
    const { run, inputs } = twoItems();

    const report = buildReport(run, inputs, { echoFilter: true, scoredAt: SCORED_AT });

    expect(report.terms).toEqual({
      referenceCount: 2,
      recalled: 1,
      falseAlarms: 0,
      recall: 0.5,
      unscorable: [],
    });
  });

  it("measures each stream's word latency with the app's meter, on the replay clock", () => {
    const { run, inputs } = runFixture([
      {
        id: 'item-a',
        reference: '[00:00] Me: one two\n',
        streams: {
          mic: [
            at(900, { type: 'interim', text: 'one two', startMs: 0, endMs: 760 }),
            at(1_400, finalEvent('one two', 0)),
          ],
          system: [],
        },
      },
    ]);

    const report = buildReport(run, inputs, { echoFilter: true, scoredAt: SCORED_AT });

    // Words end at 360 and 760 ms; the interim showed both at 900 ms, the final came at 1 400 ms.
    expect(report.latency.mic).toMatchObject({
      words: 2,
      displayP50Ms: 150,
      // Percentiles round up to their 50 ms bucket but never past the longest wait.
      displayP95Ms: 540,
      finalP50Ms: 650,
      finalP95Ms: 1_040,
      longestWaitMs: 540,
    });
    expect(report.latency.system.words).toBe(0);
  });

  it('keeps a meet recording out of Me and out of the mic latency', () => {
    const { run, inputs } = twoItems();

    const report = buildReport(run, inputs, { echoFilter: true, scoredAt: SCORED_AT });

    expect(report.latency.mic.words).toBe(7);
    expect(report.latency.system.words).toBe(11);
    expect(report.wer.me.referenceWords).toBe(7);
  });

  it('without the filter, leaves speaker items out of the pooled number and says so', () => {
    const { run, inputs } = runFixture([
      {
        id: 'speakers-1',
        setup: 'speakers',
        reference: '[00:00] Me: we ship on friday\n[00:03] Them: sounds good\n',
        streams: {
          mic: [at(2_000, finalEvent('we ship on friday', 0))],
          system: [at(4_000, finalEvent('sounds good', 3_000))],
        },
      },
      {
        id: 'headphones-1',
        reference: '[00:00] Me: hello there\n',
        streams: { mic: [at(1_000, finalEvent('hello there', 0))], system: [] },
      },
    ]);

    const report = buildReport(run, inputs, { echoFilter: false, scoredAt: SCORED_AT });

    expect(report.echoFilter).toBe(false);
    expect(report.wer.pooled).toMatchObject({ errors: 0, referenceWords: 2 });
    expect(report.wer.me.referenceWords).toBe(2);
    expect(report.wer.meRawMic.referenceWords).toBe(6);
    expect(report.wer.them.referenceWords).toBe(2);
    expect(report.items.leftOut).toEqual([
      {
        itemId: 'speakers-1',
        reason:
          'speakers: Me needs the echo filter, which this score ran without ' +
          '(--no-echo-filter); left out of Me and the pooled WER',
      },
    ]);
    expect(renderReportMarkdown(report)).toContain('left out of Me and the pooled WER');
  });

  it('lists failed, retried and left-out items with the reason, never their text', () => {
    const { run, inputs } = runFixture([
      {
        id: 'ok-retried',
        reference: '[00:00] Them: fine\n',
        streams: { system: [] },
        failedAttempts: 1,
      },
      {
        id: 'failed',
        status: 'failed',
        failedAttempts: 2,
        reference: null,
        streams: { system: [] },
      },
      { id: 'no-reference', reference: null, streams: { system: [] } },
      { id: 'unfixed', reference: '[00:00] Them: {a | b}\n', streams: { system: [] } },
      { id: 'forgotten', deleted: true, streams: { system: [] } },
      { id: 'mislabelled', reference: '[00:00] Me: hello\n', streams: { system: [] } },
    ]);

    const report = buildReport(run, inputs, { echoFilter: true, scoredAt: SCORED_AT });

    expect(report.items).toEqual({
      total: 6,
      scored: 1,
      retried: 2,
      failed: 1,
      scoredByOrigin: { backup: 1, 'meet-recording': 0 },
      leftOut: [
        { itemId: 'failed', reason: 'failed after 3 attempts' },
        { itemId: 'no-reference', reason: 'no reference.txt yet' },
        { itemId: 'unfixed', reason: 'reference.txt has 1 problem; run bench check' },
        { itemId: 'forgotten', reason: 'no longer in the items folder' },
        {
          itemId: 'mislabelled',
          reason: 'the reference has Me lines but the item has no mic stream',
        },
      ],
    });
  });

  it("prices every session at its own token's price", () => {
    const { run, inputs } = runFixture([
      // 30 min of audio on each of two streams, each session billed 31 min at $0.19 an hour.
      {
        id: 'a',
        audioMs: 1_800_000,
        connectedMs: 1_860_000,
        streams: { mic: [], system: [] },
      },
      // Another token's price: $0.45 an hour, 10 min on one stream.
      {
        id: 'b',
        audioMs: 600_000,
        connectedMs: 600_000,
        pricePerHourUsd: 0.45,
        streams: { system: [] },
      },
    ]);

    const report = buildReport(run, inputs, { echoFilter: true, scoredAt: SCORED_AT });

    const costUsd = 2 * (31 / 60) * 0.19 + (10 / 60) * 0.45;
    expect(report.cost.streamHours).toBeCloseTo(2 * (31 / 60) + 10 / 60, 6);
    expect(report.cost.estimatedCostUsd).toBeCloseTo(costUsd, 4);
    // Two streams make a meeting: 70 min of stream audio is 35 min of meeting.
    expect(report.cost.costPerMeetingHourUsd).toBeCloseTo(costUsd / (35 / 60), 3);
    expect(report.cost.unknownPrice).toEqual([]);
  });

  it('reports an unknown price as unknown, naming the items, never as $0', () => {
    const { run, inputs } = runFixture([
      { id: 'priced', streams: { system: [] } },
      { id: 'unpriced', pricePerHourUsd: null, streams: { system: [] } },
    ]);

    const report = buildReport(run, inputs, { echoFilter: true, scoredAt: SCORED_AT });

    expect(report.cost.estimatedCostUsd).toBeNull();
    expect(report.cost.costPerMeetingHourUsd).toBeNull();
    expect(report.cost.unknownPrice).toEqual(['unpriced']);
    expect(renderReportMarkdown(report)).toContain('unknown (no price for unpriced)');
    expect(report.summary.costPerMeetingHourUsd).toBeNull();
  });

  it('writes no transcript text into the report or the summary', () => {
    const { run, inputs } = twoItems();
    const report = buildReport(run, inputs, { echoFilter: true, scoredAt: SCORED_AT });

    const outputs = [
      renderReportMarkdown(report),
      renderSummary([report.summary]),
      JSON.stringify(report),
    ];

    for (const output of outputs) {
      for (const word of ['quokka', 'zebrafish', 'zebra', 'friday', 'sounds', 'demo']) {
        expect(output.toLowerCase()).not.toContain(word);
      }
    }
  });
});

describe('renderSummary', () => {
  it('prints one row per configuration for the research doc', () => {
    const { run, inputs } = twoItems();
    const report = buildReport(run, inputs, { echoFilter: true, scoredAt: SCORED_AT });

    const table = renderSummary([report.summary]);

    const rows = table.split('\n').filter((line) => line.startsWith('| 2026'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(
      '| 20261006-100000 | assemblyai | universal-streaming-english | on |',
    );
    expect(rows[0]).toContain('| 18.8% (');
  });
});

describe('scoreRuns and readSummaryRows', () => {
  let bench = '';

  beforeEach(async () => {
    bench = await mkdtemp(join(tmpdir(), 'roger-bench-report-'));
  });

  afterEach(async () => {
    await rm(bench, { recursive: true, force: true });
  });

  it('runs the fake adapter end to end into a report and a summary row', async () => {
    await writeTestItem(bench, 'fake-1', {
      audio: { mic: tone(4_000), system: tone(4_000) },
      reference: '[00:00] Me: hello\n[00:00] Them: hello\n',
    });
    const timers = new ManualTimers(T0);
    const lines: string[] = [];
    const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
    const outcome = await timers.settle(
      runBench(
        { itemIds: null, keyterms: true, parallel: 3 },
        {
          benchDir: bench,
          api: new ScriptedTokenApi(
            tokenResponse({ provider: 'fake', model: 'fake', token: '', pricePerHourUsd: 0 }),
          ),
          adapters: registryAdapters({ logger, guards: DEFAULT_COST_GUARDS }),
          opensPerMinute: 4,
          retryBackoffMs: { first: 2_000, max: 60_000 },
          timers,
          out: (line) => lines.push(line),
        },
      ),
    );
    expect(outcome).toMatchObject({ ok: 1, failed: 0, stopped: null });

    const { reports } = await scoreRuns(bench, {
      runId: null,
      echoFilter: true,
      scoredAt: SCORED_AT,
    });

    expect(reports.map((report) => report.runId)).toEqual([outcome.runId]);
    const markdown = await readFile(join(bench, 'reports', `${outcome.runId}.md`), 'utf8');
    expect(markdown).toContain('fake fake');
    expect((await stat(join(bench, 'reports', `${outcome.runId}.json`))).mode & 0o777).toBe(0o600);
    const rows = await readSummaryRows(bench);
    expect(rows.map((row) => [row.runId, row.provider, row.itemsScored])).toEqual([
      [outcome.runId, 'fake', 1],
    ]);
    expect(reports[0]?.items).toMatchObject({ total: 1, scored: 1, failed: 0 });
  });

  it('refuses to score a run that did not finish, and skips it when scoring every run', async () => {
    const { run } = twoItems();
    await writeRun(runPaths(bench, run.runId).runJson, { ...run, finishedAt: null });

    await expect(
      scoreRuns(bench, { runId: run.runId, echoFilter: true, scoredAt: SCORED_AT }),
    ).rejects.toThrow(/run 20261006-100000 did not finish/);
    expect(await scoreRuns(bench, { runId: null, echoFilter: true, scoredAt: SCORED_AT })).toEqual({
      reports: [],
      skipped: [{ runId: run.runId, reason: 'did not finish (stopped, or still running)' }],
    });
    expect((await readRun(runPaths(bench, run.runId).runJson)).finishedAt).toBeNull();
  });

  it('refuses a report file it cannot read, naming it', async () => {
    const { run, inputs } = twoItems();
    const report = buildReport(run, inputs, { echoFilter: true, scoredAt: SCORED_AT });
    const broken = { ...report, summary: { ...report.summary, pooledWer: 'low' } };
    await mkdir(join(bench, 'reports'));
    await writeFile(join(bench, 'reports', 'bad.json'), JSON.stringify(broken));

    await expect(readSummaryRows(bench)).rejects.toThrow(/bad\.json: summary\.pooledWer/);
    expect(REPORT_VERSION).toBe(1);
  });
});
