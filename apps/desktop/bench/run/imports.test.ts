import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The bench CLI runs in plain Node (`make bench`), outside Electron, and reaches far into the app:
 * the STT registry, the shared core, the open budget, the echo filter, the latency meter, the config
 * loader. An import of `electron`, or of an app module that pulls it in (the store, main/index.ts),
 * breaks the bench at run time while the app and every unit test stay green. So the whole graph of
 * runtime imports from bench/cli.ts is walked here (type-only imports are erased and skipped) and
 * may leave the repo only for Node built-ins and `ws`, which the STT core needs.
 */

const ALLOWED_PACKAGES = ['ws'];
const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every module specifier a file imports at run time. */
function runtimeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const statement = /^\s*(import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(statement)) {
    if (match[2] !== undefined) continue;
    specifiers.push(match[3] ?? '');
  }
  return specifiers;
}

function resolveModule(from: string, specifier: string): string {
  const base = join(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  throw new Error(`${relative(DESKTOP, from)} imports ${specifier}, which does not resolve`);
}

function walk(entry: string): { files: Set<string>; packages: Map<string, string> } {
  const files = new Set<string>();
  const packages = new Map<string, string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) queue.push(resolveModule(file, specifier));
      else if (!specifier.startsWith('node:')) packages.set(specifier, relative(DESKTOP, file));
    }
  }
  return { files, packages };
}

describe('bench CLI imports', () => {
  it('reaches only Node built-ins and ws from bench/cli.ts, never Electron', () => {
    const { files, packages } = walk(join(DESKTOP, 'bench', 'cli.ts'));

    // The walk did reach the app's STT code, so the check covers what the bench runs.
    expect([...files].map((file) => relative(DESKTOP, file))).toEqual(
      expect.arrayContaining([
        'src/main/stt/registry.ts',
        'src/main/stt/core/SttConnection.ts',
        'src/main/capture/SttOpenBudget.ts',
        'src/main/capture/echo/EchoFilter.ts',
        'src/main/stt/LatencyMeter.ts',
      ]),
    );
    for (const [name, importer] of packages) {
      expect(ALLOWED_PACKAGES, `${importer} imports ${name}`).toContain(name);
    }
  });

  it('skips type-only imports, which the build erases', () => {
    expect(
      runtimeSpecifiers(
        "import type { A } from 'electron';\nimport { type B, c } from './c';\nexport { d } from './d';\n",
      ),
    ).toEqual(['./c', './d']);
  });
});
