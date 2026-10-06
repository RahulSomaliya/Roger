import { describe, expect, it } from 'vitest';
import { cssDeclarations } from './cssDeclarations';

const pairs = (css: string): string[] =>
  cssDeclarations(css).map(({ property, value }) => `${property}: ${value}`);

describe('cssDeclarations', () => {
  it('reads every rule, with or without a last semicolon', () => {
    expect(pairs('.a { color: var(--ink); gap: 4px } .b{margin:0}')).toEqual([
      'color: var(--ink)',
      'gap: 4px',
      'margin: 0',
    ]);
  });

  it('reads the declarations around a nested rule, at every depth', () => {
    expect(
      pairs(`
        .note { background: var(--panel); &:hover { background: var(--bg); } }
        .row { &:hover { color: var(--ink); } color: var(--muted); }
        .a { .b { .c { border: 0 } } outline: none }
      `),
    ).toEqual([
      'background: var(--panel)',
      'background: var(--bg)',
      'color: var(--ink)',
      'color: var(--muted)',
      'border: 0',
      'outline: none',
    ]);
  });

  it('never reads a selector or an at-rule prelude as a declaration', () => {
    expect(
      pairs(`
        @import './theme/tokens.css';
        @media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { --bg: x } }
        a:not(.red):hover { & + b:focus-visible { color: y } }
      `),
    ).toEqual(['--bg: x', 'color: y']);
  });

  it('skips comments, and keeps braces and semicolons inside strings and brackets', () => {
    expect(
      pairs(`
        /* .old { color: z } */
        .q { content: '}' ; quotes: "{" ";" }
        .i { background: url(data:image/svg+xml;utf8,x) }
      `),
    ).toEqual(["content: '}'", 'quotes: "{" ";"', 'background: url(data:image/svg+xml;utf8,x)']);
  });
});
