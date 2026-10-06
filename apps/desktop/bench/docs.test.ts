import { readFileSync, readdirSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { NORMALISER_VERSION } from './core/normalise';
import { benchDirSetting } from './run/benchDir';

/**
 * The bench is documented in two places outside its code: the Benchmark section of the repo-root
 * .env.example (house rule: it documents every variable) and docs/research/stt-benchmark.md, which
 * lists the normaliser's rules under its version. Both drift in silence when the code changes, so
 * these tests tie them to it (M3-T13).
 */

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

/**
 * The Benchmark section of .env.example as a copied .env hands it over: from its heading to the
 * next blank line, which ends every section of that file.
 */
function benchmarkSection(): Record<string, string | undefined> {
  const text = read('../../../.env.example');
  const start = text.indexOf('\n# Benchmark');
  if (start === -1) throw new Error('.env.example has no "# Benchmark" section');
  const end = text.indexOf('\n\n', start + 1);
  return parseEnv(text.slice(start, end === -1 ? undefined : end));
}

/**
 * The variables bench code reads itself (`env.ROGER_X`). The desktop's own, which the bench also
 * reads through the app's config, are documented in the Desktop section. Only `ROGER_*` keys can
 * count: the bench takes nothing else from the repo-root .env (run/env.ts).
 */
function variablesTheBenchReads(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(new URL('./', import.meta.url), {
    recursive: true,
    encoding: 'utf8',
  })) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file.startsWith('dist')) continue;
    for (const match of read(file).matchAll(/\benv(?:\.|\[')(ROGER_[A-Z0-9_]+)/g)) {
      names.add(match[1] ?? '');
    }
  }
  return [...names].sort();
}

describe('the Benchmark section of .env.example', () => {
  it('lists every variable the bench reads itself, and nothing else', () => {
    const names = variablesTheBenchReads();

    expect(names).toContain('ROGER_BENCH_DIR');
    expect(Object.keys(benchmarkSection()).sort()).toEqual(names);
  });

  it('keeps the test set of a .env copied from it in ~/Roger-bench, outside the checkout', () => {
    expect(benchDirSetting(benchmarkSection(), '/Users/ann')).toBe('/Users/ann/Roger-bench');
  });
});

describe('docs/research/stt-benchmark.md', () => {
  it('lists the normaliser rules of the version the bench scores with', () => {
    // normalise.ts bumps NORMALISER_VERSION whenever a rule changes; the doc's rules must follow.
    expect(read('../../../docs/research/stt-benchmark.md')).toContain(
      `## Normaliser, version ${NORMALISER_VERSION}`,
    );
  });
});
