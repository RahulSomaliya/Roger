import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConflictBanner } from './ConflictBanner';

describe('ConflictBanner', () => {
  it('says the notes changed elsewhere, that both are kept, and offers both versions', () => {
    const html = renderToStaticMarkup(
      createElement(ConflictBanner, { onResolve: () => Promise.resolve() }),
    );
    expect(html).toMatch(/^<div class="note-conflict" role="alert">/);
    expect(html).toContain('These notes also changed somewhere else.');
    expect(html).toContain('yours is kept as a copy');
    // "Use mine" puts the copy back; "Keep this version" keeps what the editor shows.
    expect(html).toMatch(/<button type="button" class="note-button note-button-primary">Use mine</);
    expect(html).toMatch(/<button type="button" class="note-button">Keep this version</);
  });
});
