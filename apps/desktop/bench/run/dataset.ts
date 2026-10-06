import { DATASET_COMMAND_NAMES, type DatasetCommandName } from './args';

/**
 * The test-set commands, clip, draft, check and forget (M3 design, "Commands"), are M3-T12's:
 * bench/dataset/commands.ts exports them as DATASET_COMMANDS. cli.ts resolves the bench folder
 * (refusing one inside a git checkout) and hands each the words after its name.
 */

/** What a test-set command gets besides its words: M3-T12's DatasetContext, field for field. */
export interface DatasetContext {
  benchDir: string;
  /** Writes one line of output. */
  print: (line: string) => void;
}

/** M3-T12's DatasetCommand: resolves with the process exit code. */
export type DatasetCommand = (args: readonly string[], context: DatasetContext) => Promise<number>;

export type DatasetCommands = Readonly<Record<DatasetCommandName, DatasetCommand>>;

/**
 * bench/dataset/commands.ts's DATASET_COMMANDS, or nothing while that file is not in the tree. A
 * glob, not an import: M3-T11 and M3-T12 are built side by side (wave 2), so neither branch holds
 * the other's file, and an import would break this branch's build. The glob matches the file once
 * it is there and nothing before, so the CLI needs no edit when the two merge. Vite expands it at
 * build time (the bench build and Vitest); Node never sees it. Not being an `import` statement, it
 * is not walked by run/imports.test.ts; bench/dataset/imports.test.ts keeps that graph free of
 * Electron. Once both have merged, it may become `import { DATASET_COMMANDS } from
 * '../dataset/commands'`, with findDatasetCommands and its test going with it.
 */
const FOUND: Readonly<Record<string, unknown>> = import.meta.glob('../dataset/commands.ts', {
  eager: true,
  import: 'DATASET_COMMANDS',
});

/** The test-set commands of this build, or null when it has none (M3-T12 not merged). */
export function findDatasetCommands(): DatasetCommands | null {
  return datasetCommandsIn(FOUND);
}

/**
 * The table the glob found, checked: one missing a command (or a file that exports no
 * DATASET_COMMANDS) is refused naming what is missing, not called into as undefined later.
 */
export function datasetCommandsIn(
  found: Readonly<Record<string, unknown>>,
): DatasetCommands | null {
  // One path with no wildcard: the glob matched that file or nothing.
  const tables = Object.values(found);
  if (tables.length === 0) return null;
  const [table] = tables;
  if (!isCommandTable(table)) {
    throw new Error(
      'bench/dataset/commands.ts must export DATASET_COMMANDS with a function for each of ' +
        `${DATASET_COMMAND_NAMES.join(', ')}; it has none for ${missingCommands(table).join(', ')}`,
    );
  }
  return table;
}

/**
 * Runs a test-set command with the words after its name; resolves with its exit code. Without
 * M3-T12's file in this build it says so, rather than "unknown command".
 */
export function runDatasetCommand(
  command: { name: DatasetCommandName; args: readonly string[] },
  context: DatasetContext,
  commands: DatasetCommands | null,
): Promise<number> {
  if (commands === null) {
    return Promise.reject(
      new Error(
        `${command.name} is one of the test-set tools (M3-T12, bench/dataset/commands.ts), ` +
          'which this build does not have yet',
      ),
    );
  }
  return commands[command.name](command.args, context);
}

/** The names `table` has no function for: all of them when it is not an object. */
function missingCommands(table: unknown): DatasetCommandName[] {
  if (typeof table !== 'object' || table === null) return [...DATASET_COMMAND_NAMES];
  return DATASET_COMMAND_NAMES.filter((name) => typeof Reflect.get(table, name) !== 'function');
}

/**
 * Each name a function. What a function takes and resolves with cannot be checked at run time; the
 * types above match M3-T12's, so a static import would accept the same table.
 */
function isCommandTable(table: unknown): table is DatasetCommands {
  return missingCommands(table).length === 0;
}
