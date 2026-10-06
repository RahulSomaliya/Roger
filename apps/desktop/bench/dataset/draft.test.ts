import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type EventRecord,
  RUN_SCHEMA_VERSION,
  type RunItem,
  type RunRecord,
  runPaths,
  writeEvents,
  writeRun,
} from '../core/events';
import { parseReference } from '../core/reference';
import { type DraftStream, draft, draftReference } from './draft';
import { ITEM_SCHEMA_VERSION, type ItemRecord, itemPaths, readItem, writeItem } from './item';

const me = (a: [number, string][], b: [number, string][]): DraftStream => ({
  speaker: 'me',
  a: a.map(([atMs, text]) => ({ atMs, text })),
  b: b.map(([atMs, text]) => ({ atMs, text })),
});
const them = (a: [number, string][], b: [number, string][]): DraftStream => ({
  ...me(a, b),
  speaker: 'them',
});

describe('draftReference', () => {
  it('writes the first run as it is where both runs agree', () => {
    expect(draftReference([me([[0, 'We ship Friday.']], [[0, 'we ship friday']])])).toBe(
      '[00:00] Me: We ship Friday.\n',
    );
  });

  it('puts only the words the runs disagree on in braces, first run first', () => {
    expect(
      draftReference([me([[0, 'We ship Friday to Acme.']], [[0, 'We ship today to Acme.']])]),
    ).toBe('[00:00] Me: We ship {Friday | today} to Acme.\n');
  });

  it('marks words only one run heard, with an empty side', () => {
    expect(draftReference([me([[0, 'see you']], [[0, 'see you tomorrow']])])).toBe(
      '[00:00] Me: see you { | tomorrow}\n',
    );
    expect(draftReference([me([[0, 'see you tomorrow']], [[0, 'see you']])])).toBe(
      '[00:00] Me: see you {tomorrow | }\n',
    );
  });

  it('marks nothing that reads the same after the normaliser', () => {
    expect(
      draftReference([
        me(
          [[0, 'It costs $5, OK? Twenty-five people, um, joined.']],
          [[0, 'it costs five dollars okay 25 people joined']],
        ),
      ]),
    ).toBe('[00:00] Me: It costs $5, OK? Twenty-five people, um, joined.\n');
  });

  it("keeps the first run's lines, with braces where the runs split words differently", () => {
    expect(
      draftReference([
        me(
          [
            [0, 'we ship'],
            [4000, 'on Friday'],
          ],
          [[0, 'we ship on Monday']],
        ),
      ]),
    ).toBe('[00:00] Me: we ship\n[00:04] Me: on {Friday | Monday}\n');
    expect(draftReference([me([[2000, 'ship it']], [[0, 'okay ship it']])])).toBe(
      '[00:02] Me: { | okay} ship it\n',
    );
  });

  it('puts Me and Them in time order, Me first on a tie', () => {
    const lines: [number, string][] = [
      [0, 'hi there'],
      [10_000, 'bye now'],
    ];
    const themLines: [number, string][] = [
      [5_000, 'hello'],
      [10_000, 'later'],
    ];

    expect(draftReference([them(themLines, themLines), me(lines, lines)])).toBe(
      [
        '[00:00] Me: hi there',
        '[00:05] Them: hello',
        '[00:10] Me: bye now',
        '[00:10] Them: later',
        '',
      ].join('\n'),
    );
  });

  it("writes the second run's lines in braces on a stream the first run heard nothing on", () => {
    expect(
      draftReference([
        them(
          [],
          [
            [3000, 'only the second run'],
            [9000, 'heard this'],
          ],
        ),
      ]),
    ).toBe('[00:03] Them: { | only the second run}\n[00:09] Them: { | heard this}\n');
  });

  it('writes a draft whose braces are the only problems check reports', () => {
    const text = draftReference([me([[0, 'we ship Friday']], [[0, 'we ship Monday']])]);

    expect(parseReference(text).problems.map((problem) => problem.kind)).toEqual(['brace']);
  });
});

describe('draft', () => {
  let benchDir = '';
  const T0 = Date.UTC(2026, 9, 6, 10, 0, 0);

  function item(id: string, change: Partial<ItemRecord> = {}): ItemRecord {
    return {
      schemaVersion: ITEM_SCHEMA_VERSION,
      id,
      origin: 'backup',
      meetingId: '0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b',
      window: { fromMs: 0, toMs: 150_000 },
      recordedOn: '2026-10-06',
      kind: 'standup',
      setup: 'headphones',
      streams: ['mic', 'system'],
      gaps: [],
      participants: [{ name: 'Ana Lopez', consentOn: '2026-10-05' }],
      draftRuns: [],
      ...change,
    };
  }

  function runItem(itemId: string, sessions: number[] = [0]): RunItem {
    return {
      itemId,
      status: 'ok',
      attempts: [
        {
          tokenRequestedAtMs: T0,
          tokenReceivedAtMs: T0 + 100,
          pricePerHourUsd: 0.15,
          error: null,
          streams: (['mic', 'system'] as const).map((source) => ({
            source,
            replayStartedAtMs: T0 + 500,
            sessions: sessions.map((itemOffsetMs, index) => ({
              cause: index === 0 ? ('start' as const) : ('gate' as const),
              itemOffsetMs,
              openedAtMs: T0 + 200 + itemOffsetMs,
              readyAtMs: T0 + 400 + itemOffsetMs,
              closedAtMs: T0 + 150_000,
              connectedMs: 1000,
              backlogMs: 0,
            })),
          })),
        },
      ],
    };
  }

  async function saveRun(runId: string, items: RunItem[]): Promise<void> {
    const run: RunRecord = {
      schemaVersion: RUN_SCHEMA_VERSION,
      runId,
      startedAt: '2026-10-06T10:00:00.000Z',
      finishedAt: '2026-10-06T10:10:00.000Z',
      provider: runId === 'r1' ? 'deepgram' : 'assemblyai',
      model: 'model',
      adapterQuery: null,
      keyterms: { enabled: true, terms: [] },
      normaliserVersion: 1,
      echoFilterVersion: 1,
      gate: false,
      items,
    };
    await writeRun(runPaths(benchDir, runId).runJson, run);
  }

  /** Finals at item time `atMs` in session 0, plus one interim that must be ignored. */
  async function saveFinals(
    runId: string,
    itemId: string,
    source: 'mic' | 'system',
    finals: [number, string][],
    session = 0,
  ): Promise<void> {
    const records: EventRecord[] = finals.flatMap(([atMs, text]) => [
      {
        arrivedAtMs: T0 + atMs + 500,
        session,
        event: { type: 'interim', text: 'not this', startMs: atMs, endMs: atMs + 500 },
      },
      {
        arrivedAtMs: T0 + atMs + 900,
        session,
        event: {
          type: 'final',
          text,
          startMs: atMs,
          endMs: atMs + 800,
          confidence: null,
          words: [],
        },
      },
    ]);
    await writeEvents(runPaths(benchDir, runId).events(itemId, source), records);
  }

  beforeEach(async () => {
    benchDir = await mkdtemp(join(tmpdir(), 'roger-bench-draft-'));
  });

  afterEach(async () => {
    await rm(benchDir, { recursive: true, force: true });
  });

  it('drafts every item without a reference.txt and records the runs it used', async () => {
    await writeItem(benchDir, item('standup'));
    await writeItem(
      benchDir,
      item('meet', { origin: 'meet-recording', meetingId: null, streams: ['system'] }),
    );
    await writeItem(benchDir, item('fixed'));
    await writeFile(itemPaths(benchDir, 'fixed').reference, '[00:00] Me: done by hand\n');
    // A gate reopen: session 1's stream time 0 is item time 60 s.
    await saveRun('r1', [runItem('standup', [0, 60_000]), runItem('meet'), runItem('fixed')]);
    await saveRun('r2', [runItem('standup'), runItem('meet'), runItem('fixed')]);
    await saveFinals('r1', 'standup', 'mic', [[0, 'morning all']]);
    await saveFinals('r2', 'standup', 'mic', [
      [0, 'morning all'],
      [61_000, 'any blockers'],
    ]);
    await saveFinals('r1', 'standup', 'system', [[2000, 'morning Rahul']]);
    await saveFinals('r2', 'standup', 'system', [[2000, 'morning Raul']]);
    // r1's mic events after the reopen sit in session 1, at stream time 1 s.
    const reopened: EventRecord = {
      arrivedAtMs: T0 + 62_000,
      session: 1,
      event: {
        type: 'final',
        text: 'any blockers',
        startMs: 1000,
        endMs: 1800,
        confidence: null,
        words: [],
      },
    };
    const micPath = runPaths(benchDir, 'r1').events('standup', 'mic');
    await writeFile(micPath, `${await readFile(micPath, 'utf8')}${JSON.stringify(reopened)}\n`);
    await saveFinals('r1', 'meet', 'system', [[0, 'welcome everyone']]);
    await saveFinals('r2', 'meet', 'system', [[0, 'welcome everyone']]);

    const result = await draft(benchDir, ['r1', 'r2']);

    expect(result).toEqual({ drafted: ['meet', 'standup'], withReference: ['fixed'], failed: [] });
    expect(await readFile(itemPaths(benchDir, 'standup').draft, 'utf8')).toBe(
      [
        '[00:00] Me: morning all',
        '[00:02] Them: morning {Rahul | Raul}',
        '[01:01] Me: any blockers',
        '',
      ].join('\n'),
    );
    expect(await readFile(itemPaths(benchDir, 'meet').draft, 'utf8')).toBe(
      '[00:00] Them: welcome everyone\n',
    );
    expect((await stat(itemPaths(benchDir, 'standup').draft)).mode & 0o777).toBe(0o600);
    expect((await readItem(benchDir, 'standup')).draftRuns).toEqual(['r1', 'r2']);
    expect((await readItem(benchDir, 'fixed')).draftRuns).toEqual([]);
  });

  it('reports an item a run did not finish, and drafts the others', async () => {
    await writeItem(benchDir, item('ok-item', { streams: ['system'] }));
    await writeItem(benchDir, item('lost', { streams: ['system'] }));
    const failedItem: RunItem = {
      itemId: 'lost',
      status: 'failed',
      attempts: [{ ...runItem('lost').attempts[0]!, error: 'socket closed (3009)', streams: [] }],
    };
    await saveRun('r1', [runItem('ok-item'), runItem('lost')]);
    await saveRun('r2', [runItem('ok-item'), failedItem]);
    await saveFinals('r1', 'ok-item', 'system', [[0, 'fine']]);
    await saveFinals('r2', 'ok-item', 'system', [[0, 'fine']]);

    const result = await draft(benchDir, ['r1', 'r2']);

    expect(result).toEqual({
      drafted: ['ok-item'],
      withReference: [],
      failed: [{ itemId: 'lost', reason: 'run r2 has no finished attempt for it' }],
    });
  });

  it('refuses one run twice, and names a run that is not there', async () => {
    await expect(draft(benchDir, ['r1', 'r1'])).rejects.toThrow(
      'draft takes two different runs: --runs <a>,<b>',
    );
    await expect(draft(benchDir, ['r1', 'missing'])).rejects.toThrow(
      runPaths(benchDir, 'r1').runJson,
    );
  });
});
