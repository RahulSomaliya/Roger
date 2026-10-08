import { describe, expect, it } from 'vitest';
import { cssDeclarations } from './cssDeclarations';
import { rendererSources } from './rendererSources';

/**
 * Every `var(--x)` the renderer reads is a custom property something defines.
 *
 * Why a test: an undefined `var(--old)` paints nothing and fails nothing. After the token rename
 * a missed `var(--muted)` inherits its parent's colour in silence, right in one theme and wrong in
 * the other. tokens.test.ts pins the tokens themselves; this pins their readers.
 */

const STYLE_SHEETS = rendererSources((path) => path.endsWith('.css'));
const SCRIPTS = rendererSources(
  (path) => /\.tsx?$/.test(path) && !path.endsWith('.test.ts') && !path.endsWith('.d.ts'),
);

const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/**
 * Every custom property declared in a style sheet, or set from a script (`style={{ '--x': ... }}`).
 * Any sheet counts, not only tokens.css and styles.css: a page-level layout variable such as
 * `--shell-gutter` is declared beside the rules that read it.
 */
function definedProperties(
  sheets: Record<string, string>,
  scripts: Record<string, string>,
): Set<string> {
  const defined = new Set<string>();
  for (const text of Object.values(sheets)) {
    for (const { property } of cssDeclarations(text)) {
      if (property.startsWith('--')) defined.add(property);
    }
  }
  for (const text of Object.values(scripts)) {
    for (const [, name = ''] of withoutComments(text).matchAll(/['"](--[\w-]+)['"]\s*:/g)) {
      defined.add(name);
    }
  }
  return defined;
}

/** Each read of a property outside `defined`, as "path: --name". */
function undefinedReads(files: Record<string, string>, defined: ReadonlySet<string>): string[] {
  return Object.entries(files).flatMap(([path, text]) =>
    [...withoutComments(text).matchAll(/var\(\s*(--[\w-]+)/g)]
      .map(([, name = '']) => name)
      .filter((name) => !defined.has(name))
      .map((name) => `${path}: ${name}`),
  );
}

describe('the renderer reads only defined custom properties', () => {
  const defined = definedProperties(STYLE_SHEETS, SCRIPTS);
  const files = { ...STYLE_SHEETS, ...SCRIPTS };

  it('reads at least the tokens: an empty scan would pass on anything', () => {
    expect(defined).toContain('--canvas');
    expect(defined).toContain('--ink-muted');
    const reads = Object.values(files).flatMap((text) => [...text.matchAll(/var\(\s*--/g)]);
    expect(reads.length).toBeGreaterThan(100);
  });

  it('finds a read of a token that no longer exists', () => {
    const sample = { 'src/old.css': '.a { color: var(--muted); background: var(--canvas); }' };
    expect(undefinedReads(sample, defined)).toEqual(['src/old.css: --muted']);
    // A fallback does not make an undefined property defined.
    const withFallback = { 'src/old.css': '.a { color: var(--warn, red); }' };
    expect(undefinedReads(withFallback, defined)).toEqual(['src/old.css: --warn']);
  });

  it('ignores a token named in a comment', () => {
    const sample = { 'src/old.css': '/* was var(--muted) */ .a { color: var(--ink); }' };
    expect(undefinedReads(sample, defined)).toEqual([]);
  });

  it('has no read of an undefined custom property in any style sheet or script', () => {
    expect(undefinedReads(files, defined)).toEqual([]);
  });
});
