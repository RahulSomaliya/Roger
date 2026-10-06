import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CitationAttrs } from '../../../shared/notes';
import { CitationChipButton } from './CitationChip';

const ATTRS: CitationAttrs = {
  segmentIds: ['fd9daa6d-24ad-4dec-8fca-01604dd531da'],
  startMs: 192_000,
  label: '03:12',
  support: 'ok',
};

const render = (attrs: CitationAttrs, removed = false): string =>
  renderToStaticMarkup(
    createElement(CitationChipButton, { attrs, removed, onReveal: () => undefined }),
  );

describe('CitationChipButton', () => {
  it('shows the time and says it opens the transcript there', () => {
    const html = render(ATTRS);
    expect(html).toMatch(/^<button type="button" class="citation-chip"/);
    expect(html).toContain('aria-label="Show the transcript at 03:12"');
    expect(html).toContain('>03:12<');
    expect(html).not.toContain('check this');
  });

  it("says check this when the line's sources may not back it", () => {
    const html = render({ ...ATTRS, support: 'weak' });
    expect(html).toContain('class="citation-chip citation-chip-weak"');
    expect(html).toContain('check this');
    expect(html).toMatch(/aria-label="Show the transcript at 03:12\. Check this line[^"]*"/);
  });

  it('says Line removed once the transcript no longer holds the line', () => {
    const html = render({ ...ATTRS, support: 'weak' }, true);
    expect(html).toContain('citation-chip-removed');
    expect(html).toContain('Line removed');
    expect(html).not.toContain('check this');
    expect(html).toContain('aria-label="The transcript line at 03:12 is no longer there"');
  });
});
