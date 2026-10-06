import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SttTokenApi } from '../src/main/api/ApiClient';
import { errorMessage } from '../src/main/logger';
import type { SttStream } from '../src/main/stt/SpeechToText';
import { assertBenchId } from './core/events';
import { readWav } from './core/wav';
import { errorRate, scoreTexts } from './core/wer';
import type { BenchAdapterFactory, BenchWireTap } from './run/adapters';
import { BenchCredentialSource } from './run/credentials';
import { BenchOpener } from './run/opens';
import { replayAtRealTime } from './run/replay';
import type { BenchTimers } from './run/timers';

/**
 * `bench canary` (also `make stt-canary`): a fixed script with jargon in it, spoken by macOS `say`,
 * through whichever vendor the local API serves, at real time like any bench item (M3 design,
 * "Canary"). It catches a dead key, a wrong model name or a rejected jargon list in a minute, with
 * nothing private in the repo. Synthetic speech says nothing about accuracy on our voices; the
 * standing test set does that.
 *
 * `--save-wire <dir>` writes the vendor's messages for the AssemblyAI wire fixtures
 * (src/main/stt/assemblyai/fixtures/, M3 close step 0): `<model>.jsonl`, the text messages the vendor
 * sent on the stream, in order, one per line exactly as they arrived.
 */

const SENTENCES = [
  'Roger takes the meeting notes for the Linkt team.',
  'The live transcript shows what each person said.',
  'Linkt ships the new Roger build on Friday.',
  'Every call stays private to the workspace.',
];

/** What `say` speaks: a second of silence after each sentence, so the vendor ends each turn. */
export const CANARY_SPOKEN = SENTENCES.join(' [[slnc 1000]] ');
/** What the vendor should have heard. */
export const CANARY_REFERENCE = SENTENCES.join(' ');
/** A real vendor fails above this word error rate on the script. */
export const CANARY_MAX_WER = 0.15;
/** Every vendor fails when no final has arrived this long after the audio began. */
export const CANARY_FINAL_WITHIN_MS = 10_000;

export interface CanaryDeps {
  api: SttTokenApi;
  adapters: BenchAdapterFactory;
  timers: BenchTimers;
  /** The desktop's sttOpensPerMinute: the canary's one session passes the bench's open budget. */
  opensPerMinute: number;
  /** Writes `script`, spoken, to `path` as a 16 kHz mono PCM16 WAV (sayToWav in the CLI). */
  synthesize: (script: string, path: string) => Promise<void>;
  /** Progress lines: ids, times and rates, never the vendor's text. */
  out: (line: string) => void;
}

export interface CanaryResult {
  passed: boolean;
  /** Why it failed; null when it passed. */
  reason: string | null;
  provider: string | null;
  model: string | null;
  /** When the first final arrived after the audio began; null when none did. */
  firstFinalMs: number | null;
  /** Null when not checked: the fake provider, or no final at all. */
  wer: number | null;
}

/** macOS `say`, writing 16 kHz little-endian PCM16 WAV, the bench's one audio format. */
export async function sayToWav(script: string, path: string): Promise<void> {
  await promisify(execFile)('say', [
    '-o',
    path,
    '--file-format=WAVE',
    '--data-format=LEI16@16000',
    script,
  ]);
}

export async function runCanary(
  options: { saveWireDir: string | null },
  deps: CanaryDeps,
): Promise<CanaryResult> {
  const samples = await synthesizeScript(deps.synthesize);
  const source = new BenchCredentialSource(deps.api, { keyterms: true });
  const opener = new BenchOpener({ opensPerMinute: deps.opensPerMinute }, deps.timers);
  const wire: string[] = [];
  const tap: BenchWireTap = (record) => {
    if (
      record.kind === 'text' &&
      record.direction === 'received' &&
      typeof record.text === 'string'
    ) {
      wire.push(record.text);
    }
  };
  const result: CanaryResult = {
    passed: false,
    reason: null,
    provider: null,
    model: null,
    firstFinalMs: null,
    wer: null,
  };

  let stream: SttStream;
  try {
    const { credentials, stt } = await opener.reserve(1, async () => {
      const fetched = await source.fetch();
      return { credentials: fetched, stt: deps.adapters(fetched.provider, tap) };
    });
    result.provider = credentials.provider;
    result.model = credentials.model;
    deps.out(`canary: ${credentials.provider} ${credentials.model}`);
    stream = await stt.openStream({
      accessToken: credentials.accessToken,
      settings: credentials.settings,
      label: 'canary',
    });
  } catch (error) {
    // The canary's job is to say why a vendor cannot be used: a refused token, an unknown
    // provider, a rejected jargon list. The run fails with the reason; nothing is retried.
    return fail(result, `connect failed: ${errorMessage(error)}`, deps.out);
  }

  const finals: string[] = [];
  const ended: { reason: string | null } = { reason: null };
  let closing = false;
  const startedAtMs = deps.timers.now();
  stream.on((event) => {
    if (event.type === 'final') {
      finals.push(event.text);
      result.firstFinalMs ??= deps.timers.now() - startedAtMs;
    }
    if (closing) return;
    if (event.type === 'error' && event.fatal) ended.reason ??= event.message;
    if (event.type === 'closed') ended.reason ??= 'the vendor closed the session';
  });
  const noFinalYet = (): boolean =>
    result.firstFinalMs === null && deps.timers.now() - startedAtMs >= CANARY_FINAL_WITHIN_MS;
  await replayAtRealTime(
    [{ samples, stream }],
    deps.timers,
    startedAtMs,
    () => ended.reason !== null || noFinalYet(),
  );
  closing = true;
  await stream.close();

  const unsaved =
    options.saveWireDir === null
      ? null
      : await saveWire(options.saveWireDir, result, wire, deps.out);
  if (ended.reason !== null) return fail(result, ended.reason, deps.out);
  if (unsaved !== null) return fail(result, unsaved, deps.out);
  if (result.firstFinalMs === null || result.firstFinalMs > CANARY_FINAL_WITHIN_MS) {
    return fail(result, `no final within ${CANARY_FINAL_WITHIN_MS / 1000} s`, deps.out);
  }
  deps.out(`first final after ${Math.round(result.firstFinalMs)} ms`);
  if (result.provider === 'fake') {
    // The fake adapter writes level lines with no words: any WER rule would always fail on it.
    deps.out('WER not checked (fake provider)');
  } else {
    result.wer = errorRate(scoreTexts([CANARY_REFERENCE], finals));
    const wer = percent(result.wer);
    deps.out(`WER ${wer}`);
    if (result.wer === null || result.wer > CANARY_MAX_WER) {
      return fail(result, `WER ${wer} is above ${Math.round(CANARY_MAX_WER * 100)}%`, deps.out);
    }
  }
  result.passed = true;
  deps.out('canary passed');
  return result;
}

/** The script as samples; the clip lives only in a temporary folder removed right after. */
async function synthesizeScript(synthesize: CanaryDeps['synthesize']): Promise<Int16Array> {
  const dir = await mkdtemp(join(tmpdir(), 'roger-canary-'));
  try {
    const path = join(dir, 'canary.wav');
    await synthesize(CANARY_SPOKEN, path);
    return await readWav(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Writes the wire fixture; returns why it could not, or null. */
async function saveWire(
  dir: string,
  result: CanaryResult,
  wire: readonly string[],
  out: (line: string) => void,
): Promise<string | null> {
  if (result.provider === 'fake' || result.model === null) {
    out('no vendor wire to save: the fake provider opens no socket');
    return null;
  }
  // An empty file would pass for a recording and replace the fixtures with nothing; the core
  // reports the wire only once its tap exists (WebSocketSttOptions.wireTap).
  if (wire.length === 0) return 'the STT core reported no vendor messages, so no wire was saved';
  // The model names the file the fixture tests read (wireFixtures.ts); a bench id is a safe name.
  assertBenchId(result.model, 'model');
  const path = join(dir, `${result.model}.jsonl`);
  await mkdir(dir, { recursive: true });
  // Synthetic speech only, made to be committed as a fixture: not a private bench file.
  await writeFile(path, wire.map((message) => `${message}\n`).join(''));
  out(`wrote ${wire.length} vendor messages to ${path}`);
  return null;
}

function fail(result: CanaryResult, reason: string, out: (line: string) => void): CanaryResult {
  out(`canary failed: ${reason}`);
  return { ...result, passed: false, reason };
}

function percent(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}
