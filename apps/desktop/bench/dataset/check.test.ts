import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { check } from './check';
import { ITEM_SCHEMA_VERSION, type ItemRecord, itemPaths, writeItem } from './item';

describe('check', () => {
  let benchDir = '';

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
      draftRuns: ['r1', 'r2'],
      ...change,
    };
  }

  async function save(record: ItemRecord, reference?: string): Promise<void> {
    await writeItem(benchDir, record);
    if (reference !== undefined)
      await writeFile(itemPaths(benchDir, record.id).reference, reference);
  }

  beforeEach(async () => {
    benchDir = await mkdtemp(join(tmpdir(), 'roger-bench-check-'));
  });

  afterEach(async () => {
    await rm(benchDir, { recursive: true, force: true });
  });

  it('passes items with a clean reference and consent on file', async () => {
    await save(item('a'), '[00:00] Me: morning all\n[00:02] Them: morning\n');
    await save(item('b'), '[00:01] Them: hello\n');

    expect(await check(benchDir)).toEqual({ items: 2, problems: [] });
  });

  it('reports unresolved braces and unknown speakers by line, without their text', async () => {
    await save(
      item('a'),
      [
        '[00:00] Me: we ship on secret-project',
        '',
        '[00:04] Them: on {Friday | Monday} for secret-project',
        '[00:09] Rahul: secret-project is late',
      ].join('\n'),
    );

    const { problems } = await check(benchDir);

    expect(problems.map((problem) => problem.itemId)).toEqual(['a', 'a']);
    expect(problems[0]?.message).toMatch(/^reference\.txt line 3, column 18: unresolved brace/);
    expect(problems[1]?.message).toBe('reference.txt line 4: unknown speaker; use Me or Them');
    expect(JSON.stringify(problems)).not.toMatch(/secret|Friday|Rahul/);
  });

  it('reports empty items: no reference yet, or one with no lines', async () => {
    await save(item('drafted'));
    await writeFile(itemPaths(benchDir, 'drafted').draft, '[00:00] Me: {a | b}\n');
    await save(item('new'));
    await save(item('blank'), '\n\n');

    expect((await check(benchDir)).problems).toEqual([
      { itemId: 'blank', message: 'reference.txt has no lines: an empty item scores nothing' },
      {
        itemId: 'drafted',
        message: 'no reference.txt yet: fix reference.draft.txt and save it as reference.txt',
      },
      { itemId: 'new', message: 'no reference.txt yet: run bench draft, then fix the draft' },
    ]);
  });

  it('reports an item with no participant consent', async () => {
    await save(item('a', { participants: [] }), '[00:00] Me: hi\n');

    expect((await check(benchDir)).problems).toEqual([
      {
        itemId: 'a',
        message:
          "no participant consent recorded: list everyone heard, with the date they agreed, in item.json's participants",
      },
    ]);
  });

  it('reports a line for a stream the item does not have, such as Me on a Meet recording', async () => {
    await save(
      item('meet', { origin: 'meet-recording', meetingId: null, streams: ['system'] }),
      '[00:00] Them: welcome\n[00:03] Me: thanks\n',
    );

    await save(item('mic-only', { streams: ['mic'] }), '[00:00] Them: hello\n[00:01] Me: hi\n');

    expect((await check(benchDir)).problems).toEqual([
      {
        itemId: 'meet',
        message:
          'reference.txt line 2: Me, but the item has no mic stream; label it Them (on a Meet recording every line is Them)',
      },
      {
        itemId: 'mic-only',
        message:
          'reference.txt line 1: Them, but the item has no system stream; it cannot be scored',
      },
    ]);
  });

  it('reports an item it cannot read, and a folder with no item.json', async () => {
    await save(item('good'), '[00:00] Me: hi\n');
    await mkdir(join(benchDir, 'items', 'half-clipped'), { recursive: true });
    await mkdir(join(benchDir, 'items', 'broken'));
    await writeFile(join(benchDir, 'items', 'broken', 'item.json'), '{"id": "broken"}');

    const result = await check(benchDir);

    expect(result.items).toBe(3);
    expect(result.problems.map((problem) => problem.itemId)).toEqual(['broken', 'half-clipped']);
    expect(result.problems[0]?.message).toBe(
      `${itemPaths(benchDir, 'broken').itemJson}: schema_version is missing; this bench reads 1`,
    );
    expect(result.problems[1]?.message).toBe(
      'no item.json: a clip that did not finish; delete the folder and clip again',
    );
  });

  it('reports a reference.txt it cannot read under its item, and still checks the rest', async () => {
    await save(item('a'));
    await mkdir(itemPaths(benchDir, 'a').reference);
    await save(item('b'), '[00:00] Me: {hi | high}\n');

    const result = await check(benchDir);

    expect(result.items).toBe(2);
    expect(result.problems.map((problem) => problem.itemId)).toEqual(['a', 'b']);
    // Node's EISDIR names no path, so the message names the file.
    expect(result.problems[0]?.message).toBe(
      'could not read reference.txt: EISDIR: illegal operation on a directory, read',
    );
    expect(result.problems[1]?.message).toMatch(/^reference\.txt line 1, column 13: unresolved/);
  });

  it('checks nothing in a bench folder with no items', async () => {
    expect(await check(benchDir)).toEqual({ items: 0, problems: [] });
  });
});
