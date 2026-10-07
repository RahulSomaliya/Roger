import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_USER_DATA_DIR } from './backup';
import { type CheckResult, check } from './check';
import {
  type ClipDeps,
  type ClipOptions,
  clip,
  formatClock,
  parseClockTime,
  parseParticipant,
} from './clip';
import { type DraftResult, draft } from './draft';
import { type ForgetResult, type ForgetTarget, forget } from './forget';
import { ITEM_KINDS, ITEM_SETUPS, itemPaths } from './item';

/**
 * The test-set commands as `bench/cli.ts` (M3-T11) runs them: `make bench ARGS="clip ..."` hands
 * the words after the command name to `DATASET_COMMANDS[name]`, which resolves with the exit code.
 * The CLI resolves ROGER_BENCH_DIR (default ~/Roger-bench) and refuses one inside the git checkout
 * before calling here. Every line printed names items, runs, files and counts, never transcript
 * text. A thrown error is a usage or setup problem for the CLI to print and exit non-zero on.
 */

export interface DatasetContext {
  benchDir: string;
  /** Writes one line of output. */
  print: (line: string) => void;
}

/** Runs a command with the arguments after its name; resolves with the process exit code. */
export type DatasetCommand = (args: readonly string[], context: DatasetContext) => Promise<number>;

export const DATASET_COMMANDS: Readonly<
  Record<'clip' | 'draft' | 'check' | 'forget', DatasetCommand>
> = {
  clip: (args, context) => clipCommand(args, context),
  draft: draftCommand,
  check: checkCommand,
  forget: forgetCommand,
};

/**
 * `clip --meeting <id> --from <mm:ss> --to <mm:ss> --name <id> [--user-data <dir>]
 * [--person <name>:<consent date> ...] [--kind <kind>] [--setup <setup>]`. `--kind` and `--setup`
 * fill item.json's fields of the same name (default `other` and `unknown`).
 */
export async function clipCommand(
  args: readonly string[],
  context: DatasetContext,
  deps?: ClipDeps,
): Promise<number> {
  const options = parseClipArgs(args, context.benchDir);
  const item = await clip(options, deps);
  const streams = item.streams.join(' and ');
  context.print(
    `clipped ${item.id}: ${formatClock(item.window.toMs - item.window.fromMs)} of ${streams} ` +
      `from meeting ${options.meetingId} (${formatClock(item.window.fromMs)} to ` +
      `${formatClock(item.window.toMs)})`,
  );
  if (item.gaps.length > 0) {
    const gaps = item.gaps.map(
      (gap) => `${gap.source} ${formatClock(gap.startMs)} to ${formatClock(gap.endMs)}`,
    );
    context.print(`  silence fills ${plural(gaps.length, 'gap')}: ${gaps.join(', ')}`);
  }
  if (item.participants.length === 0) {
    context.print('  no participant consent recorded: add each person to item.json before scoring');
  }
  context.print(`listen: ${itemPaths(context.benchDir, item.id).listen}`);
  return 0;
}

export function parseClipArgs(args: readonly string[], benchDir: string): ClipOptions {
  const { values } = parseArgs({
    args: [...args],
    options: {
      meeting: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      name: { type: 'string' },
      'user-data': { type: 'string' },
      person: { type: 'string', multiple: true },
      kind: { type: 'string' },
      setup: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    benchDir,
    userDataDir: values['user-data'] ?? DEFAULT_USER_DATA_DIR,
    meetingId: required(values.meeting, 'clip', '--meeting <id>'),
    fromMs: parseClockTime(required(values.from, 'clip', '--from <mm:ss>'), '--from'),
    toMs: parseClockTime(required(values.to, 'clip', '--to <mm:ss>'), '--to'),
    itemId: required(values.name, 'clip', '--name <item id>'),
    participants: (values.person ?? []).map(parseParticipant),
    kind: choice(values.kind ?? 'other', ITEM_KINDS, '--kind'),
    setup: choice(values.setup ?? 'unknown', ITEM_SETUPS, '--setup'),
  };
}

/** `draft --runs <a>,<b>` */
async function draftCommand(args: readonly string[], context: DatasetContext): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { runs: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  const runIds = required(values.runs, 'draft', '--runs <a>,<b>')
    .split(',')
    .map((runId) => runId.trim());
  const result = await draft(context.benchDir, runIds);
  printDraft(result, runIds, context);
  return result.failed.length === 0 ? 0 : 1;
}

/** `check` */
async function checkCommand(args: readonly string[], context: DatasetContext): Promise<number> {
  parseArgs({ args: [...args], options: {}, strict: true, allowPositionals: false });
  const result = await check(context.benchDir);
  printCheck(result, context);
  return result.items > 0 && result.problems.length === 0 ? 0 : 1;
}

/** `forget --person <name>` or `forget --meeting <id>` */
async function forgetCommand(args: readonly string[], context: DatasetContext): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { person: { type: 'string' }, meeting: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  let target: ForgetTarget;
  if (values.person !== undefined && values.meeting === undefined) {
    target = { person: values.person };
  } else if (values.meeting !== undefined && values.person === undefined) {
    target = { meetingId: values.meeting };
  } else {
    throw new Error('forget needs --person <name> or --meeting <id>, not both');
  }
  const result = await forget(context.benchDir, target);
  printForget(result, target, context);
  return result.deleted.length > 0 && result.unchecked.length === 0 ? 0 : 1;
}

function printDraft(result: DraftResult, runIds: readonly string[], context: DatasetContext): void {
  const [a = '', b = ''] = runIds;
  context.print(
    `drafted ${plural(result.drafted.length, 'item')} from runs ${a} and ${b}; ` +
      `braces read {${a} | ${b}}`,
  );
  if (result.withReference.length > 0) {
    context.print(
      `left ${plural(result.withReference.length, 'item')} with a reference.txt as they are`,
    );
  }
  if (result.withDraft.length > 0) {
    context.print(
      `left ${plural(result.withDraft.length, 'item')} with a reference.draft.txt as they are; ` +
        "delete an item's draft to draft it again",
    );
  }
  for (const { itemId, reason } of result.failed) {
    context.print(`could not draft ${itemId}: ${reason}`);
  }
}

function printCheck(result: CheckResult, context: DatasetContext): void {
  if (result.items === 0) {
    context.print(`no items in ${join(context.benchDir, 'items')}: clip some first`);
    return;
  }
  for (const { itemId, message } of result.problems) context.print(`${itemId}: ${message}`);
  const itemsWithProblems = new Set(result.problems.map((problem) => problem.itemId)).size;
  context.print(
    `checked ${plural(result.items, 'item')}: ` +
      (result.problems.length === 0
        ? 'no problems'
        : `${plural(result.problems.length, 'problem')} in ${plural(itemsWithProblems, 'item')}`),
  );
}

function printForget(result: ForgetResult, target: ForgetTarget, context: DatasetContext): void {
  for (const { itemId, runs } of result.deleted) {
    context.print(
      runs.length === 0
        ? `deleted item ${itemId} (no run held it)`
        : `deleted item ${itemId} and its outputs in runs ${runs.join(', ')}`,
    );
  }
  if (result.deleted.length === 0) {
    if ('person' in target) {
      const names = result.names.length === 0 ? 'none' : result.names.join(', ');
      context.print(`no item lists ${JSON.stringify(target.person)}; names on file: ${names}`);
    } else {
      context.print(`no item was clipped from meeting ${target.meetingId}`);
    }
  }
  for (const { what, reason } of result.unchecked) {
    context.print(`could not read ${what}: ${reason}; check it by hand`);
  }
}

function required(value: string | undefined, command: string, flag: string): string {
  if (value === undefined || value.trim() === '') throw new Error(`${command} needs ${flag}`);
  return value;
}

function choice<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  const match = allowed.find((option) => option === value);
  if (match === undefined) throw new Error(`${flag} must be one of ${allowed.join(', ')}`);
  return match;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
