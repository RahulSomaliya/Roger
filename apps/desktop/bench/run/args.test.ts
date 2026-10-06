import { describe, expect, it } from 'vitest';
import { UsageError, parseBenchArgs } from './args';

const CWD = '/repo';

describe('parseBenchArgs', () => {
  it('gives help with no command, help or --help', () => {
    for (const argv of [[], ['help'], ['--help']]) {
      expect(parseBenchArgs(argv, CWD)).toEqual({ command: 'help' });
    }
  });

  it('reads run with its defaults: every item, keyterms on, 3 at a time', () => {
    expect(parseBenchArgs(['run'], CWD)).toEqual({
      command: 'run',
      itemIds: null,
      keyterms: true,
      parallel: 3,
    });
    expect(
      parseBenchArgs(
        ['run', '--items', 'standup-1, meet-2', '--no-keyterms', '--parallel', '1'],
        CWD,
      ),
    ).toEqual({ command: 'run', itemIds: ['standup-1', 'meet-2'], keyterms: false, parallel: 1 });
  });

  it('refuses a bad --parallel and an item id that is not a plain name', () => {
    expect(() => parseBenchArgs(['run', '--parallel', '0'], CWD)).toThrow(
      /--parallel must be a whole number from 1 to 10/,
    );
    expect(() => parseBenchArgs(['run', '--parallel', 'three'], CWD)).toThrow(UsageError);
    expect(() => parseBenchArgs(['run', '--items', '../x'], CWD)).toThrow(/item id "..\/x"/);
  });

  it('reads score and report --summary', () => {
    expect(parseBenchArgs(['score'], CWD)).toEqual({
      command: 'score',
      runId: null,
      echoFilter: true,
    });
    expect(parseBenchArgs(['score', '--run', '20261006-100000', '--no-echo-filter'], CWD)).toEqual({
      command: 'score',
      runId: '20261006-100000',
      echoFilter: false,
    });
    expect(parseBenchArgs(['report', '--summary'], CWD)).toEqual({ command: 'report' });
    expect(() => parseBenchArgs(['report'], CWD)).toThrow(/report takes --summary/);
  });

  it('resolves canary --save-wire against the folder make ran in', () => {
    expect(parseBenchArgs(['canary'], CWD)).toEqual({ command: 'canary', saveWireDir: null });
    expect(parseBenchArgs(['canary', '--save-wire', 'wire/out'], CWD)).toEqual({
      command: 'canary',
      saveWireDir: '/repo/wire/out',
    });
    expect(parseBenchArgs(['canary', '--save-wire', '/tmp/wire'], CWD)).toEqual({
      command: 'canary',
      saveWireDir: '/tmp/wire',
    });
  });

  it('refuses unknown commands, unknown options and stray arguments, naming them', () => {
    expect(() => parseBenchArgs(['bake'], CWD)).toThrow(/unknown command "bake"/);
    expect(() => parseBenchArgs(['run', '--gate'], CWD)).toThrow(/--gate/);
    expect(() => parseBenchArgs(['score', 'extra'], CWD)).toThrow(UsageError);
  });
});
