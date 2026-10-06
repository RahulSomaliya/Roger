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

/**
 * The numbered list that starts at `lines[0]`, up to its first blank line: one entry per rule, its
 * wrapping undone, so rewrapping either copy is not drift and rewording one is. A rule starts at a
 * number with at most one space before it (` 9.` and `10.` in the code comment); its wrapped lines
 * are indented three spaces or more in both copies, so a number that wraps to the start of a line
 * is not taken for a new rule.
 */
function numberedRules(lines: string[]): string[] {
  const rules: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') break;
    if (/^ ?\d+\. /.test(line)) {
      rules.push(line.trim());
      continue;
    }
    const rule = rules.pop();
    if (rule === undefined) throw new Error(`a numbered list must start with a rule, not: ${line}`);
    rules.push(`${rule} ${line.trim()}`);
  }
  return rules;
}

/** The rules of the first numbered list after the line `isHeading` picks. */
function rulesUnder(
  lines: string[],
  isHeading: (line: string) => boolean,
  where: string,
): string[] {
  const heading = lines.findIndex(isHeading);
  if (heading === -1) throw new Error(`${where}: no heading for version ${NORMALISER_VERSION}`);
  const first = lines.findIndex((line, i) => i > heading && /^ ?1\. /.test(line));
  if (first === -1) throw new Error(`${where}: no numbered list after its version heading`);
  return numberedRules(lines.slice(first));
}

describe('docs/research/stt-benchmark.md', () => {
  it('lists the rules normalise.ts applies, under the version the bench scores with', () => {
    // The source of truth is normalise.ts's header comment, which numbers the rules in the order
    // the code applies them. A changed rule bumps NORMALISER_VERSION there; comparing the lists,
    // not only the doc's heading, catches a doc whose heading moved to the new version while its
    // rules stayed on the old one, and a rule reworded in one place only.
    const code = read('./core/normalise.ts')
      .split('\n')
      .map((line) => line.replace(/^\s*\* ?/, ''));
    const doc = read('../../../docs/research/stt-benchmark.md').split('\n');

    const codeRules = rulesUnder(
      code,
      (line) => line.startsWith(`Version ${NORMALISER_VERSION}, in the order applied`),
      'normalise.ts header comment',
    );
    const docRules = rulesUnder(
      doc,
      (line) => line === `## Normaliser, version ${NORMALISER_VERSION}`,
      'docs/research/stt-benchmark.md',
    );

    expect(codeRules.length).toBeGreaterThan(0);
    expect(docRules).toEqual(codeRules);
  });
});
