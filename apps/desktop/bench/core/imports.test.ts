import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The bench runs in plain Node (`pnpm bench`), outside Electron. An import of `electron`, or of an
 * app module that pulls it in (the logger, the store), breaks the bench at run time while the app
 * and these tests stay green. So bench/core may import only Node built-ins, its own files and the
 * pure app modules below; a new app import is added here once it is checked to be Electron-free.
 */
const PURE_APP_MODULES = [
  '../../src/main/stt/SpeechToText',
  '../../src/main/stt/json',
  '../../src/shared/ipc',
  '../../src/shared/transcript',
];

describe('bench/core imports', () => {
  it('imports only Node built-ins, its own files and pure app modules', () => {
    const folder = new URL('./', import.meta.url);
    const sources = readdirSync(folder).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    const outside = sources.flatMap((name) =>
      [...readFileSync(new URL(name, folder), 'utf8').matchAll(/from '([^']+)'/g)]
        .map((match) => match[1] ?? '')
        .filter((specifier) => !specifier.startsWith('node:') && !/^\.\/[\w.]+$/.test(specifier))
        .map((specifier) => `${name}: ${specifier}`),
    );

    expect(sources.length).toBeGreaterThanOrEqual(9);
    for (const entry of outside) {
      expect(PURE_APP_MODULES, entry).toContain(entry.slice(entry.indexOf(': ') + 2));
    }
  });
});
