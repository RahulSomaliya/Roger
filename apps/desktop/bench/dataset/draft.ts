import { existsSync } from 'node:fs';
import {
  SPEAKER_FOR_SOURCE,
  type AudioSource,
  type SpeakerLabel,
} from '../../src/shared/transcript';
import { align } from '../core/align';
import {
  BenchFileError,
  type RunAttempt,
  type RunRecord,
  readEvents,
  readRun,
  runPaths,
} from '../core/events';
import { writePrivateFile } from '../core/files';
import { normalise } from '../core/normalise';
import { formatReferenceLine } from '../core/reference';
import {
  describeItemError,
  isMissingFile,
  itemPaths,
  listItemIds,
  readItem,
  writeItem,
} from './item';

/**
 * `bench draft --runs <a>,<b>`: a first reference for every item that has no `reference.txt` yet,
 * from two vendors' runs, so the owner's attention goes where they disagree (M3 design, "Fixing
 * text by hand"). Where the runs agree the text is almost always right; a draft from one vendor
 * alone would lean the reference toward it.
 *
 * The lines are run <a>'s finals, at their start, Me (mic) and Them (system) in time order. Each
 * stream's words are aligned across the two runs on normalised words (`core/align.ts`); a stretch
 * that differs is written `{<a>'s words | <b>'s words}`, either side possibly empty, unless both
 * sides read the same after the normaliser ("$5" and "five dollars"), which scoring would not tell
 * apart either. `bench check` refuses a reference while any brace is left, and `item.json` records
 * the two runs.
 */

export interface TimedFinal {
  /** Item time of the final's start. */
  atMs: number;
  text: string;
}

export interface DraftStream {
  speaker: SpeakerLabel;
  /** Run <a>'s finals, in arrival order: they make the lines. */
  a: readonly TimedFinal[];
  b: readonly TimedFinal[];
}

export interface DraftResult {
  /** Items that got a reference.draft.txt. */
  drafted: string[];
  /** Items left alone because their reference is already fixed by hand. */
  withReference: string[];
  /** Items with no draft, and why (never text from the runs). */
  failed: { itemId: string; reason: string }[];
}

/** Writes `reference.draft.txt` for every item without a `reference.txt`. */
export async function draft(benchDir: string, runIds: readonly string[]): Promise<DraftResult> {
  const [aId, bId] = runIds;
  if (runIds.length !== 2 || aId === undefined || bId === undefined || aId === bId) {
    throw new Error('draft takes two different runs: --runs <a>,<b>');
  }
  const runA = await loadRun(benchDir, aId);
  const runB = await loadRun(benchDir, bId);

  const result: DraftResult = { drafted: [], withReference: [], failed: [] };
  for (const itemId of await listItemIds(benchDir)) {
    try {
      const item = await readItem(benchDir, itemId);
      const paths = itemPaths(benchDir, itemId);
      if (existsSync(paths.reference)) {
        result.withReference.push(itemId);
        continue;
      }
      // Both runs are checked before any events are read, so the reason names the run at fault.
      const attemptA = finishedAttempt(runA, itemId);
      const attemptB = finishedAttempt(runB, itemId);
      const streams: DraftStream[] = [];
      for (const source of item.streams) {
        streams.push({
          speaker: SPEAKER_FOR_SOURCE[source],
          a: await finalsOf(benchDir, runA.runId, attemptA, itemId, source),
          b: await finalsOf(benchDir, runB.runId, attemptB, itemId, source),
        });
      }
      await writePrivateFile(paths.draft, draftReference(streams));
      await writeItem(benchDir, { ...item, draftRuns: [aId, bId] });
      result.drafted.push(itemId);
    } catch (error) {
      // One item's problem never stops the others; the command lists it and exits non-zero.
      result.failed.push({ itemId, reason: describeItemError(error) });
    }
  }
  return result;
}

/** The draft's text: every stream's lines, merged in time order. */
export function draftReference(streams: readonly DraftStream[]): string {
  const lines = streams
    .flatMap(({ speaker, a, b }) => draftLines(a, b).map((line) => ({ ...line, speaker })))
    // Stable: one stream's lines keep their order; Me before Them at the same time, as live.
    .sort((x, y) => x.atMs - y.atMs || speakerRank(x.speaker) - speakerRank(y.speaker));
  return lines.map((line) => `${formatReferenceLine(line)}\n`).join('');
}

interface Token {
  raw: string;
  /** The token's normalised words joined; '' for a filler or bare punctuation. */
  key: string;
  /** Index of the final it came from. */
  final: number;
}

/** One stream's draft lines, on run <a>'s finals. */
function draftLines(a: readonly TimedFinal[], b: readonly TimedFinal[]): TimedFinal[] {
  const aTokens = tokenise(a);
  const bTokens = tokenise(b);
  if (aTokens.length === 0) {
    // Run <a> heard nothing on this stream: run <b>'s finals become the lines, wholly in braces.
    return b
      .filter((final) => normalise(final.text).length > 0)
      .map((final) => ({ atMs: final.atMs, text: braces('', final.text) }));
  }

  // Fillers and bare punctuation take no part in the alignment, so "um" against nothing is never
  // a brace; run <a>'s stay in the text where they were.
  const aWords = contentIndexes(aTokens);
  const bWords = contentIndexes(bTokens);
  const steps = align(
    aWords.map((index) => tokenAt(aTokens, index).key),
    bWords.map((index) => tokenAt(bTokens, index).key),
  );

  const pieces: string[][] = a.map(() => []);
  let next = 0;
  /** Writes run <a>'s tokens up to `end` (exclusive) onto their own lines, as they are. */
  const writeA = (end: number): void => {
    for (; next < end; next += 1) {
      const token = tokenAt(aTokens, next);
      pieces[token.final]?.push(token.raw);
    }
  };

  let step = 0;
  while (step < steps.length) {
    const current = steps[step];
    if (current?.op === 'match') {
      writeA(wordAt(aWords, current.reference) + 1);
      step += 1;
      continue;
    }
    // A stretch of steps that are not matches: one brace.
    const aSpan: number[] = [];
    const bSpan: number[] = [];
    for (; step < steps.length && steps[step]?.op !== 'match'; step += 1) {
      const differing = steps[step];
      if (differing?.reference != null) aSpan.push(wordAt(aWords, differing.reference));
      if (differing?.hypothesis != null) bSpan.push(wordAt(bWords, differing.hypothesis));
    }
    const bText = spanText(bTokens, bSpan);
    const first = aSpan[0];
    const last = aSpan.at(-1);
    if (first === undefined || last === undefined) {
      // Words only run <b> heard: on the line of run <a>'s word before them, or at the very start
      // the one after.
      const line = tokenAt(aTokens, Math.max(next - 1, 0)).final;
      pieces[line]?.push(braces('', bText));
      continue;
    }
    writeA(first);
    // A brace spanning two of run <a>'s lines sits on the first; the second keeps what follows.
    const aText = spanText(aTokens, aSpan);
    next = last + 1;
    pieces[tokenAt(aTokens, first).final]?.push(
      sameWords(aText, bText) ? aText : braces(aText, bText),
    );
  }
  writeA(aTokens.length);

  return a
    .map((final, index) => ({ atMs: final.atMs, text: (pieces[index] ?? []).join(' ') }))
    .filter((line) => line.text !== '');
}

function tokenise(finals: readonly TimedFinal[]): Token[] {
  return finals.flatMap((final, index) =>
    final.text
      .split(/\s+/)
      .filter((raw) => raw !== '')
      .map((raw) => ({ raw, key: normalise(raw).join(' '), final: index })),
  );
}

function contentIndexes(tokens: readonly Token[]): number[] {
  return tokens.flatMap((token, index) => (token.key === '' ? [] : [index]));
}

/** The raw text from the first to the last token of a span, fillers between them included. */
function spanText(tokens: readonly Token[], span: readonly number[]): string {
  const first = span[0];
  const last = span.at(-1);
  if (first === undefined || last === undefined) return '';
  return tokens
    .slice(first, last + 1)
    .map((token) => token.raw)
    .join(' ');
}

function sameWords(a: string, b: string): boolean {
  const aWords = normalise(a);
  const bWords = normalise(b);
  return aWords.length === bWords.length && aWords.every((word, index) => word === bWords[index]);
}

function braces(a: string, b: string): string {
  return `{${a} | ${b}}`;
}

function speakerRank(speaker: SpeakerLabel): number {
  return speaker === 'me' ? 0 : 1;
}

// The indexes below come from align() over these same lists, so a miss is a bug in this file.
function tokenAt(tokens: readonly Token[], index: number): Token {
  const token = tokens[index];
  if (token === undefined) throw new RangeError(`draft: no token ${index} of ${tokens.length}`);
  return token;
}

function wordAt(words: readonly number[], index: number): number {
  const word = words[index];
  if (word === undefined) throw new RangeError(`draft: no word ${index} of ${words.length}`);
  return word;
}

async function loadRun(benchDir: string, runId: string): Promise<RunRecord> {
  const path = runPaths(benchDir, runId).runJson;
  try {
    return await readRun(path);
  } catch (error) {
    if (isMissingFile(error)) {
      throw new Error(`no run ${runId}: ${path} is missing`, { cause: error });
    }
    throw error;
  }
}

/** The attempt whose events the run kept for an item: its last, when the item finished. */
function finishedAttempt(run: RunRecord, itemId: string): RunAttempt {
  const entry = run.items.find((candidate) => candidate.itemId === itemId);
  const attempt = entry?.status === 'ok' ? entry.attempts.at(-1) : undefined;
  if (attempt === undefined) throw new Error(`run ${run.runId} has no finished attempt for it`);
  return attempt;
}

/** A run's finals for one stream of an item, in item time, in arrival order. */
async function finalsOf(
  benchDir: string,
  runId: string,
  attempt: RunAttempt,
  itemId: string,
  source: AudioSource,
): Promise<TimedFinal[]> {
  const stream = attempt.streams.find((candidate) => candidate.source === source);
  if (stream === undefined) throw new Error(`run ${runId} has no ${source} stream for it`);

  const path = runPaths(benchDir, runId).events(itemId, source);
  const finals: TimedFinal[] = [];
  for (const record of await readEvents(path)) {
    if (record.event.type !== 'final') continue;
    // A session the gate reopened starts its stream time at its own item offset.
    const session = stream.sessions[record.session];
    if (session === undefined) {
      throw new BenchFileError(path, `an event names session ${record.session}, not in run.json`);
    }
    finals.push({ atMs: record.event.startMs + session.itemOffsetMs, text: record.event.text });
  }
  return finals;
}
