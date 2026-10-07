import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EchoOutputRoute } from '../../src/main/capture/echo/EchoFilter';
import { isRecord } from '../../src/main/stt/json';
import { AUDIO_SOURCES, type AudioSource } from '../../src/shared/transcript';
import { BenchFileError, assertBenchId } from '../core/events';
import { readWav } from '../core/wav';

/**
 * The items of the standing test set, as `run` and `score` read them (M3 design, "Item format"):
 *
 *   $ROGER_BENCH_DIR/items/<item-id>/item.json      written by `bench clip` (M3-T12)
 *                                    mic.wav, system.wav   16 kHz mono PCM16
 *                                    reference.txt         fixed by hand
 *
 * Only the two fields of item.json the replay and the scoring need are read, `origin` and `setup`,
 * with the values the plan fixes; every other field is `clip`'s and `check`'s. Which streams an item
 * has is read from its WAV files, so the audio replayed is always the audio present.
 */

export type ItemOrigin = 'backup' | 'meet-recording';
const ITEM_ORIGINS: readonly ItemOrigin[] = ['backup', 'meet-recording'];

/** Where the call audio played: the echo filter's route, as in the app (headphones turn it off). */
export type ItemSetup = EchoOutputRoute;
const ITEM_SETUPS: readonly ItemSetup[] = ['headphones', 'speakers', 'unknown'];

export interface BenchItem {
  id: string;
  dir: string;
  origin: ItemOrigin;
  setup: ItemSetup;
  /** The streams the item has, in AUDIO_SOURCES order. */
  sources: AudioSource[];
}

export interface ItemPaths {
  dir: string;
  itemJson: string;
  reference: string;
  wav(source: AudioSource): string;
}

export function itemPaths(benchDir: string, itemId: string): ItemPaths {
  assertBenchId(itemId, 'item id');
  const dir = join(itemsDir(benchDir), itemId);
  return {
    dir,
    itemJson: join(dir, 'item.json'),
    reference: join(dir, 'reference.txt'),
    wav: (source) => join(dir, `${source}.wav`),
  };
}

export async function readItem(benchDir: string, itemId: string): Promise<BenchItem> {
  const paths = itemPaths(benchDir, itemId);
  const text = await readOptional(paths.itemJson);
  if (text === null) throw new BenchFileError(paths.itemJson, 'missing; clip the item again');
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    // Not the parser's message: V8 quotes the input around the fault.
    throw new BenchFileError(paths.itemJson, 'not valid JSON');
  }
  if (!isRecord(manifest)) throw new BenchFileError(paths.itemJson, 'must be a JSON object');
  const origin = oneOf(manifest.origin, ITEM_ORIGINS, paths.itemJson, 'origin');
  const setup = oneOf(manifest.setup, ITEM_SETUPS, paths.itemJson, 'setup');

  const sources: AudioSource[] = [];
  for (const source of AUDIO_SOURCES) {
    if (await exists(paths.wav(source))) sources.push(source);
  }
  if (sources.length === 0) {
    throw new BenchFileError(paths.dir, 'has no mic.wav or system.wav to replay');
  }
  // Meet mixes everyone on the server, the owner too, so its reference labels every line Them and
  // the item is scored on the system stream only. A mic file here would be replayed and billed for
  // nothing, or scored as Me against a reference that has no Me lines.
  if (origin === 'meet-recording' && sources.includes('mic')) {
    throw new BenchFileError(
      paths.dir,
      `a meet-recording item has no mic stream; delete ${paths.wav('mic')} or fix its origin`,
    );
  }
  return { id: itemId, dir: paths.dir, origin, setup, sources };
}

/** Every item, by folder name, or only the ids given (each must exist). */
export async function listItems(
  benchDir: string,
  only: readonly string[] | null,
): Promise<BenchItem[]> {
  const dir = itemsDir(benchDir);
  let ids: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    ids = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (!isMissing(error)) throw error;
    ids = [];
  }
  if (ids.length === 0) {
    throw new Error(`no items in ${dir}; make some with bench clip (M3 plan, "Item format")`);
  }
  if (only !== null) {
    const missing = only.filter((id) => !ids.includes(id));
    if (missing.length > 0) throw new Error(`no such items in ${dir}: ${missing.join(', ')}`);
    ids = ids.filter((id) => only.includes(id));
  }
  const items: BenchItem[] = [];
  for (const id of ids) items.push(await readItem(benchDir, id));
  return items;
}

/** The samples of each stream the item has. */
export async function readItemAudio(item: BenchItem): Promise<Map<AudioSource, Int16Array>> {
  const audio = new Map<AudioSource, Int16Array>();
  for (const source of item.sources)
    audio.set(source, await readWav(join(item.dir, `${source}.wav`)));
  return audio;
}

/** reference.txt as written, or null while the item has none (not fixed by hand yet). */
export function readItemReference(item: BenchItem): Promise<string | null> {
  return readOptional(join(item.dir, 'reference.txt'));
}

function itemsDir(benchDir: string): string {
  return join(benchDir, 'items');
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  field: string,
): T {
  const match = allowed.find((option) => option === value);
  if (match === undefined) {
    throw new BenchFileError(label, `${field} must be one of ${allowed.join(', ')}`);
  }
  return match;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
