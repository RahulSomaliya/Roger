import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SttEvent } from '../../src/main/stt/SpeechToText';
import { isFiniteNumber, isRecord } from '../../src/main/stt/json';
import { AUDIO_SOURCES, type AudioSource } from '../../src/shared/transcript';
import { writePrivateFile } from './files';

/**
 * The run files of the benchmark and their one reader and writer. `bench run` (M3-T11) writes
 * them, `score` and `report` read them, `draft` and `forget` (M3-T12) read and delete them, and
 * the silence gate's replay (M3-T20) fills the gate fields. They hold what the vendor sent, never
 * a score: `score` works from them every time, so a new normaliser version rescores old runs.
 *
 *   runs/<run-id>/run.json                            RunRecord
 *   runs/<run-id>/<item-id>/{mic,system}.events.jsonl one EventRecord per line
 *
 * An item's events files hold its last attempt only; earlier attempts are listed in run.json with
 * their errors. Every reader validates every field and names the file, line and field it refuses,
 * never the text in it: these files hold transcripts of real people.
 */

/** Bumped whenever a field changes meaning or is added; readers refuse every other version. */
export const RUN_SCHEMA_VERSION = 1;

/** One line of `<source>.events.jsonl`: an event in the order it arrived. */
export interface EventRecord {
  /**
   * Wall-clock epoch ms when the event reached the bench, on the same clock as the replay's
   * capture times (RunStream.replayStartedAtMs), so LatencyMeter can compare them.
   */
  arrivedAtMs: number;
  /** The vendor session that sent it: an index into its RunStream.sessions (0 without the gate). */
  session: number;
  event: SttEvent;
}

export interface RunRecord {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  runId: string;
  /** ISO 8601, UTC. */
  startedAt: string;
  /** Null while the run is going, or when it stopped before its end. */
  finishedAt: string | null;
  /** The vendor id and model of the run's first token; a later token naming others stops the run. */
  provider: string;
  model: string;
  /**
   * The adapter's websocket query without the token, from the core's wire tap. Never the URL: an
   * AssemblyAI URL carries the temporary token. Null for an adapter with no socket (the fake).
   */
  adapterQuery: string | null;
  keyterms: RunKeyterms;
  /** NORMALISER_VERSION and ECHO_FILTER_VERSION when the run was made. */
  normaliserVersion: number;
  echoFilterVersion: number;
  /** `--gate`: every stream went through the silence gate (M3-T20). */
  gate: boolean;
  items: RunItem[];
}

export interface RunKeyterms {
  /** False for `--no-keyterms`, which sends an empty list. */
  enabled: boolean;
  /** The workspace's jargon list from the first token, scored for term recall either way. */
  terms: string[];
}

export type RunItemStatus = 'ok' | 'failed';

export interface RunItem {
  itemId: string;
  /** `ok`: the last attempt finished. `failed`: every attempt, retries included, failed. */
  status: RunItemStatus;
  attempts: RunAttempt[];
}

/** One try at an item: a fresh token, then both streams replayed at 1x. */
export interface RunAttempt {
  tokenRequestedAtMs: number;
  /** Null when the token request itself failed. */
  tokenReceivedAtMs: number | null;
  /** From the token response; null when the API knows no price (the report says "unknown"). */
  pricePerHourUsd: number | null;
  /** Why the attempt failed; null only on the attempt that finished. */
  error: string | null;
  streams: RunStream[];
}

export interface RunStream {
  source: AudioSource;
  /** Wall-clock epoch ms of item time 0: the sample at item offset t was captured at this plus t. */
  replayStartedAtMs: number;
  /** In the order they opened: one, unless the gate closed and reopened the stream. */
  sessions: RunSession[];
}

export interface RunSession {
  /** `start` at the item's start; `gate` when speech reopened a stream the gate had closed. */
  cause: 'start' | 'gate';
  /** Item offset of this session's stream time 0 (a gate reopen starts at its pre-roll). */
  itemOffsetMs: number;
  openedAtMs: number;
  /** When the vendor said it was ready; null when it never did. */
  readyAtMs: number | null;
  /** Null when the attempt ended with the session still open (a failure). */
  closedAtMs: number | null;
  /** Billed open time, from the adapter's usage. */
  connectedMs: number;
  /** Audio held for the session at its ready signal: 0 at the start, pre-roll plus connect after. */
  backlogMs: number;
}

/** A run file the bench cannot read or will not write. The message starts with the file's label. */
export class BenchFileError extends Error {
  constructor(label: string, problem: string) {
    super(`${label}: ${problem}`);
    this.name = 'BenchFileError';
  }
}

/** One events.jsonl line, newline included. Refuses a record the reader would refuse. */
export function encodeEventLine(record: EventRecord): string {
  const line = JSON.stringify(record);
  // JSON writes NaN and Infinity as null: check the line as the reader will see it.
  parseEventRecord(JSON.parse(line), 'event to write');
  return `${line}\n`;
}

export function decodeEvents(text: string, label: string): EventRecord[] {
  const records: EventRecord[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    const lineLabel = `${label}:${index + 1}`;
    records.push(parseEventRecord(parseJson(line, lineLabel), lineLabel));
  });
  return records;
}

export async function readEvents(path: string): Promise<EventRecord[]> {
  return decodeEvents(await readFile(path, 'utf8'), path);
}

export async function writeEvents(path: string, records: readonly EventRecord[]): Promise<void> {
  await writePrivateFile(path, records.map(encodeEventLine).join(''));
}

/** run.json as written: indented, newline at the end. Refuses a run the reader would refuse. */
export function encodeRun(run: RunRecord): string {
  const text = `${JSON.stringify(run, null, 2)}\n`;
  parseRun(JSON.parse(text), 'run to write');
  return text;
}

export function decodeRun(text: string, label: string): RunRecord {
  return parseRun(parseJson(text, label), label);
}

export async function readRun(path: string): Promise<RunRecord> {
  return decodeRun(await readFile(path, 'utf8'), path);
}

export async function writeRun(path: string, run: RunRecord): Promise<void> {
  await writePrivateFile(path, encodeRun(run));
}

export interface RunPaths {
  dir: string;
  runJson: string;
  itemDir(itemId: string): string;
  events(itemId: string, source: AudioSource): string;
}

/** Where a run's files live under the bench folder. Every id is checked before it joins a path. */
export function runPaths(benchDir: string, runId: string): RunPaths {
  assertBenchId(runId, 'run id');
  const dir = join(benchDir, 'runs', runId);
  const itemDir = (itemId: string): string => {
    assertBenchId(itemId, 'item id');
    return join(dir, itemId);
  };
  return {
    dir,
    runJson: join(dir, 'run.json'),
    itemDir,
    events: (itemId, source) => join(itemDir(itemId), `${source}.events.jsonl`),
  };
}

const BENCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BENCH_ID_RULE =
  '1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit';

/**
 * Refuses an id that is not a plain file name: run and item ids become folder names, so "../x"
 * or "a/b" would write outside the bench folder, and `forget` would delete there.
 */
export function assertBenchId(id: string, what: string): void {
  if (!BENCH_ID.test(id)) throw new Error(`${what} ${JSON.stringify(id)} must be ${BENCH_ID_RULE}`);
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not the parser's message: V8 quotes the input around the fault, which here is transcript
    // text, and this error reaches the terminal and logs.
    throw new BenchFileError(label, 'not valid JSON');
  }
}

/** Typed reads from one JSON object, each naming its field's path when it refuses. */
class Fields {
  private constructor(
    private readonly value: Record<string, unknown>,
    readonly path: string,
    private readonly label: string,
  ) {}

  static root(value: unknown, label: string): Fields {
    if (!isRecord(value)) throw new BenchFileError(label, 'the record must be a JSON object');
    return new Fields(value, '', label);
  }

  fail(problem: string, key?: string): never {
    const path = key === undefined ? this.path : this.pathOf(key);
    throw new BenchFileError(this.label, `${path} ${problem}`);
  }

  get(key: string): unknown {
    // Own fields only: a missing "constructor" must not read as Object.prototype's.
    return Object.hasOwn(this.value, key) ? this.value[key] : undefined;
  }

  number(key: string): number {
    const value = this.get(key);
    if (!isFiniteNumber(value)) this.fail('must be a finite number', key);
    return value;
  }

  numberOrNull(key: string): number | null {
    const value = this.get(key);
    if (value !== null && !isFiniteNumber(value)) this.fail('must be a finite number or null', key);
    return value;
  }

  count(key: string): number {
    const value = this.get(key);
    if (!isFiniteNumber(value) || value < 0) this.fail('must be a finite number of 0 or more', key);
    return value;
  }

  index(key: string): number {
    const value = this.get(key);
    if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) {
      this.fail('must be a whole number of 0 or more', key);
    }
    return value;
  }

  string(key: string): string {
    const value = this.get(key);
    if (typeof value !== 'string') this.fail('must be a string', key);
    return value;
  }

  stringOrNull(key: string): string | null {
    const value = this.get(key);
    if (value !== null && typeof value !== 'string') this.fail('must be a string or null', key);
    return value;
  }

  boolean(key: string): boolean {
    const value = this.get(key);
    if (typeof value !== 'boolean') this.fail('must be true or false', key);
    return value;
  }

  instant(key: string): string {
    const value = this.get(key);
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      this.fail('must be an ISO 8601 time', key);
    }
    return value;
  }

  instantOrNull(key: string): string | null {
    return this.get(key) === null ? null : this.instant(key);
  }

  benchId(key: string): string {
    const value = this.get(key);
    if (typeof value !== 'string' || !BENCH_ID.test(value)) {
      this.fail(`must be a bench id (${BENCH_ID_RULE})`, key);
    }
    return value;
  }

  oneOf<T extends string>(key: string, allowed: readonly T[]): T {
    const value = this.get(key);
    const match = allowed.find((option) => option === value);
    if (match === undefined) this.fail(`must be one of ${allowed.join(', ')}`, key);
    return match;
  }

  strings(key: string): string[] {
    const value = this.get(key);
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      this.fail('must be a list of strings', key);
    }
    return value;
  }

  object(key: string): Fields {
    const value = this.get(key);
    if (!isRecord(value)) this.fail('must be an object', key);
    return new Fields(value, this.pathOf(key), this.label);
  }

  objects(key: string): Fields[] {
    const value = this.get(key);
    if (!Array.isArray(value)) this.fail('must be a list', key);
    return value.map((item: unknown, index) => {
      const path = `${this.pathOf(key)}[${index}]`;
      if (!isRecord(item)) throw new BenchFileError(this.label, `${path} must be an object`);
      return new Fields(item, path, this.label);
    });
  }

  private pathOf(key: string): string {
    return this.path === '' ? key : `${this.path}.${key}`;
  }
}

const EVENT_TYPES = ['interim', 'final', 'error', 'closed'] as const;

function parseEventRecord(value: unknown, label: string): EventRecord {
  const record = Fields.root(value, label);
  return {
    arrivedAtMs: record.number('arrivedAtMs'),
    session: record.index('session'),
    event: parseEvent(record.object('event')),
  };
}

function parseEvent(event: Fields): SttEvent {
  const type = event.oneOf('type', EVENT_TYPES);
  switch (type) {
    case 'interim':
      return {
        type,
        text: event.string('text'),
        startMs: event.number('startMs'),
        endMs: event.number('endMs'),
      };
    case 'final':
      return {
        type,
        text: event.string('text'),
        startMs: event.number('startMs'),
        endMs: event.number('endMs'),
        confidence: event.numberOrNull('confidence'),
        words: event.objects('words').map((word) => ({
          text: word.string('text'),
          startMs: word.number('startMs'),
          endMs: word.number('endMs'),
          confidence: word.numberOrNull('confidence'),
        })),
      };
    case 'error':
      return { type, message: event.string('message'), fatal: event.boolean('fatal') };
    case 'closed':
      return { type, code: event.numberOrNull('code'), reason: event.stringOrNull('reason') };
  }
}

function parseRun(value: unknown, label: string): RunRecord {
  const run = Fields.root(value, label);
  const version = run.number('schemaVersion');
  if (version !== RUN_SCHEMA_VERSION) {
    run.fail(
      `${version} is not supported; this bench reads ${RUN_SCHEMA_VERSION}`,
      'schemaVersion',
    );
  }
  const runId = run.benchId('runId');
  const startedAt = run.instant('startedAt');
  const finishedAt = run.instantOrNull('finishedAt');
  const provider = run.string('provider');
  const model = run.string('model');
  const adapterQuery = run.stringOrNull('adapterQuery');
  const keyterms = run.object('keyterms');
  const parsed: RunRecord = {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId,
    startedAt,
    finishedAt,
    provider,
    model,
    adapterQuery,
    keyterms: { enabled: keyterms.boolean('enabled'), terms: keyterms.strings('terms') },
    normaliserVersion: run.index('normaliserVersion'),
    echoFilterVersion: run.index('echoFilterVersion'),
    gate: run.boolean('gate'),
    items: [],
  };
  const seen = new Set<string>();
  for (const item of run.objects('items')) {
    const parsedItem = parseItem(item);
    if (seen.has(parsedItem.itemId)) {
      item.fail(`${JSON.stringify(parsedItem.itemId)} appears twice`, 'itemId');
    }
    seen.add(parsedItem.itemId);
    parsed.items.push(parsedItem);
  }
  return parsed;
}

function parseItem(item: Fields): RunItem {
  const itemId = item.benchId('itemId');
  const status = item.oneOf('status', ['ok', 'failed'] as const);
  const attempts = item
    .objects('attempts')
    .map((fields) => ({ fields, attempt: parseAttempt(fields) }));
  const last = attempts.at(-1);
  if (last === undefined) item.fail('has no attempts');
  // A retry only follows a failure, and the status is what the last attempt did: a reader that
  // trusted one and not the other would count an item as failed and scored at once.
  for (const { fields, attempt } of attempts.slice(0, -1)) {
    if (attempt.error === null) fields.fail('was retried, so it must name its error');
  }
  if (status === 'ok' && last.attempt.error !== null) {
    item.fail('is ok, so its last attempt must have no error');
  }
  if (status === 'failed' && last.attempt.error === null) {
    item.fail('failed, so its last attempt must name its error');
  }
  return { itemId, status, attempts: attempts.map(({ attempt }) => attempt) };
}

function parseAttempt(attempt: Fields): RunAttempt {
  const parsed: RunAttempt = {
    tokenRequestedAtMs: attempt.number('tokenRequestedAtMs'),
    tokenReceivedAtMs: attempt.numberOrNull('tokenReceivedAtMs'),
    pricePerHourUsd: attempt.numberOrNull('pricePerHourUsd'),
    error: attempt.stringOrNull('error'),
    streams: [],
  };
  for (const stream of attempt.objects('streams')) {
    const parsedStream = parseStream(stream);
    if (parsed.streams.some((other) => other.source === parsedStream.source)) {
      stream.fail(`${JSON.stringify(parsedStream.source)} appears twice`, 'source');
    }
    parsed.streams.push(parsedStream);
  }
  return parsed;
}

function parseStream(stream: Fields): RunStream {
  return {
    source: stream.oneOf('source', AUDIO_SOURCES),
    replayStartedAtMs: stream.number('replayStartedAtMs'),
    sessions: stream.objects('sessions').map((session) => ({
      cause: session.oneOf('cause', ['start', 'gate'] as const),
      itemOffsetMs: session.count('itemOffsetMs'),
      openedAtMs: session.number('openedAtMs'),
      readyAtMs: session.numberOrNull('readyAtMs'),
      closedAtMs: session.numberOrNull('closedAtMs'),
      connectedMs: session.count('connectedMs'),
      backlogMs: session.count('backlogMs'),
    })),
  };
}
