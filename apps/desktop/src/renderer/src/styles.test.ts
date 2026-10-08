import { describe, expect, it } from 'vitest';
import { rendererSource } from './theme/rendererSources';
import { cssDeclarations } from './theme/cssDeclarations';

/**
 * The rules in styles.css that docs/design.md names and a later edit could drop without a screen
 * failing: the tokens live here and not in tokens.css, `hidden` always hides, reduced motion zeroes
 * every duration, only opacity and transform animate, and a state indicator never fades. The look
 * itself is the QA gallery's job.
 */

const SHEET = rendererSource('src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
const TOKENS = rendererSource('src/theme/tokens.css');

/** The text between the braces of the first block whose prelude matches `prelude`. */
function blockOf(prelude: RegExp): string {
  const match = prelude.exec(SHEET);
  if (!match) throw new Error(`styles.css has no block for ${String(prelude)}`);
  let depth = 1;
  const start = match.index + match[0].length;
  for (let at = start; at < SHEET.length; at += 1) {
    if (SHEET.charAt(at) === '{') depth += 1;
    if (SHEET.charAt(at) === '}') depth -= 1;
    if (depth === 0) return SHEET.slice(start, at);
  }
  throw new Error(`styles.css never closes ${String(prelude)}`);
}

describe('styles.css', () => {
  it('defines the type, space, radius and motion tokens, which tokens.css must not hold', () => {
    const root = new Set(
      cssDeclarations(blockOf(/:root\s*\{/).replace(/^/, '.x{') + '}').map((d) => d.property),
    );
    for (const name of [
      '--text-xs',
      '--text-sm',
      '--text-base',
      '--text-lg',
      '--text-xl',
      '--text-2xl',
      '--text-3xl',
      '--space-1',
      '--space-2',
      '--space-3',
      '--space-4',
      '--space-6',
      '--space-8',
      '--space-12',
      '--space-16',
      '--space-24',
      '--radius-md',
      '--radius-lg',
      '--radius-full',
      '--ease-out',
      '--ease-in',
      '--measure',
    ]) {
      expect(root, name).toContain(name);
      expect(TOKENS, name).not.toContain(`${name}:`);
    }
  });

  it('lets `hidden` win over any class that sets display', () => {
    expect(blockOf(/\[hidden\]\s*\{/)).toMatch(/display:\s*none\s*!important/);
  });

  it('zeroes every duration and delay under reduced motion', () => {
    const rules = blockOf(/@media \(prefers-reduced-motion: reduce\)\s*\{/);
    expect(rules).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(rules).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(rules).toMatch(/animation-delay:\s*0s\s*!important/);
    expect(rules).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });

  it('animates only opacity and transform', () => {
    const names = [...SHEET.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)].map((m) => m[1] ?? '');
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const name of names) {
      const body = blockOf(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
      const properties = cssDeclarations(`.x{${body}}`).map((d) => d.property);
      expect(properties.length, name).toBeGreaterThan(0);
      for (const property of properties)
        expect(['opacity', 'transform'], `${name}: ${property}`).toContain(property);
    }
  });

  it('has the three button variants at 32, 40 and 48 px, and a busy state that keeps its colour', () => {
    expect(SHEET).toMatch(/\.btn\[data-size='sm'\]\s*\{[^}]*height:\s*32px/);
    expect(SHEET).toMatch(/\.btn\s*\{[^}]*height:\s*40px/);
    expect(SHEET).toMatch(/\.btn\[data-size='lg'\]\s*\{[^}]*height:\s*48px/);
    expect(SHEET).toContain(".btn[data-variant='primary']");
    expect(SHEET).toContain(".btn[data-variant='ghost']");
    // Busy is aria-disabled, never `disabled`: no opacity on it.
    expect(blockOf(/\.btn\[aria-disabled='true'\]\s*\{/)).not.toMatch(/opacity/);
  });

  it('never fades a state indicator: no transition on a tab or the recording dot', () => {
    for (const prelude of [
      /\.tab\s*\{/,
      /\.tab\[aria-selected='true'\]\s*\{/,
      /\.recording-dot\s*\{/,
    ]) {
      expect(blockOf(prelude)).not.toMatch(/transition/);
    }
  });
});
