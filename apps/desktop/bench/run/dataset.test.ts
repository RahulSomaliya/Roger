import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type DatasetCommand,
  type DatasetCommands,
  datasetCommandsIn,
  findDatasetCommands,
  runDatasetCommand,
} from './dataset';

const BENCH = '/Users/someone/Roger-bench';

function fakeCommands(calls: string[]): DatasetCommands {
  const command =
    (name: string, exitCode: number): DatasetCommand =>
    (args, context) => {
      calls.push(`${name} [${args.join(' ')}] in ${context.benchDir}`);
      context.print(`${name} done`);
      return Promise.resolve(exitCode);
    };
  return {
    clip: command('clip', 0),
    draft: command('draft', 0),
    check: command('check', 1),
    forget: command('forget', 0),
  };
}

describe('runDatasetCommand', () => {
  it('hands the words after the name and the bench folder to the command, and returns its code', async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    const context = { benchDir: BENCH, print: (line: string) => lines.push(line) };

    const forgot = await runDatasetCommand(
      { name: 'forget', args: ['--person', 'Ana'] },
      context,
      fakeCommands(calls),
    );
    const checked = await runDatasetCommand(
      { name: 'check', args: [] },
      context,
      fakeCommands(calls),
    );

    expect([forgot, checked]).toEqual([0, 1]);
    expect(calls).toEqual([`forget [--person Ana] in ${BENCH}`, `check [] in ${BENCH}`]);
    expect(lines).toEqual(['forget done', 'check done']);
  });

  it('says the test-set tools are not in this build, naming the command', async () => {
    await expect(
      runDatasetCommand(
        { name: 'clip', args: ['--meeting', 'm-1'] },
        { benchDir: BENCH, print: () => undefined },
        null,
      ),
    ).rejects.toThrow(/clip is one of the test-set tools \(M3-T12, bench\/dataset\/commands\.ts\)/);
  });
});

describe('datasetCommandsIn', () => {
  it('is null when the glob matched no file', () => {
    expect(datasetCommandsIn({})).toBeNull();
  });

  it('returns the table the file exports', () => {
    const commands = fakeCommands([]);

    expect(datasetCommandsIn({ '../dataset/commands.ts': commands })).toBe(commands);
  });

  it('refuses a table without all four commands, naming the missing ones', () => {
    const { clip, draft } = fakeCommands([]);

    expect(() => datasetCommandsIn({ '../dataset/commands.ts': { clip, draft } })).toThrow(
      /DATASET_COMMANDS .* has none for check, forget/,
    );
    // The file is there but exports no DATASET_COMMANDS (renamed, say).
    expect(() => datasetCommandsIn({ '../dataset/commands.ts': undefined })).toThrow(
      /has none for clip, draft, check, forget/,
    );
  });
});

describe('findDatasetCommands', () => {
  it("finds M3-T12's table exactly when bench/dataset/commands.ts is in the tree", () => {
    const file = fileURLToPath(new URL('../dataset/commands.ts', import.meta.url));

    // Before M3-T12 merges: no file, no table. After: the file's table, checked.
    expect(findDatasetCommands() !== null).toBe(existsSync(file));
  });
});
