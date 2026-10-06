import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseReference } from '../core/reference';
import {
  type ItemRecord,
  describeItemError,
  isMissingFile,
  itemPaths,
  listItemIds,
  readItem,
} from './item';

/**
 * `bench check`: what still stands between the test set and a scored run. Per item: unresolved
 * braces (with line and column), unknown speakers and other malformed lines, a reference that is
 * missing or has no lines, a line for a stream the item does not have (Me on a Meet recording),
 * and no participant consent on file (M3 D2). Items are scored only from a clean `reference.txt`.
 *
 * Messages name lines and fields, never the text on them: the references are transcripts of real
 * people, and this output reaches the terminal and its scrollback.
 */

export interface CheckProblem {
  itemId: string;
  message: string;
}

export interface CheckResult {
  /** Item folders checked, readable or not. */
  items: number;
  /** In item order, then line order. */
  problems: CheckProblem[];
}

const STREAM_FOR_SPEAKER = { me: 'mic', them: 'system' } as const;

export async function check(benchDir: string): Promise<CheckResult> {
  const itemIds = await listItemIds(benchDir);
  const problems: CheckProblem[] = [];
  for (const itemId of itemIds) {
    for (const message of await itemProblems(benchDir, itemId)) problems.push({ itemId, message });
  }
  return { items: itemIds.length, problems };
}

async function itemProblems(benchDir: string, itemId: string): Promise<string[]> {
  let item: ItemRecord;
  try {
    item = await readItem(benchDir, itemId);
  } catch (error) {
    return [describeItemError(error)];
  }
  const paths = itemPaths(benchDir, itemId);
  const problems: string[] = [];
  if (item.participants.length === 0) {
    problems.push(
      "no participant consent recorded: list everyone heard, with the date they agreed, in item.json's participants",
    );
  }

  let text: string;
  try {
    text = await readFile(paths.reference, 'utf8');
  } catch (error) {
    // Under its item, as an unreadable item.json is: thrown, one item's folder or permissions
    // problem would end the whole check and hide every other item's problems.
    if (!isMissingFile(error)) {
      problems.push(`could not read reference.txt: ${describeItemError(error)}`);
      return problems;
    }
    // Fixing the draft in place is safe only because `bench draft` never rewrites a draft that is
    // there (draft.ts); a draft that did would wipe the owner's fixes on its next run.
    problems.push(
      existsSync(paths.draft)
        ? 'no reference.txt yet: fix reference.draft.txt and save it as reference.txt'
        : 'no reference.txt yet: run bench draft, then fix the draft',
    );
    return problems;
  }

  const reference = parseReference(text);
  const lineProblems = [
    ...reference.problems.map((problem) => ({
      lineNumber: problem.lineNumber,
      message: problem.message,
    })),
    ...reference.lines
      .filter((line) => !item.streams.includes(STREAM_FOR_SPEAKER[line.speaker]))
      .map((line) => ({
        lineNumber: line.lineNumber,
        message:
          line.speaker === 'me'
            ? `line ${line.lineNumber}: Me, but the item has no mic stream; label it Them (on a Meet recording every line is Them)`
            : `line ${line.lineNumber}: Them, but the item has no system stream; it cannot be scored`,
      })),
  ].sort((a, b) => a.lineNumber - b.lineNumber);
  problems.push(...lineProblems.map((problem) => `reference.txt ${problem.message}`));
  if (reference.lines.length === 0 && reference.problems.length === 0) {
    problems.push('reference.txt has no lines: an empty item scores nothing');
  }
  return problems;
}
