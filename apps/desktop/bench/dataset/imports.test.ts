import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The bench runs in plain Node (`pnpm bench`), outside Electron, as bench/core does (see
 * core/imports.test.ts): an import of `electron`, or of an app module that pulls it in (the
 * logger, the store), breaks `make bench` while the app and these tests stay green. So
 * bench/dataset imports only Node built-ins, its own files, bench/core and the pure app modules
 * below. The backup is read with `node:sqlite` directly, never through the app's store.
 */
const PURE_APP_MODULES = ['../../src/main/stt/json', '../../src/shared/transcript'];

describe('bench/dataset imports', () => {
  it('imports only Node built-ins, bench files and pure app modules', () => {
    const folder = new URL('./', import.meta.url);
    const sources = readdirSync(folder).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    const outside = sources.flatMap((name) =>
      [...readFileSync(new URL(name, folder), 'utf8').matchAll(/from '([^']+)'/g)]
        .map((match) => match[1] ?? '')
        .filter(
          (specifier) =>
            !specifier.startsWith('node:') && !/^\.{1,2}\/(core\/)?[\w.]+$/.test(specifier),
        )
        .map((specifier) => `${name}: ${specifier}`),
    );

    expect(sources).toEqual(
      expect.arrayContaining([
        'backup.ts',
        'check.ts',
        'clip.ts',
        'commands.ts',
        'draft.ts',
        'forget.ts',
        'item.ts',
      ]),
    );
    for (const entry of outside) {
      expect(PURE_APP_MODULES, entry).toContain(entry.slice(entry.indexOf(': ') + 2));
    }
  });
});
