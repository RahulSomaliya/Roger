import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeWav } from '../core/wav';
import { itemPaths, listItems, readItem, readItemAudio, readItemReference } from './items';

describe('bench items', () => {
  let bench = '';

  beforeEach(async () => {
    bench = await mkdtemp(join(tmpdir(), 'roger-bench-items-'));
  });

  afterEach(async () => {
    await rm(bench, { recursive: true, force: true });
  });

  async function makeItem(
    id: string,
    manifest: Record<string, unknown>,
    wavs: readonly ('mic' | 'system')[],
  ): Promise<void> {
    const paths = itemPaths(bench, id);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.itemJson, JSON.stringify({ id, ...manifest }));
    for (const source of wavs) await writeFile(paths.wav(source), encodeWav(new Int16Array(1600)));
  }

  it("reads an item's origin, setup and the streams it has", async () => {
    await makeItem('standup-1006', { origin: 'backup', setup: 'speakers' }, ['mic', 'system']);

    const item = await readItem(bench, 'standup-1006');

    expect(item).toEqual({
      id: 'standup-1006',
      dir: join(bench, 'items', 'standup-1006'),
      origin: 'backup',
      setup: 'speakers',
      sources: ['mic', 'system'],
    });
    const audio = await readItemAudio(item);
    expect(audio.get('mic')).toHaveLength(1600);
    expect(audio.get('system')).toHaveLength(1600);
  });

  it('gives a meet recording its system stream only and refuses one with a mic file', async () => {
    await makeItem('meet-1', { origin: 'meet-recording', setup: 'unknown' }, ['system']);
    await makeItem('meet-2', { origin: 'meet-recording', setup: 'unknown' }, ['mic', 'system']);

    expect((await readItem(bench, 'meet-1')).sources).toEqual(['system']);
    await expect(readItem(bench, 'meet-2')).rejects.toThrow(
      /meet-recording item has no mic stream; delete .*mic\.wav/,
    );
  });

  it('refuses an item with no audio, no item.json, or an unknown origin or setup', async () => {
    await makeItem('silent', { origin: 'backup', setup: 'headphones' }, []);
    await mkdir(itemPaths(bench, 'bare').dir, { recursive: true });
    await makeItem('odd-origin', { origin: 'zoom', setup: 'headphones' }, ['mic']);
    await makeItem('odd-setup', { origin: 'backup', setup: 'airpods' }, ['mic']);

    await expect(readItem(bench, 'silent')).rejects.toThrow(/no mic\.wav or system\.wav/);
    await expect(readItem(bench, 'bare')).rejects.toThrow(/item\.json: missing/);
    await expect(readItem(bench, 'odd-origin')).rejects.toThrow(
      /origin must be one of backup, meet-recording/,
    );
    await expect(readItem(bench, 'odd-setup')).rejects.toThrow(
      /setup must be one of headphones, speakers, unknown/,
    );
  });

  it('lists every item folder by name, skipping loose files', async () => {
    await makeItem('b-item', { origin: 'backup', setup: 'speakers' }, ['mic', 'system']);
    await makeItem('a-item', { origin: 'backup', setup: 'headphones' }, ['mic', 'system']);
    await writeFile(join(bench, 'items', '.DS_Store'), '');

    expect((await listItems(bench, null)).map((item) => item.id)).toEqual(['a-item', 'b-item']);
    expect((await listItems(bench, ['b-item'])).map((item) => item.id)).toEqual(['b-item']);
  });

  it('names every requested item that does not exist', async () => {
    await makeItem('a-item', { origin: 'backup', setup: 'headphones' }, ['mic']);

    await expect(listItems(bench, ['a-item', 'nope', 'gone'])).rejects.toThrow(
      'no such items in ' + join(bench, 'items') + ': nope, gone',
    );
  });

  it('says how to make items when there are none', async () => {
    await expect(listItems(bench, null)).rejects.toThrow(/no items in .*bench clip/);
    await mkdir(join(bench, 'items'));
    await expect(listItems(bench, null)).rejects.toThrow(/no items in .*bench clip/);
  });

  it('reads the reference, or null when the item has none yet', async () => {
    await makeItem('a-item', { origin: 'backup', setup: 'headphones' }, ['mic']);
    const item = await readItem(bench, 'a-item');

    expect(await readItemReference(item)).toBeNull();
    await writeFile(itemPaths(bench, 'a-item').reference, '[00:01] Me: hello\n');
    expect(await readItemReference(item)).toBe('[00:01] Me: hello\n');
  });
});
