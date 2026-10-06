import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUN_SCHEMA_VERSION, runPaths, writeEvents, writeRun } from '../core/events';
import { DEFAULT_USER_DATA_DIR, type DecodeChunk, decodeBackupChunk } from './backup';
import { DATASET_COMMANDS, clipCommand, parseClipArgs } from './commands';
import { ITEM_SCHEMA_VERSION, type ItemRecord, itemPaths, writeItem } from './item';
import { FIXTURE_DIR, FIXTURE_MEETING } from './testing/backupFixture';

describe('dataset commands', () => {
  let benchDir = '';
  let printed: string[] = [];
  const context = (): { benchDir: string; print: (line: string) => void } => ({
    benchDir,
    print: (line) => printed.push(line),
  });

  function item(id: string, change: Partial<ItemRecord> = {}): ItemRecord {
    return {
      schemaVersion: ITEM_SCHEMA_VERSION,
      id,
      origin: 'backup',
      meetingId: FIXTURE_MEETING,
      window: { fromMs: 0, toMs: 150_000 },
      recordedOn: '2026-10-06',
      kind: 'standup',
      setup: 'headphones',
      streams: ['system'],
      gaps: [],
      participants: [{ name: 'Ana Lopez', consentOn: '2026-10-05' }],
      draftRuns: [],
      ...change,
    };
  }

  beforeEach(async () => {
    benchDir = await mkdtemp(join(tmpdir(), 'roger-bench-commands-'));
    printed = [];
  });

  afterEach(async () => {
    await rm(benchDir, { recursive: true, force: true });
  });

  describe('clip', () => {
    it('reads every flag, with the defaults for the optional ones', () => {
      expect(
        parseClipArgs(
          [
            '--meeting',
            FIXTURE_MEETING,
            '--from',
            '12:30',
            '--to',
            '15:00',
            '--name',
            'standup-1006',
            '--person',
            'Ana Lopez:2026-10-05',
            '--person',
            'Rahul:2026-10-06',
          ],
          '/bench',
        ),
      ).toEqual({
        benchDir: '/bench',
        userDataDir: DEFAULT_USER_DATA_DIR,
        meetingId: FIXTURE_MEETING,
        fromMs: 750_000,
        toMs: 900_000,
        itemId: 'standup-1006',
        participants: [
          { name: 'Ana Lopez', consentOn: '2026-10-05' },
          { name: 'Rahul', consentOn: '2026-10-06' },
        ],
        kind: 'other',
        setup: 'unknown',
      });
      expect(
        parseClipArgs(
          [
            '--meeting=m',
            '--from=0:00',
            '--to=2:30',
            '--name=x',
            '--user-data',
            '/tmp/Roger Dev',
            '--kind',
            'one-to-one',
            '--setup',
            'speakers',
          ],
          '/bench',
        ),
      ).toMatchObject({ userDataDir: '/tmp/Roger Dev', kind: 'one-to-one', setup: 'speakers' });
    });

    it('names a missing flag, a bad choice and an unknown flag', () => {
      expect(() => parseClipArgs(['--from', '0:00', '--to', '1:00', '--name', 'x'], '/b')).toThrow(
        'clip needs --meeting <id>',
      );
      expect(() =>
        parseClipArgs(
          ['--meeting', 'm', '--from', '0:00', '--to', '1:00', '--name', 'x', '--setup', 'loud'],
          '/b',
        ),
      ).toThrow('--setup must be one of headphones, speakers, unknown');
      expect(() => parseClipArgs(['--meting', 'm'], '/b')).toThrow("Unknown option '--meting'");
    });

    it('clips the fixture and says what it wrote, and what consent is missing', async () => {
      const decode: DecodeChunk = (chunk, scratchDir) =>
        chunk.format === 'wav'
          ? decodeBackupChunk(chunk, scratchDir)
          : Promise.resolve(new Int16Array(((chunk.endMs ?? 0) - chunk.startMs) * 16));

      const code = await clipCommand(
        [
          '--meeting',
          FIXTURE_MEETING,
          '--from',
          '0:01',
          '--to',
          '0:04',
          '--name',
          'tone-1',
          '--user-data',
          FIXTURE_DIR,
        ],
        context(),
        { assertFileVault: () => Promise.resolve(), decode },
      );

      expect(code).toBe(0);
      expect(printed).toEqual([
        `clipped tone-1: 00:03 of mic and system from meeting ${FIXTURE_MEETING} (00:01 to 00:04)`,
        '  silence fills 2 gaps: mic 00:01 to 00:02, system 00:01 to 00:02',
        '  no participant consent recorded: add each person to item.json before scoring',
        `listen: ${itemPaths(benchDir, 'tone-1').listen}`,
      ]);
    });
  });

  describe('draft', () => {
    it('drafts from --runs <a>,<b>, says how braces read, and fails on an item it skipped', async () => {
      await writeItem(benchDir, item('a'));
      await writeItem(benchDir, item('b'));
      for (const runId of ['r1', 'r2']) {
        await writeRun(runPaths(benchDir, runId).runJson, {
          schemaVersion: RUN_SCHEMA_VERSION,
          runId,
          startedAt: '2026-10-06T10:00:00.000Z',
          finishedAt: null,
          provider: 'fake',
          model: 'fake',
          adapterQuery: null,
          keyterms: { enabled: false, terms: [] },
          normaliserVersion: 1,
          echoFilterVersion: 1,
          gate: false,
          items: [
            {
              itemId: 'a',
              status: 'ok',
              attempts: [
                {
                  tokenRequestedAtMs: 1,
                  tokenReceivedAtMs: 2,
                  pricePerHourUsd: null,
                  error: null,
                  streams: [
                    {
                      source: 'system',
                      replayStartedAtMs: 3,
                      sessions: [
                        {
                          cause: 'start',
                          itemOffsetMs: 0,
                          openedAtMs: 3,
                          readyAtMs: 4,
                          closedAtMs: 5,
                          connectedMs: 2,
                          backlogMs: 0,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        });
        await writeEvents(runPaths(benchDir, runId).events('a', 'system'), [
          {
            arrivedAtMs: 10,
            session: 0,
            event: {
              type: 'final',
              text: 'private words',
              startMs: 0,
              endMs: 500,
              confidence: null,
              words: [],
            },
          },
        ]);
      }

      const code = await DATASET_COMMANDS.draft(['--runs', 'r1, r2'], context());

      expect(code).toBe(1);
      expect(printed).toEqual([
        'drafted 1 item from runs r1 and r2; braces read {r1 | r2}',
        'could not draft b: run r1 has no finished attempt for it',
      ]);
      expect(printed.join('\n')).not.toContain('private');
    });

    it('says which drafts it left alone, and how to draft one again', async () => {
      await writeItem(benchDir, item('a'));
      await writeFile(itemPaths(benchDir, 'a').draft, '[00:00] Them: fixed in place\n');
      for (const runId of ['r1', 'r2']) {
        await writeRun(runPaths(benchDir, runId).runJson, {
          schemaVersion: RUN_SCHEMA_VERSION,
          runId,
          startedAt: '2026-10-06T10:00:00.000Z',
          finishedAt: null,
          provider: 'fake',
          model: 'fake',
          adapterQuery: null,
          keyterms: { enabled: false, terms: [] },
          normaliserVersion: 1,
          echoFilterVersion: 1,
          gate: false,
          items: [],
        });
      }

      expect(await DATASET_COMMANDS.draft(['--runs', 'r1,r2'], context())).toBe(0);
      expect(printed).toEqual([
        'drafted 0 items from runs r1 and r2; braces read {r1 | r2}',
        "left 1 item with a reference.draft.txt as they are; delete an item's draft to draft it again",
      ]);
    });

    it('needs two runs', async () => {
      await expect(DATASET_COMMANDS.draft(['--runs', 'r1'], context())).rejects.toThrow(
        'draft takes two different runs: --runs <a>,<b>',
      );
    });
  });

  describe('check', () => {
    it('prints each problem under its item without the words, and fails', async () => {
      await writeItem(benchDir, item('a'));
      await writeFile(
        itemPaths(benchDir, 'a').reference,
        '[00:00] Them: the {secret | secrets} plan\n',
      );
      await writeItem(benchDir, item('b'));
      await writeFile(itemPaths(benchDir, 'b').reference, '[00:00] Them: fine\n');

      const code = await DATASET_COMMANDS.check([], context());

      expect(code).toBe(1);
      expect(printed).toEqual([
        'a: reference.txt line 1, column 19: unresolved brace from the draft; keep the right words and remove the braces',
        'checked 2 items: 1 problem in 1 item',
      ]);
    });

    it('passes a clean set, and fails an empty one', async () => {
      expect(await DATASET_COMMANDS.check([], context())).toBe(1);
      expect(printed).toEqual([`no items in ${join(benchDir, 'items')}: clip some first`]);

      printed = [];
      await writeItem(benchDir, item('a'));
      await writeFile(itemPaths(benchDir, 'a').reference, '[00:00] Them: fine\n');
      expect(await DATASET_COMMANDS.check([], context())).toBe(0);
      expect(printed).toEqual(['checked 1 item: no problems']);
    });
  });

  describe('forget', () => {
    it('says what it deleted', async () => {
      await writeItem(benchDir, item('a'));

      expect(await DATASET_COMMANDS.forget(['--person', 'ana lopez'], context())).toBe(0);
      expect(printed).toEqual(['deleted item a (no run held it)']);
    });

    it('fails when nothing matched, listing the names on file', async () => {
      await writeItem(benchDir, item('a'));

      expect(await DATASET_COMMANDS.forget(['--person', 'Ana Lopes'], context())).toBe(1);
      expect(printed).toEqual(['no item lists "Ana Lopes"; names on file: Ana Lopez']);
      printed = [];
      expect(
        await DATASET_COMMANDS.forget(
          ['--meeting', '11111111-2222-4333-8444-555555555555'],
          context(),
        ),
      ).toBe(1);
      expect(printed).toEqual([
        'no item was clipped from meeting 11111111-2222-4333-8444-555555555555',
      ]);
    });

    it('takes exactly one of --person and --meeting', async () => {
      const message = 'forget needs --person <name> or --meeting <id>, not both';
      await expect(DATASET_COMMANDS.forget([], context())).rejects.toThrow(message);
      await expect(
        DATASET_COMMANDS.forget(['--person', 'a', '--meeting', 'b'], context()),
      ).rejects.toThrow(message);
    });
  });
});
