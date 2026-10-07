import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConflictBanner } from './ConflictBanner';

describe('ConflictBanner', () => {
  it('says the notes changed elsewhere, that both are kept, and offers both versions', () => {
    const html = renderToStaticMarkup(
      createElement(ConflictBanner, { onResolve: () => Promise.resolve() }),
    );
    // A problem line, not a tinted box (docs/design.md, Problem line).
    expect(html).toMatch(/^<div class="problem note-conflict" role="alert"><svg/);
    expect(html).toContain('These notes also changed somewhere else.');
    expect(html).toContain('yours is kept as a copy');
    // "Use mine" puts the copy back; "Keep this version" keeps what the editor shows. Neither is
    // the page's primary: one secondary, one ghost.
    expect(html).toMatch(
      /<button type="button" class="btn" data-variant="secondary" data-size="sm">Use mine</,
    );
    expect(html).toMatch(
      /<button type="button" class="btn" data-variant="ghost" data-size="sm">Keep this version</,
    );
    expect(html).not.toContain('data-variant="primary"');
  });

  it('says so when the other version is one Roger cannot show', () => {
    const html = renderToStaticMarkup(
      createElement(ConflictBanner, {
        onResolve: () => Promise.resolve(),
        otherVersion: 'unshowable',
      }),
    );
    expect(html).toContain('These notes also changed somewhere else.');
    expect(html).toContain('Roger cannot show that version');
    expect(html).not.toContain('Roger shows that version here');
    expect(html).toContain('yours is kept as a copy');
    expect(html).toMatch(
      /<button type="button" class="btn" data-variant="secondary" data-size="sm">Use mine</,
    );
    expect(html).toMatch(
      /<button type="button" class="btn" data-variant="ghost" data-size="sm">Keep the other version</,
    );
  });
});
