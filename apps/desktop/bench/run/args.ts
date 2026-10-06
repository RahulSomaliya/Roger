import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assertBenchId } from '../core/events';

/**
 * The test-set commands. They are M3-T12's (bench/dataset/commands.ts), which parses their options
 * itself, so this file passes their words on as given; run/dataset.ts finds the table.
 */
export const DATASET_COMMAND_NAMES = ['clip', 'draft', 'check', 'forget'] as const;
export type DatasetCommandName = (typeof DATASET_COMMAND_NAMES)[number];

/** The bench CLI's commands and their options (`make bench ARGS="..."`; cli.ts runs them). */
export type BenchCommand =
  | { command: 'help' }
  | { command: 'run'; itemIds: string[] | null; keyterms: boolean; parallel: number }
  | { command: 'score'; runId: string | null; echoFilter: boolean }
  | { command: 'report' }
  | { command: 'canary'; saveWireDir: string | null }
  | { command: 'dataset'; name: DatasetCommandName; args: string[] };

/** A command line the bench does not understand; cli.ts prints it with the usage. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const USAGE = `usage: make bench ARGS="<command> [options]"

  clip --meeting <id> --from <mm:ss> --to <mm:ss> --name <id> [--user-data <dir>]
       [--person <name>:<consent date> ...] [--kind <kind>] [--setup <setup>]
      Cut both streams of a stretch of a meeting from the local backup into a new item.
  run [--items <id>,<id>] [--no-keyterms] [--parallel 3]
      Replay every item (or the ones named) at 1x through the vendor the API's token names.
  draft --runs <a>,<b>
      Write reference.draft.txt for items without a reference.txt, braces where runs disagree.
  check
      List unresolved braces, unknown speakers, empty items and items with no consent.
  score [--run <id>] [--no-echo-filter]
      Score one run, or every finished run, into reports/<run-id>.json and .md.
  report --summary
      Print the aggregate table of every scored run, with no transcript text.
  forget --person <name> | --meeting <id>
      Delete every item holding that person or meeting, and those items' run outputs.
  canary [--save-wire <dir>]
      Synthetic jargon clip through the current vendor; exits non-zero on failure.

Data lives in ROGER_BENCH_DIR (default ~/Roger-bench); settings come from the repo-root .env.`;

const DEFAULT_PARALLEL = 3;
const MAX_PARALLEL = 10;

/**
 * Parses the bench's arguments. `cwd` resolves a relative `--save-wire`: pass the folder make ran
 * in (INIT_CWD), not apps/desktop, where pnpm runs the script.
 */
export function parseBenchArgs(argv: readonly string[], cwd: string): BenchCommand {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'help':
    case '--help':
      return { command: 'help' };
    case 'run': {
      const { values } = usage(() =>
        parseArgs({
          args: rest,
          options: {
            items: { type: 'string' },
            'no-keyterms': { type: 'boolean' },
            parallel: { type: 'string' },
          },
          strict: true,
          allowPositionals: false,
        }),
      );
      return {
        command,
        itemIds: values.items === undefined ? null : itemIds(values.items),
        keyterms: values['no-keyterms'] !== true,
        parallel: values.parallel === undefined ? DEFAULT_PARALLEL : parallel(values.parallel),
      };
    }
    case 'score': {
      const { values } = usage(() =>
        parseArgs({
          args: rest,
          options: {
            run: { type: 'string' },
            'no-echo-filter': { type: 'boolean' },
          },
          strict: true,
          allowPositionals: false,
        }),
      );
      if (values.run !== undefined) checkedId(values.run, 'run id');
      return {
        command,
        runId: values.run ?? null,
        echoFilter: values['no-echo-filter'] !== true,
      };
    }
    case 'report': {
      const { values } = usage(() =>
        parseArgs({
          args: rest,
          options: { summary: { type: 'boolean' } },
          strict: true,
          allowPositionals: false,
        }),
      );
      if (values.summary !== true) throw new UsageError('report takes --summary');
      return { command };
    }
    case 'canary': {
      const { values } = usage(() =>
        parseArgs({
          args: rest,
          options: { 'save-wire': { type: 'string' } },
          strict: true,
          allowPositionals: false,
        }),
      );
      const dir = values['save-wire'];
      return {
        command,
        saveWireDir: dir === undefined ? null : isAbsolute(dir) ? dir : resolve(cwd, dir),
      };
    }
    case 'clip':
    case 'draft':
    case 'check':
    case 'forget':
      return { command: 'dataset', name: command, args: rest };
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
}

/**
 * Runs node:util parseArgs (strict, no positionals), its errors (an unknown option such as
 * `--gate` before M3-T20, a stray word) turned into usage errors.
 */
function usage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof TypeError) throw new UsageError(error.message);
    throw error;
  }
}

function itemIds(list: string): string[] {
  const ids = list
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  if (ids.length === 0) throw new UsageError('--items needs at least one item id');
  return ids.map((id) => checkedId(id, 'item id'));
}

function checkedId(id: string, what: string): string {
  try {
    assertBenchId(id, what);
  } catch (error) {
    if (error instanceof Error) throw new UsageError(error.message);
    throw error;
  }
  return id;
}

function parallel(value: string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PARALLEL) {
    throw new UsageError(
      `--parallel must be a whole number from 1 to ${MAX_PARALLEL} (got ${JSON.stringify(value)})`,
    );
  }
  return count;
}
