import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EchoLine } from './echoChanges';
import { describeEcho, echoLinesShow, EchoLines } from './EchoLines';

const HIDDEN: EchoLine = {
  segmentId: 'seg-hidden',
  source: 'mic',
  kind: 'hidden',
  text: 'so we ship on friday',
};
const TRIMMED: EchoLine = {
  segmentId: 'seg-trimmed',
  source: 'mic',
  kind: 'trimmed',
  text: 'and the budget',
};

function render(props: Partial<Parameters<typeof EchoLines>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(EchoLines, {
      counts: { hidden: 1, trimmed: 1, held: 0 },
      lines: [HIDDEN, TRIMMED],
      showHidden: false,
      onShowHidden: vi.fn(),
      onUnhide: vi.fn(),
      pending: new Set<string>(),
      error: null,
      ...props,
    }),
  );
}

describe('describeEcho', () => {
  it('says what the filter did, to the mic only', () => {
    expect(describeEcho({ hidden: 3, trimmed: 0, held: 0 })).toBe(
      'Roger hid 3 mic lines that repeated the call audio.',
    );
    expect(describeEcho({ hidden: 1, trimmed: 2, held: 0 })).toBe(
      'Roger hid 1 mic line that repeated the call audio, and cut repeated words out of 2 more.',
    );
    expect(describeEcho({ hidden: 0, trimmed: 1, held: 4 })).toBe(
      'Roger cut repeated words out of 1 mic line.',
    );
  });

  it('says nothing when it did nothing', () => {
    expect(describeEcho({ hidden: 0, trimmed: 0, held: 2 })).toBeNull();
  });
});

describe('EchoLines', () => {
  it('shows nothing when the filter changed no line', () => {
    expect(render({ counts: { hidden: 0, trimmed: 0, held: 0 }, lines: [] })).toBe('');
  });

  it('offers the toggle with the counts, and lists no text until it is on', () => {
    const html = render();
    expect(html).toContain('Roger hid 1 mic line that repeated the call audio');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('Show hidden and trimmed text');
    expect(html).not.toContain('so we ship on friday');
  });

  it('lists the changed lines once it is on, with Unhide on the hidden one only', () => {
    const html = render({ showHidden: true });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Hide echo text');
    expect(html).toContain('so we ship on friday');
    expect(html).toContain('and the budget');
    // Main refuses to unhide a trimmed line (TranscriptStore.unhideSegment): no button on it.
    expect(html.match(/>Unhide</g)).toHaveLength(1);
    const trimmed = html.slice(html.indexOf('data-echo-line="trimmed"'));
    expect(trimmed).not.toContain('Unhide');
  });

  it('names the line an Unhide acts on, and disables it while main answers', () => {
    const html = render({ showHidden: true, pending: new Set(['seg-hidden']) });
    expect(html).toContain('aria-label="Unhide: so we ship on friday"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Unhide</);
  });

  it('says the lines it cannot list: counted by main, changed before this window opened', () => {
    const html = render({
      showHidden: true,
      counts: { hidden: 4, trimmed: 1, held: 0 },
      lines: [HIDDEN, TRIMMED],
    });
    expect(html).toContain('3 more changed before this page opened and are not listed');
    expect(render({ showHidden: true })).not.toContain('not listed');
  });

  it('shows why an Unhide failed, as an alert', () => {
    const html = render({ showHidden: true, error: 'Line seg-hidden is not hidden' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Line seg-hidden is not hidden');
  });
});

describe('echoLinesShow', () => {
  it('is false when the filter did nothing and no line was seen', () => {
    expect(echoLinesShow(null, 0)).toBe(false);
    expect(echoLinesShow({ hidden: 0, trimmed: 0, held: 3 }, 0)).toBe(false);
  });

  it('is true for a hidden count, a trimmed count or a listed line', () => {
    expect(echoLinesShow({ hidden: 1, trimmed: 0, held: 0 }, 0)).toBe(true);
    expect(echoLinesShow({ hidden: 0, trimmed: 2, held: 0 }, 0)).toBe(true);
    expect(echoLinesShow({ hidden: 0, trimmed: 0, held: 0 }, 1)).toBe(true);
    expect(echoLinesShow(null, 1)).toBe(true);
  });
});
