import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BenchFileError,
  type EventRecord,
  RUN_SCHEMA_VERSION,
  type RunRecord,
  assertBenchId,
  decodeEvents,
  decodeRun,
  encodeEventLine,
  encodeRun,
  readEvents,
  readRun,
  runPaths,
  writeEvents,
  writeRun,
} from './events';

const T0 = Date.UTC(2026, 9, 6, 10, 0, 0);

const EVENTS: EventRecord[] = [
  {
    arrivedAtMs: T0 + 900,
    session: 0,
    event: { type: 'interim', text: 'we ship', startMs: 0, endMs: 640 },
  },
  {
    arrivedAtMs: T0 + 1_400,
    session: 0,
    event: {
      type: 'final',
      text: 'We ship Friday.',
      startMs: 80,
      endMs: 1_020,
      confidence: null,
      words: [
        { text: 'We', startMs: 80, endMs: 240, confidence: 0.98 },
        { text: 'ship', startMs: 260, endMs: 600, confidence: null },
        { text: 'Friday.', startMs: 620, endMs: 1_020, confidence: 0.91 },
      ],
    },
  },
  {
    arrivedAtMs: T0 + 1_500,
    session: 1,
    event: { type: 'error', message: 'socket closed (3009)', fatal: true },
  },
  { arrivedAtMs: T0 + 1_600, session: 1, event: { type: 'closed', code: null, reason: null } },
  { arrivedAtMs: T0 + 1_700, session: 1, event: { type: 'closed', code: 1000, reason: 'done' } },
];

const RUN: RunRecord = {
  schemaVersion: RUN_SCHEMA_VERSION,
  runId: '2026-10-06T1000-assemblyai',
  startedAt: '2026-10-06T10:00:00.000Z',
  finishedAt: '2026-10-06T10:11:30.000Z',
  provider: 'assemblyai',
  model: 'universal-streaming-english',
  adapterQuery: 'sample_rate=16000&encoding=pcm_s16le&speech_model=universal-streaming-english',
  keyterms: { enabled: true, terms: ['Linkt', 'Roger'] },
  normaliserVersion: 1,
  echoFilterVersion: 1,
  gate: true,
  items: [
    {
      itemId: 'standup-1006',
      status: 'ok',
      attempts: [
        {
          tokenRequestedAtMs: T0,
          tokenReceivedAtMs: T0 + 120,
          pricePerHourUsd: 0.19,
          error: 'Too many concurrent sessions (3009)',
          streams: [],
        },
        {
          tokenRequestedAtMs: T0 + 5_000,
          tokenReceivedAtMs: T0 + 5_110,
          pricePerHourUsd: 0.19,
          error: null,
          streams: [
            {
              source: 'mic',
              replayStartedAtMs: T0 + 5_400,
              sessions: [
                {
                  cause: 'start',
                  itemOffsetMs: 0,
                  openedAtMs: T0 + 5_120,
                  readyAtMs: T0 + 5_390,
                  closedAtMs: T0 + 70_000,
                  connectedMs: 64_880,
                  backlogMs: 0,
                },
                {
                  cause: 'gate',
                  itemOffsetMs: 101_000,
                  openedAtMs: T0 + 106_500,
                  readyAtMs: T0 + 106_750,
                  closedAtMs: null,
                  connectedMs: 40_000,
                  backlogMs: 1_250,
                },
              ],
            },
            {
              source: 'system',
              replayStartedAtMs: T0 + 5_400,
              sessions: [
                {
                  cause: 'start',
                  itemOffsetMs: 0,
                  openedAtMs: T0 + 5_120,
                  readyAtMs: null,
                  closedAtMs: T0 + 160_000,
                  connectedMs: 154_880,
                  backlogMs: 0,
                },
              ],
            },
          ],
        },
      ],
    },
    {
      itemId: 'one-to-one.b',
      status: 'failed',
      attempts: [
        {
          tokenRequestedAtMs: T0 + 200_000,
          tokenReceivedAtMs: null,
          pricePerHourUsd: null,
          error: 'token request failed: 503',
          streams: [],
        },
      ],
    },
  ],
};

/** A deep copy of RUN with one change, for the refusal cases. */
function runWith(change: (run: Record<string, unknown>) => void): string {
  const copy = JSON.parse(JSON.stringify(RUN)) as Record<string, unknown>;
  change(copy);
  return JSON.stringify(copy);
}

/** The first item's attempts of a copied run, typed loosely for edits. */
const attemptsOf = (run: Record<string, unknown>): Record<string, unknown>[] =>
  ((run.items as Record<string, unknown>[])[0]?.attempts ?? []) as Record<string, unknown>[];

describe('events.jsonl', () => {
  it('round-trips every kind of SttEvent with its arrival time and session', () => {
    const text = EVENTS.map(encodeEventLine).join('');

    expect(text.split('\n')).toHaveLength(EVENTS.length + 1);
    expect(decodeEvents(text, 'mic.events.jsonl')).toEqual(EVENTS);
  });

  it('reads CRLF and blank lines', () => {
    const text = EVENTS.map(encodeEventLine).join('\r\n');

    expect(decodeEvents(`\n${text}\n\n`, 'mic.events.jsonl')).toEqual(EVENTS);
  });

  it('refuses a bad line by its number and field, without repeating its text', () => {
    const good = encodeEventLine(EVENTS[0]!);
    const bad =
      (line: string): (() => EventRecord[]) =>
      () =>
        decodeEvents(`${good}${line}\n`, 'run/a/mic.events.jsonl');

    expect(
      bad('{"arrivedAtMs": 1, "session": 0, "event": {"type": "final", "text": "secret"'),
    ).toThrow('run/a/mic.events.jsonl:2: not valid JSON');
    expect(bad('{"secret plans": tru')).not.toThrow(/secret/);
    expect(
      bad('{"arrivedAtMs": 1, "session": 0, "event": {"type": "partial", "text": "x"}}'),
    ).toThrow('run/a/mic.events.jsonl:2: event.type must be one of interim, final, error, closed');
    expect(
      bad(
        '{"arrivedAtMs": 1, "session": 0, "event": {"type": "interim", "text": "x", "startMs": 0}}',
      ),
    ).toThrow('run/a/mic.events.jsonl:2: event.endMs must be a finite number');
    expect(
      bad(
        '{"arrivedAtMs": 1, "session": -1, "event": {"type": "closed", "code": null, "reason": null}}',
      ),
    ).toThrow('run/a/mic.events.jsonl:2: session must be a whole number of 0 or more');
    expect(bad('[1, 2]')).toThrow(BenchFileError);
  });

  it('refuses to write an event a reader would refuse, such as a NaN time', () => {
    expect(() => encodeEventLine({ ...EVENTS[0]!, arrivedAtMs: Number.NaN })).toThrow(
      'event to write: arrivedAtMs must be a finite number',
    );
  });
});

describe('run.json', () => {
  it('round-trips a whole run', () => {
    expect(decodeRun(encodeRun(RUN), 'run.json')).toEqual(RUN);
  });

  it('refuses another schema version by number', () => {
    expect(() =>
      decodeRun(
        runWith((run) => (run.schemaVersion = 2)),
        'runs/r/run.json',
      ),
    ).toThrow('runs/r/run.json: schemaVersion 2 is not supported; this bench reads 1');
  });

  it('refuses a missing or mistyped field, naming its path', () => {
    expect(() =>
      decodeRun(
        runWith((run) => delete run.provider),
        'run.json',
      ),
    ).toThrow('run.json: provider must be a string');
    expect(() =>
      decodeRun(
        runWith((run) => {
          const streams = attemptsOf(run)[1]?.streams as Record<string, unknown>[];
          if (streams[0]) streams[0].source = 'speaker';
        }),
        'run.json',
      ),
    ).toThrow('run.json: items[0].attempts[1].streams[0].source must be one of mic, system');
    expect(() =>
      decodeRun(
        runWith((run) => {
          const attempt = attemptsOf(run)[0];
          if (attempt) attempt.pricePerHourUsd = '0.19';
        }),
        'run.json',
      ),
    ).toThrow('run.json: items[0].attempts[0].pricePerHourUsd must be a finite number or null');
  });

  it('refuses attempts that contradict the item status', () => {
    expect(() =>
      decodeRun(
        runWith((run) => {
          const attempt = attemptsOf(run)[1];
          if (attempt) attempt.error = 'late failure';
        }),
        'run.json',
      ),
    ).toThrow('run.json: items[0] is ok, so its last attempt must have no error');
    expect(() =>
      decodeRun(
        runWith((run) => {
          const attempt = attemptsOf(run)[0];
          if (attempt) attempt.error = null;
        }),
        'run.json',
      ),
    ).toThrow('run.json: items[0].attempts[0] was retried, so it must name its error');
    expect(() =>
      decodeRun(
        runWith((run) => {
          const item = (run.items as Record<string, unknown>[])[1];
          if (item) item.attempts = [];
        }),
        'run.json',
      ),
    ).toThrow('run.json: items[1] has no attempts');
  });

  it('refuses two items with one id, and an id that is not a safe file name', () => {
    expect(() =>
      decodeRun(
        runWith((run) => {
          const items = run.items as Record<string, unknown>[];
          if (items[1]) items[1].itemId = 'standup-1006';
        }),
        'run.json',
      ),
    ).toThrow('run.json: items[1].itemId "standup-1006" appears twice');
    expect(() =>
      decodeRun(
        runWith((run) => {
          const items = run.items as Record<string, unknown>[];
          if (items[0]) items[0].itemId = '../escape';
        }),
        'run.json',
      ),
    ).toThrow('run.json: items[0].itemId must be a bench id');
  });

  it('refuses text that is not JSON without repeating it', () => {
    const read = (): RunRecord => decodeRun('{"provider": "secret plans', 'run.json');

    expect(read).toThrow('run.json: not valid JSON');
    expect(read).not.toThrow(/secret/);
  });
});

describe('files and layout', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'roger-bench-events-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lays out run files under runs/<run-id>', () => {
    const paths = runPaths('/bench', 'run-1');

    expect(paths.dir).toBe(join('/bench', 'runs', 'run-1'));
    expect(paths.runJson).toBe(join('/bench', 'runs', 'run-1', 'run.json'));
    expect(paths.itemDir('standup-1006')).toBe(join('/bench', 'runs', 'run-1', 'standup-1006'));
    expect(paths.events('standup-1006', 'system')).toBe(
      join('/bench', 'runs', 'run-1', 'standup-1006', 'system.events.jsonl'),
    );
  });

  it('refuses ids that could leave their folder or hide', () => {
    for (const id of ['', '.', '..', '../x', 'a/b', 'a\\b', '.hidden', 'x'.repeat(65)]) {
      expect(() => {
        assertBenchId(id, 'item id');
      }).toThrow(
        `item id ${JSON.stringify(id)} must be 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit`,
      );
    }
    expect(() => runPaths('/bench', '../up')).toThrow('run id "../up" must be');
    expect(() => runPaths('/bench', 'ok').events('a/b', 'mic')).toThrow('item id "a/b" must be');
    expect(() => {
      assertBenchId('standup-1006_v2.b', 'item id');
    }).not.toThrow();
  });

  it('writes and reads both files, readable by their owner only', async () => {
    const paths = runPaths(dir, RUN.runId);
    const eventsPath = paths.events('standup-1006', 'mic');
    await writeEvents(eventsPath, EVENTS);
    await writeRun(paths.runJson, RUN);

    expect(await readEvents(eventsPath)).toEqual(EVENTS);
    expect(await readRun(paths.runJson)).toEqual(RUN);
    expect((await stat(eventsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.runJson)).mode & 0o777).toBe(0o600);
    expect(await readFile(paths.runJson, 'utf8')).toMatch(/^\{\n {2}"schemaVersion": 1,/);
  });

  it('names the path of a file it refuses', async () => {
    const path = join(dir, 'run.json');
    await writeFile(path, '{}');

    await expect(readRun(path)).rejects.toThrow(`${path}: schemaVersion`);
  });
});
