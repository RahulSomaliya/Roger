import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MeetingSummary } from '../../../shared/meetings';
import { Earlier, EARLIER_VISIBLE, type EarlierProps } from './Earlier';

const NOW = new Date(2026, 9, 7, 17, 30);
const LIVE = '9b2e6f10-7c4d-4a5b-8e3f-61a0c2d9e874';

function meeting(index: number, title = `Meeting ${index}`): MeetingSummary {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    title,
    startedAt: new Date(2026, 9, 6, 9, index).toISOString(),
    endedAt: new Date(2026, 9, 6, 10, index).toISOString(),
  };
}

function earlier(fields: Partial<EarlierProps> = {}): string {
  return renderToString(
    createElement(Earlier, {
      meetings: [],
      liveId: null,
      error: null,
      now: NOW,
      onOpen: vi.fn(),
      onRetry: vi.fn(),
      ...fields,
    }),
  );
}

const titles = (html: string): string[] =>
  [...html.matchAll(/class="earlier-title">([^<]*)</g)].map((match) => match[1] ?? '');

describe('Earlier', () => {
  it('is no list, not even a heading, until there is a past meeting', () => {
    expect(earlier({ meetings: undefined })).toBe('');
    expect(earlier({ meetings: [] })).toBe('');
  });

  it('lists a day and a title per meeting, in the order main gives, with the whole title on hover', () => {
    const html = earlier({
      meetings: [
        meeting(1, 'Northwind renewal: scope and pricing'),
        { ...meeting(2, 'Daily standup'), startedAt: new Date(2026, 9, 7, 9, 30).toISOString() },
        { ...meeting(3, 'Kickoff'), startedAt: new Date(2026, 9, 2, 9, 30).toISOString() },
      ],
    });
    expect(html).toContain('>Earlier</h2>');
    expect(titles(html)).toEqual([
      'Northwind renewal: scope and pricing',
      'Daily standup',
      'Kickoff',
    ]);
    expect(html).toContain('title="Northwind renewal: scope and pricing"');
    expect(html.match(/class="earlier-when">([^<]*)</g)).toEqual([
      'class="earlier-when">Yesterday<',
      'class="earlier-when">Today<',
      'class="earlier-when">Fri 2 Oct<',
    ]);
  });

  it('leaves the meeting Roger records to the hero', () => {
    const live = { ...meeting(9, 'Weekly sync'), id: LIVE, endedAt: null };
    expect(titles(earlier({ meetings: [live, meeting(1)], liveId: LIVE }))).toEqual(['Meeting 1']);
  });

  it('shows ten, then Show more for the rest', () => {
    const many = Array.from({ length: EARLIER_VISIBLE + 3 }, (_, i) => meeting(i + 1));
    const html = earlier({ meetings: many });
    expect(titles(html)).toHaveLength(EARLIER_VISIBLE);
    expect(html).toContain('Show more</button>');
    // Ten exactly needs no button.
    expect(earlier({ meetings: many.slice(0, EARLIER_VISIBLE) })).not.toContain('Show more');
  });

  it('says why the list failed, in a quiet line with Try again, and keeps the list it had', () => {
    const html = earlier({
      meetings: [meeting(1)],
      error: 'Roger could not list the meetings on this Mac: disk full',
    });
    expect(html).toMatch(
      /role="status"[^>]*><svg[^]*Roger could not list the meetings on this Mac: disk full/,
    );
    expect(html).toContain('Try again</button>');
    expect(titles(html)).toEqual(['Meeting 1']);
  });

  it('says why even when there is no list yet to show', () => {
    const html = earlier({ meetings: undefined, error: 'Roger could not list the meetings' });
    expect(html).toContain('Roger could not list the meetings');
    expect(html).toContain('Try again</button>');
  });
});
