import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ITEM_SCHEMA_VERSION,
  type ItemRecord,
  decodeItem,
  encodeItem,
  itemPaths,
  listItemIds,
  readItem,
  writeItem,
} from './item';

const ITEM: ItemRecord = {
  schemaVersion: ITEM_SCHEMA_VERSION,
  id: 'standup-1006',
  origin: 'backup',
  meetingId: '0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b',
  window: { fromMs: 750_000, toMs: 900_000 },
  recordedOn: '2026-10-06',
  kind: 'standup',
  setup: 'speakers',
  streams: ['mic', 'system'],
  gaps: [{ source: 'system', startMs: 12_000, endMs: 13_500 }],
  participants: [
    { name: 'Ana Lopez', consentOn: '2026-10-05' },
    { name: 'Rahul', consentOn: '2026-10-06' },
  ],
  draftRuns: ['run-a', 'run-c'],
};

/** ITEM as item.json holds it, with one change, for the refusal cases. */
function fileWith(change: (file: Record<string, unknown>) => void): string {
  const file = JSON.parse(encodeItem(ITEM)) as Record<string, unknown>;
  change(file);
  return JSON.stringify(file);
}

describe('item.json', () => {
  it('round-trips an item', () => {
    expect(decodeItem(encodeItem(ITEM), 'item.json')).toEqual(ITEM);
  });

  it('writes the field names the plan gives the file', () => {
    expect(JSON.parse(encodeItem(ITEM))).toEqual({
      schema_version: 1,
      id: 'standup-1006',
      origin: 'backup',
      meeting_id: '0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b',
      window: { from_ms: 750_000, to_ms: 900_000 },
      recorded_on: '2026-10-06',
      kind: 'standup',
      setup: 'speakers',
      streams: ['mic', 'system'],
      gaps: [{ source: 'system', start_ms: 12_000, end_ms: 13_500 }],
      participants: [
        { name: 'Ana Lopez', consent_on: '2026-10-05' },
        { name: 'Rahul', consent_on: '2026-10-06' },
      ],
      draft_runs: ['run-a', 'run-c'],
    });
  });

  it('reads a system-only meet-recording item with no meeting id', () => {
    const meet: ItemRecord = {
      ...ITEM,
      id: 'meet-0930',
      origin: 'meet-recording',
      meetingId: null,
      streams: ['system'],
      gaps: [],
    };

    expect(decodeItem(encodeItem(meet), 'item.json')).toEqual(meet);
  });

  it('refuses a bad field by its path, naming the file', () => {
    const bad = (change: (file: Record<string, unknown>) => void): (() => ItemRecord) => {
      const text = fileWith(change);
      return () => decodeItem(text, 'items/a/item.json');
    };

    expect(bad((file) => (file.schema_version = 2))).toThrow(
      'items/a/item.json: schema_version 2 is not supported; this bench reads 1',
    );
    expect(bad((file) => (file.origin = 'drive'))).toThrow(
      'items/a/item.json: origin must be one of backup, meet-recording',
    );
    expect(bad((file) => (file.setup = 'airpods'))).toThrow(
      'items/a/item.json: setup must be one of headphones, speakers, unknown',
    );
    expect(bad((file) => (file.recorded_on = '2026-02-30'))).toThrow(
      'items/a/item.json: recorded_on must be a date written YYYY-MM-DD',
    );
    expect(
      bad((file) => ((file.participants as Record<string, unknown>[])[1]!.consent_on = '')),
    ).toThrow('items/a/item.json: participants[1].consent_on must be a date written YYYY-MM-DD');
    expect(
      bad((file) => ((file.participants as Record<string, unknown>[])[0]!.name = '  ')),
    ).toThrow('items/a/item.json: participants[0].name must not be blank');
    expect(bad((file) => (file.window = { from_ms: 5000, to_ms: 5000 }))).toThrow(
      'items/a/item.json: window.to_ms must be after window.from_ms',
    );
    expect(bad((file) => (file.streams = []))).toThrow(
      'items/a/item.json: streams must list mic, system or both, once each',
    );
    expect(bad((file) => (file.streams = ['system', 'system']))).toThrow(
      'items/a/item.json: streams must list mic, system or both, once each',
    );
    expect(bad((file) => (file.draft_runs = ['../x']))).toThrow(
      'items/a/item.json: draft_runs[0] must be a bench id',
    );
    expect(() => decodeItem('{"id": "a", "name": "secret', 'items/a/item.json')).toThrow(
      'items/a/item.json: not valid JSON',
    );
    expect(() => decodeItem('{"id": "a", "name": "secret', 'items/a/item.json')).not.toThrow(
      /secret/,
    );
  });

  it('refuses a backup item with no meeting, and a meet recording with a mic stream', () => {
    expect(() =>
      decodeItem(
        fileWith((file) => (file.meeting_id = null)),
        'item.json',
      ),
    ).toThrow('item.json: meeting_id must name the meeting a backup item was clipped from');
    expect(() =>
      decodeItem(
        fileWith((file) => {
          file.origin = 'meet-recording';
          file.meeting_id = null;
          file.gaps = [];
        }),
        'item.json',
      ),
    ).toThrow(
      'item.json: streams must be only system on a meet-recording item (Meet mixes everyone)',
    );
  });

  it('refuses a gap outside the item or on a stream it does not have', () => {
    expect(() =>
      decodeItem(
        fileWith((file) => (file.gaps = [{ source: 'mic', start_ms: 149_000, end_ms: 150_001 }])),
        'item.json',
      ),
    ).toThrow('item.json: gaps[0] must lie inside the item (0 to 150000 ms)');
    expect(() =>
      decodeItem(
        fileWith((file) => {
          file.streams = ['system'];
          file.gaps = [{ source: 'mic', start_ms: 0, end_ms: 1000 }];
        }),
        'item.json',
      ),
    ).toThrow("item.json: gaps[0].source must be one of the item's streams");
  });
});

describe('item files', () => {
  let benchDir = '';

  beforeEach(async () => {
    benchDir = await mkdtemp(join(tmpdir(), 'roger-bench-item-'));
  });

  afterEach(async () => {
    await rm(benchDir, { recursive: true, force: true });
  });

  it('writes item.json readable by its owner only and reads it back', async () => {
    await writeItem(benchDir, ITEM);

    const paths = itemPaths(benchDir, ITEM.id);
    expect(paths.itemJson).toBe(join(benchDir, 'items', 'standup-1006', 'item.json'));
    expect((await stat(paths.itemJson)).mode & 0o777).toBe(0o600);
    expect(await readItem(benchDir, ITEM.id)).toEqual(ITEM);
    expect(await readFile(paths.itemJson, 'utf8')).toMatch(/\n$/);
  });

  it('refuses an item whose id is not its folder name', async () => {
    await writeItem(benchDir, ITEM);
    await mkdir(join(benchDir, 'items', 'copy'));
    await writeFile(join(benchDir, 'items', 'copy', 'item.json'), encodeItem(ITEM));

    await expect(readItem(benchDir, 'copy')).rejects.toThrow(
      'item.json: id "standup-1006" must match its folder name "copy"',
    );
  });

  it('names the files of an item, refusing an id that would leave the bench folder', () => {
    const paths = itemPaths('/bench', 'a.1');

    expect(paths).toMatchObject({
      dir: '/bench/items/a.1',
      listen: '/bench/items/a.1/listen.wav',
      draft: '/bench/items/a.1/reference.draft.txt',
      reference: '/bench/items/a.1/reference.txt',
    });
    expect(paths.wav('mic')).toBe('/bench/items/a.1/mic.wav');
    expect(paths.wav('system')).toBe('/bench/items/a.1/system.wav');
    expect(() => itemPaths('/bench', '../a')).toThrow('item id "../a" must be');
  });

  it('lists item folders in name order, and none when there is no items folder', async () => {
    expect(await listItemIds(benchDir)).toEqual([]);

    await mkdir(join(benchDir, 'items', 'b'), { recursive: true });
    await mkdir(join(benchDir, 'items', 'a'));
    await writeFile(join(benchDir, 'items', 'notes.txt'), 'not an item');

    expect(await listItemIds(benchDir)).toEqual(['a', 'b']);
  });
});
