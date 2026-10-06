import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isFiniteNumber, isRecord } from '../../src/main/stt/json';
import { AUDIO_SOURCES, type AudioSource } from '../../src/shared/transcript';
import { BenchFileError, assertBenchId } from '../core/events';
import { writePrivateFile } from '../core/files';

/**
 * A test-set item, `items/<item-id>/item.json`, and the files beside it. `bench clip` writes it,
 * `bench draft` adds the runs it drafted from, `check`, `forget` and the runner read it. The file
 * uses the plan's snake_case names (M3 plan, "Item format"), so an item made by hand from a Meet
 * recording reads the same; this module maps them to camelCase. Nothing under the bench folder is
 * ever committed: these are recordings of real people (M3 D2).
 *
 *   items/<item-id>/
 *     item.json             ItemRecord
 *     mic.wav, system.wav   16 kHz mono PCM16, one per stream in `streams`
 *     listen.wav            stereo, mic left, system right; for listening only, never scored
 *     reference.draft.txt   from `bench draft`
 *     reference.txt         fixed by hand
 *
 * Errors name the file and the field, never a value that could be a person's words.
 */

/** Bumped whenever a field changes meaning or is added; the reader refuses every other version. */
export const ITEM_SCHEMA_VERSION = 1;

export const ITEM_ORIGINS = ['backup', 'meet-recording'] as const;
export type ItemOrigin = (typeof ITEM_ORIGINS)[number];

export const ITEM_KINDS = ['standup', 'one-to-one', 'group', 'other'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * How the owner heard the call. Scoring runs M2's echo filter over Me on `speakers` (laptop
 * speakers put Them on the mic), not on `headphones`, as the app does (M3 design, "Scoring").
 */
export const ITEM_SETUPS = ['headphones', 'speakers', 'unknown'] as const;
export type ItemSetup = (typeof ITEM_SETUPS)[number];

export interface ItemRecord {
  schemaVersion: typeof ITEM_SCHEMA_VERSION;
  /** The folder name under items/. */
  id: string;
  /** `backup`: clipped from the app's audio backup. `meet-recording`: a Meet recording, by hand. */
  origin: ItemOrigin;
  /** The meeting a backup item was clipped from; null on a meet-recording item. */
  meetingId: string | null;
  /** The clipped stretch, in the source's own time (meeting time for a backup item). */
  window: { fromMs: number; toMs: number };
  /** The local date of the call, YYYY-MM-DD. */
  recordedOn: string;
  kind: ItemKind;
  setup: ItemSetup;
  /** The streams that have a WAV file, in AUDIO_SOURCES order. Only `system` on a Meet recording. */
  streams: AudioSource[];
  /** Stretches of a stream with no backup audio, filled with silence; in item time (0 = window start). */
  gaps: ItemGap[];
  /** Everyone heard on the item, with the date they agreed to its keeping (M3 D2). */
  participants: Participant[];
  /** The two runs `bench draft` aligned to write reference.draft.txt, in brace order; empty before. */
  draftRuns: string[];
}

export interface ItemGap {
  source: AudioSource;
  startMs: number;
  endMs: number;
}

export interface Participant {
  name: string;
  /** YYYY-MM-DD. */
  consentOn: string;
}

export interface ItemPaths {
  dir: string;
  itemJson: string;
  listen: string;
  draft: string;
  reference: string;
  wav(source: AudioSource): string;
}

/** Where an item's files live under the bench folder. The id is checked before it joins a path. */
export function itemPaths(benchDir: string, itemId: string): ItemPaths {
  assertBenchId(itemId, 'item id');
  const dir = join(benchDir, 'items', itemId);
  return {
    dir,
    itemJson: join(dir, 'item.json'),
    listen: join(dir, 'listen.wav'),
    draft: join(dir, 'reference.draft.txt'),
    reference: join(dir, 'reference.txt'),
    wav: (source) => join(dir, `${source}.wav`),
  };
}

/**
 * The folder names under items/, in name order; none when there is no items folder yet. Every
 * folder is listed, even one with no item.json or a bad name, so `check` and `forget` can report it
 * instead of skipping it in silence.
 */
export async function listItemIds(benchDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(benchDir, 'items'), { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** An item's item.json; refuses one whose id is not its folder name (a copied folder). */
export async function readItem(benchDir: string, itemId: string): Promise<ItemRecord> {
  const path = itemPaths(benchDir, itemId).itemJson;
  const item = decodeItem(await readFile(path, 'utf8'), path);
  if (item.id !== itemId) {
    throw new BenchFileError(
      path,
      `id ${JSON.stringify(item.id)} must match its folder name ${JSON.stringify(itemId)}`,
    );
  }
  return item;
}

export async function writeItem(benchDir: string, item: ItemRecord): Promise<void> {
  await writePrivateFile(itemPaths(benchDir, item.id).itemJson, encodeItem(item));
}

/** item.json as written: indented, newline at the end. Refuses an item the reader would refuse. */
export function encodeItem(item: ItemRecord): string {
  const text = `${JSON.stringify(
    {
      schema_version: item.schemaVersion,
      id: item.id,
      origin: item.origin,
      meeting_id: item.meetingId,
      window: { from_ms: item.window.fromMs, to_ms: item.window.toMs },
      recorded_on: item.recordedOn,
      kind: item.kind,
      setup: item.setup,
      streams: item.streams,
      gaps: item.gaps.map((gap) => ({
        source: gap.source,
        start_ms: gap.startMs,
        end_ms: gap.endMs,
      })),
      participants: item.participants.map((person) => ({
        name: person.name,
        consent_on: person.consentOn,
      })),
      draft_runs: item.draftRuns,
    },
    null,
    2,
  )}\n`;
  decodeItem(text, 'item to write');
  return text;
}

export function decodeItem(text: string, label: string): ItemRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Not the parser's message: V8 quotes the input around the fault, and a hand-edited item.json
    // holds people's names.
    throw new BenchFileError(label, 'not valid JSON');
  }
  return parseItem(new Fields(value, '', label));
}

/** True when `date` is a real calendar day written YYYY-MM-DD. */
export function isIsoDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  // Date.parse rolls 2026-02-30 over to March 2; a real day reads back unchanged.
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

/** Typed reads from one JSON object, each naming its field's path when it refuses. */
class Fields {
  private readonly value: Record<string, unknown>;

  constructor(
    value: unknown,
    readonly path: string,
    private readonly label: string,
  ) {
    if (!isRecord(value)) {
      throw new BenchFileError(label, `${path === '' ? 'the item' : path} must be a JSON object`);
    }
    this.value = value;
  }

  fail(problem: string, key?: string): never {
    throw new BenchFileError(
      this.label,
      `${key === undefined ? this.path : this.at(key)} ${problem}`,
    );
  }

  at(key: string): string {
    return this.path === '' ? key : `${this.path}.${key}`;
  }

  get(key: string): unknown {
    // Own fields only: a missing "constructor" must not read as Object.prototype's.
    return Object.hasOwn(this.value, key) ? this.value[key] : undefined;
  }

  wholeMs(key: string): number {
    const value = this.get(key);
    if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) {
      this.fail('must be a whole number of ms, 0 or more', key);
    }
    return value;
  }

  string(key: string): string {
    const value = this.get(key);
    if (typeof value !== 'string') this.fail('must be a string', key);
    return value;
  }

  date(key: string): string {
    const value = this.get(key);
    if (typeof value !== 'string' || !isIsoDate(value)) {
      this.fail('must be a date written YYYY-MM-DD', key);
    }
    return value;
  }

  oneOf<T extends string>(key: string, allowed: readonly T[]): T {
    const value = this.get(key);
    const match = allowed.find((option) => option === value);
    if (match === undefined) this.fail(`must be one of ${allowed.join(', ')}`, key);
    return match;
  }

  list(key: string): unknown[] {
    const value = this.get(key);
    if (!Array.isArray(value)) this.fail('must be a list', key);
    return value;
  }

  objects(key: string): Fields[] {
    return this.list(key).map(
      (item, index) => new Fields(item, `${this.at(key)}[${index}]`, this.label),
    );
  }

  object(key: string): Fields {
    return new Fields(this.get(key), this.at(key), this.label);
  }
}

function parseItem(file: Fields): ItemRecord {
  const version = file.get('schema_version');
  if (version !== ITEM_SCHEMA_VERSION) {
    file.fail(
      `${JSON.stringify(version)} is not supported; this bench reads ${ITEM_SCHEMA_VERSION}`,
      'schema_version',
    );
  }
  const id = file.string('id');
  try {
    assertBenchId(id, 'id');
  } catch {
    file.fail('must be a bench id', 'id');
  }
  const origin = file.oneOf('origin', ITEM_ORIGINS);
  const meetingId = parseMeetingId(file, origin);

  const windowFields = file.object('window');
  const window = { fromMs: windowFields.wholeMs('from_ms'), toMs: windowFields.wholeMs('to_ms') };
  if (window.toMs <= window.fromMs) windowFields.fail('must be after window.from_ms', 'to_ms');

  const streams = parseStreams(file, origin);
  const lengthMs = window.toMs - window.fromMs;
  const gaps = file.objects('gaps').map((gap) => {
    const source = gap.oneOf('source', AUDIO_SOURCES);
    if (!streams.includes(source)) gap.fail("must be one of the item's streams", 'source');
    const startMs = gap.wholeMs('start_ms');
    const endMs = gap.wholeMs('end_ms');
    if (endMs <= startMs || endMs > lengthMs) {
      gap.fail(`must lie inside the item (0 to ${lengthMs} ms)`);
    }
    return { source, startMs, endMs };
  });

  const participants = file.objects('participants').map((person) => {
    const name = person.string('name');
    if (name.trim() === '') person.fail('must not be blank', 'name');
    return { name, consentOn: person.date('consent_on') };
  });

  const draftRuns = file.list('draft_runs').map((run, index) => {
    if (typeof run !== 'string') file.fail('must be a bench id', `draft_runs[${index}]`);
    try {
      assertBenchId(run, 'run id');
    } catch {
      file.fail('must be a bench id', `draft_runs[${index}]`);
    }
    return run;
  });

  return {
    schemaVersion: ITEM_SCHEMA_VERSION,
    id,
    origin,
    meetingId,
    window,
    recordedOn: file.date('recorded_on'),
    kind: file.oneOf('kind', ITEM_KINDS),
    setup: file.oneOf('setup', ITEM_SETUPS),
    streams,
    gaps,
    participants,
    draftRuns,
  };
}

function parseMeetingId(file: Fields, origin: ItemOrigin): string | null {
  const value = file.get('meeting_id');
  if (origin === 'meet-recording') {
    if (value !== null) file.fail('must be null on a meet-recording item', 'meeting_id');
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    file.fail('must name the meeting a backup item was clipped from', 'meeting_id');
  }
  return value;
}

function parseStreams(file: Fields, origin: ItemOrigin): AudioSource[] {
  const listed = file.list('streams');
  const streams = AUDIO_SOURCES.filter((source) => listed.includes(source));
  if (listed.length === 0 || streams.length !== listed.length) {
    file.fail('must list mic, system or both, once each', 'streams');
  }
  if (origin === 'meet-recording' && streams.includes('mic')) {
    file.fail('must be only system on a meet-recording item (Meet mixes everyone)', 'streams');
  }
  return streams;
}
