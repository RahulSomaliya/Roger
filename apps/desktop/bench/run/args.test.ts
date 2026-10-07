import { describe, expect, it } from 'vitest';
import { USAGE, UsageError, parseBenchArgs } from './args';

const CWD = '/repo';

describe('parseBenchArgs', () => {
  it('gives help with no command, help or --help', () => {
    for (const argv of [[], ['help'], ['--help']]) {
      expect(parseBenchArgs(argv, CWD)).toEqual({ command: 'help' });
    }
  });

  it('reads run with its defaults: every item, keyterms on, no gate, 3 at a time', () => {
    expect(parseBenchArgs(['run'], CWD)).toEqual({
      command: 'run',
      itemIds: null,
      keyterms: true,
      gate: false,
      parallel: 3,
    });
    expect(
      parseBenchArgs(
        ['run', '--items', 'standup-1, meet-2', '--no-keyterms', '--gate', '--parallel', '1'],
        CWD,
      ),
    ).toEqual({
      command: 'run',
      itemIds: ['standup-1', 'meet-2'],
      keyterms: false,
      gate: true,
      parallel: 1,
    });
    expect(USAGE).toMatch(/^ {2}run .*\[--gate\]/m);
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

  it('hands clip, draft, check and forget their words as given, for the test-set tools to parse', () => {
    const clip = ['--meeting', 'm-1', '--from', '0:00', '--to', '2:00', '--name', 'standup-1'];
    expect(parseBenchArgs(['clip', ...clip, '--person', 'Ana:2026-10-01'], CWD)).toEqual({
      command: 'dataset',
      name: 'clip',
      args: [...clip, '--person', 'Ana:2026-10-01'],
    });
    expect(parseBenchArgs(['draft', '--runs', 'a,b'], CWD)).toEqual({
      command: 'dataset',
      name: 'draft',
      args: ['--runs', 'a,b'],
    });
    expect(parseBenchArgs(['check'], CWD)).toEqual({ command: 'dataset', name: 'check', args: [] });
    expect(parseBenchArgs(['forget', '--person', 'Ana'], CWD)).toEqual({
      command: 'dataset',
      name: 'forget',
      args: ['--person', 'Ana'],
    });
  });

  it('lists every command of the M3 design in the usage', () => {
    for (const command of [
      'clip',
      'run',
      'draft',
      'check',
      'score',
      'report',
      'forget',
      'canary',
    ]) {
      expect(USAGE).toMatch(new RegExp(`^  ${command}\\b`, 'm'));
    }
  });

  it('refuses unknown commands, unknown options and stray arguments, naming them', () => {
    expect(() => parseBenchArgs(['bake'], CWD)).toThrow(/unknown command "bake"/);
    expect(() => parseBenchArgs(['run', '--fast'], CWD)).toThrow(/--fast/);
    expect(() => parseBenchArgs(['score', 'extra'], CWD)).toThrow(UsageError);
  });
});
