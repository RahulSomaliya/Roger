import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUN_SCHEMA_VERSION,
  type RunItem,
  type RunRecord,
  readRun,
  runPaths,
  writeEvents,
  writeRun,
} from '../core/events';
import { forget } from './forget';
import { ITEM_SCHEMA_VERSION, type ItemRecord, itemPaths, listItemIds, writeItem } from './item';

const MEETING_A = '0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b';
const MEETING_B = '7d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a';

describe('forget', () => {
  let benchDir = '';

  function item(id: string, meetingId: string, names: string[]): ItemRecord {
    return {
      schemaVersion: ITEM_SCHEMA_VERSION,
      id,
      origin: 'backup',
      meetingId,
      window: { fromMs: 0, toMs: 150_000 },
      recordedOn: '2026-10-06',
      kind: 'standup',
      setup: 'headphones',
      streams: ['mic', 'system'],
      gaps: [],
      participants: names.map((name) => ({ name, consentOn: '2026-10-05' })),
      draftRuns: [],
    };
  }

  function runItem(itemId: string): RunItem {
    return {
      itemId,
      status: 'ok',
      attempts: [
        {
          tokenRequestedAtMs: 1,
          tokenReceivedAtMs: 2,
          pricePerHourUsd: 0.15,
          error: null,
          streams: [],
        },
      ],
    };
  }

  /** A run over `itemIds` with an events file per item, as `bench run` leaves it. */
  async function saveRun(runId: string, itemIds: string[]): Promise<void> {
    const run: RunRecord = {
      schemaVersion: RUN_SCHEMA_VERSION,
      runId,
      startedAt: '2026-10-06T10:00:00.000Z',
      finishedAt: '2026-10-06T10:10:00.000Z',
      provider: 'assemblyai',
      model: 'universal-streaming-english',
      adapterQuery: null,
      keyterms: { enabled: true, terms: [] },
      normaliserVersion: 1,
      echoFilterVersion: 1,
      gate: false,
      items: itemIds.map(runItem),
    };
    const paths = runPaths(benchDir, runId);
    await writeRun(paths.runJson, run);
    for (const itemId of itemIds) {
      await writeEvents(paths.events(itemId, 'mic'), [
        { arrivedAtMs: 3, session: 0, event: { type: 'closed', code: 1000, reason: null } },
      ]);
    }
  }

  beforeEach(async () => {
    benchDir = await mkdtemp(join(tmpdir(), 'roger-bench-forget-'));
    await writeItem(benchDir, item('standup-1', MEETING_A, ['Ana Lopez', 'Rahul']));
    await writeItem(benchDir, item('standup-2', MEETING_B, ['Rahul']));
    await writeItem(benchDir, item('one-to-one', MEETING_B, ['Bob']));
    await saveRun('r1', ['standup-1', 'standup-2', 'one-to-one']);
    await saveRun('r2', ['standup-1']);
    await mkdir(join(benchDir, 'reports'));
    await writeFile(join(benchDir, 'reports', 'r1.json'), '{"pooledWer": 0.12}');
  });

  afterEach(async () => {
    await rm(benchDir, { recursive: true, force: true });
  });

  it("removes that person's items and their run outputs, and keeps the others", async () => {
    const result = await forget(benchDir, { person: '  ana   LOPEZ ' });

    expect(result).toEqual({
      deleted: [{ itemId: 'standup-1', runs: ['r1', 'r2'] }],
      unchecked: [],
      names: ['Ana Lopez', 'Bob', 'Rahul'],
    });
    expect(await listItemIds(benchDir)).toEqual(['one-to-one', 'standup-2']);
    expect(existsSync(runPaths(benchDir, 'r1').itemDir('standup-1'))).toBe(false);
    expect(existsSync(runPaths(benchDir, 'r2').itemDir('standup-1'))).toBe(false);
    expect(existsSync(runPaths(benchDir, 'r1').itemDir('standup-2'))).toBe(true);
    // run.json no longer lists it, so the run still scores without its events.
    expect(
      (await readRun(runPaths(benchDir, 'r1').runJson)).items.map((entry) => entry.itemId),
    ).toEqual(['standup-2', 'one-to-one']);
    expect((await readRun(runPaths(benchDir, 'r2').runJson)).items).toEqual([]);
    // Aggregate reports stay.
    expect(existsSync(join(benchDir, 'reports', 'r1.json'))).toBe(true);
  });

  it('removes every item holding the person, whoever else is on it', async () => {
    const result = await forget(benchDir, { person: 'Rahul' });

    expect(result.deleted.map((entry) => entry.itemId)).toEqual(['standup-1', 'standup-2']);
    expect(await listItemIds(benchDir)).toEqual(['one-to-one']);
  });

  it('removes every item clipped from a meeting', async () => {
    const result = await forget(benchDir, { meetingId: MEETING_B.toUpperCase() });

    expect(result.deleted).toEqual([
      { itemId: 'one-to-one', runs: ['r1'] },
      { itemId: 'standup-2', runs: ['r1'] },
    ]);
    expect(await listItemIds(benchDir)).toEqual(['standup-1']);
  });

  it('deletes nothing for a name on no item, and lists the names on file', async () => {
    const result = await forget(benchDir, { person: 'Ana Lopes' });

    expect(result).toEqual({ deleted: [], unchecked: [], names: ['Ana Lopez', 'Bob', 'Rahul'] });
    expect(await listItemIds(benchDir)).toHaveLength(3);
  });

  it('reports what it could not read instead of skipping it, and still deletes the rest', async () => {
    await mkdir(join(benchDir, 'items', 'half-clipped'));
    await writeFile(runPaths(benchDir, 'r2').runJson, '{"not": "a run"}');

    const result = await forget(benchDir, { person: 'Ana Lopez' });

    expect(result.deleted).toEqual([{ itemId: 'standup-1', runs: ['r1', 'r2'] }]);
    expect(result.unchecked.map((entry) => entry.what)).toEqual([
      itemPaths(benchDir, 'half-clipped').dir,
      runPaths(benchDir, 'r2').runJson,
    ]);
    expect(result.unchecked[0]?.reason).toBe(
      'no item.json: a clip that did not finish; delete the folder and clip again',
    );
    expect(result.unchecked[1]?.reason).toContain('schemaVersion must be a finite number');
    expect(existsSync(runPaths(benchDir, 'r2').itemDir('standup-1'))).toBe(false);
    expect(existsSync(itemPaths(benchDir, 'standup-1').dir)).toBe(false);
  });

  it('lists run outputs whose item folder was deleted by hand, and keeps them', async () => {
    // As clip advises to clip an item again; its outputs in r1 stay behind.
    await rm(itemPaths(benchDir, 'standup-2').dir, { recursive: true });

    const result = await forget(benchDir, { person: 'Ana Lopez' });

    expect(result.deleted).toEqual([{ itemId: 'standup-1', runs: ['r1', 'r2'] }]);
    expect(result.unchecked).toEqual([
      {
        what: runPaths(benchDir, 'r1').itemDir('standup-2'),
        reason: 'no item standup-2 in items/ says who it holds',
      },
    ]);
    // Never deleted on a guess: it may hold someone else, kept with their consent.
    expect(existsSync(runPaths(benchDir, 'r1').itemDir('standup-2'))).toBe(true);
  });

  it('refuses a blank person or meeting', async () => {
    await expect(forget(benchDir, { person: ' ' })).rejects.toThrow(
      'forget needs --person <name> or --meeting <id>',
    );
    await expect(forget(benchDir, { meetingId: '' })).rejects.toThrow(
      'forget needs --person <name> or --meeting <id>',
    );
  });
});
