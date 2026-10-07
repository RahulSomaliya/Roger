import { describe, expect, it } from 'vitest';
import { rendererSource } from '../theme/rendererSources';

/**
 * The prompt panel is its own page and loads tokens.css and prompt.css, never styles.css, so it
 * keeps a copy of the few primitives it borrows (prompt.css, Trap). Two ways the copy goes wrong
 * without a test saying so: a `.btn` change in styles.css that the panel never gets (its primary
 * button turns into the old look), and a `var(--x)` that only styles.css defines (tokenReads.test.ts
 * pools every sheet, so it passes, and the panel paints nothing for it).
 */

const PROMPT = rendererSource('src/prompt/prompt.css');
const STYLES = rendererSource('src/styles.css');
const TOKENS = rendererSource('src/theme/tokens.css');

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Flat rules (no nesting inside) as normalised selector to normalised body. */
function flatRules(css: string): Map<string, string> {
  const rules = new Map<string, string>();
  for (const [, selector = '', body = ''] of withoutComments(css).matchAll(
    /([^{}]+)\{([^{}]*)\}/g,
  )) {
    rules.set(squash(selector), squash(body));
  }
  return rules;
}

describe('prompt.css', () => {
  it('copies .btn and .problem from styles.css exactly, so the panel never drifts from the app', () => {
    const copied = [...flatRules(PROMPT)].filter(([selector]) =>
      /^\.(btn|problem)\b/.test(selector),
    );
    // A guard on the guard: a regex that matched nothing would pass on any drift.
    expect(copied.length).toBeGreaterThanOrEqual(8);
    const app = flatRules(STYLES);
    for (const [selector, body] of copied) {
      expect(app.get(selector), `${selector} is not in styles.css`).toBe(body);
    }
  });

  it('reads only custom properties that tokens.css or prompt.css define', () => {
    const defined = new Set(
      [...withoutComments(`${TOKENS}\n${PROMPT}`).matchAll(/(--[\w-]+)\s*:/g)].map(
        ([, name = '']) => name,
      ),
    );
    const read = [...withoutComments(PROMPT).matchAll(/var\(\s*(--[\w-]+)/g)].map(
      ([, name = '']) => name,
    );
    expect(read.length).toBeGreaterThan(20);
    expect(read.filter((name) => !defined.has(name))).toEqual([]);
  });
});
