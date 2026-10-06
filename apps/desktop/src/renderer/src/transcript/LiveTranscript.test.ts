import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AudioSource, TranscriptSegment } from '../../../shared/transcript';
import { SPEAKER_FOR_SOURCE } from '../../../shared/transcript';
import { LiveTranscript, type LiveTranscriptProps, TranscriptRow } from './LiveTranscript';
import type { FinalLine, InterimLine } from './liveTranscriptModel';
import { CitationNavigatorProvider, useRegisterTranscript } from './transcriptNavigator';
import type * as Navigator from './transcriptNavigator';

// The real navigator, with its registration hook watched: the panel must register through it.
vi.mock('./transcriptNavigator', async (importOriginal) => {
  const actual = await importOriginal<typeof Navigator>();
  return { ...actual, useRegisterTranscript: vi.fn(actual.useRegisterTranscript) };
});

const MEETING = '9b2e6f10-7c4d-4a5b-8e3f-61a0c2d9e874';

function line(id: string, source: AudioSource, startMs: number, text: string): TranscriptSegment {
  return {
    id,
    meetingId: MEETING,
    source,
    speaker: SPEAKER_FOR_SOURCE[source],
    startMs,
    endMs: startMs + 1500,
    text,
    confidence: 0.9,
    words: null,
    createdAt: '2026-10-06T10:00:00.000Z',
  };
}

const STORED = [
  line(
    '4f6c2a1e-8b3d-4e5f-9a7b-1c2d3e4f5a01',
    'system',
    61_000,
    'So the main thing is the renewal.',
  ),
  line('4f6c2a1e-8b3d-4e5f-9a7b-1c2d3e4f5a02', 'mic', 3_725_000, "Let's start with the price."),
];

/** Server rendering: the first render only, with no effect run (no subscription, no scroll). */
function render(props: Partial<LiveTranscriptProps> = {}): string {
  return renderToString(
    createElement(CitationNavigatorProvider, {
      children: createElement(LiveTranscript, {
        meetingId: MEETING,
        storedLines: STORED,
        showHidden: false,
        live: true,
        ...props,
      }),
    }),
  );
}

describe('LiveTranscript', () => {
  it('draws each final line with its id, time from the meeting start and speaker', () => {
    const html = render();
    const rows = [...html.matchAll(/<p [^>]*data-segment-id="([^"]+)"[^>]*>(.*?)<\/p>/g)];
    expect(rows.map(([, id]) => id)).toEqual(STORED.map((segment) => segment.id));
    expect(rows[0]?.[2]).toContain('00:01:01');
    expect(rows[0]?.[2]).toContain('Them');
    expect(rows[0]?.[2]).toContain('So the main thing is the renewal.');
    expect(rows[1]?.[2]).toContain('01:02:05');
    expect(rows[1]?.[2]).toContain('Me');
  });

  it('scrolls in a labelled log a keyboard can reach', () => {
    expect(render()).toMatch(/<div[^>]*role="log"[^>]*aria-label="Transcript"[^>]*tabindex="0"/);
  });

  it('registers its scroll container with the citation navigator', () => {
    render();
    // null on the first render: the container element does not exist until React commits it.
    expect(vi.mocked(useRegisterTranscript)).toHaveBeenCalledWith(null);
  });

  it('says what an empty transcript means, live or past', () => {
    expect(render({ storedLines: [] })).toContain('Listening. Lines appear here as people speak.');
    expect(render({ storedLines: [], live: false })).toContain(
      'Nothing was transcribed in this meeting.',
    );
  });

  it('follows a live meeting from the start, so there is no Jump to live yet', () => {
    expect(render()).not.toContain('Jump to live');
    expect(render({ live: false })).not.toContain('Jump to live');
  });

  it('draws the lines of a past meeting the same way', () => {
    const html = render({ live: false });
    expect(html.match(/data-segment-id=/g)).toHaveLength(2);
  });
});

describe('TranscriptRow', () => {
  const echo: FinalLine = {
    kind: 'final',
    id: '4f6c2a1e-8b3d-4e5f-9a7b-1c2d3e4f5a03',
    source: 'mic',
    speaker: 'me',
    startMs: 62_000,
    endMs: 64_000,
    text: 'So the main thing is the renewal.',
    hidden: true,
  };

  it('marks a line the echo filter hid as echo, keeping its id', () => {
    const html = renderToString(createElement(TranscriptRow, { item: echo }));
    expect(html).toContain('data-segment-id="4f6c2a1e-8b3d-4e5f-9a7b-1c2d3e4f5a03"');
    expect(html).toContain('data-echo="hidden"');
    expect(html).toMatch(/>echo</);
    expect(html).toContain('So the main thing is the renewal.');
  });

  it('marks nothing on a shown line', () => {
    const html = renderToString(createElement(TranscriptRow, { item: { ...echo, hidden: false } }));
    expect(html).not.toContain('data-echo');
    expect(html).not.toMatch(/>echo</);
  });

  it('draws an interim grey, with no id, and keeps it from screen readers until it is final', () => {
    const interim: InterimLine = {
      kind: 'interim',
      source: 'system',
      speaker: 'them',
      startMs: 65_000,
      endMs: 66_000,
      text: 'and procurement wants',
    };
    const html = renderToString(createElement(TranscriptRow, { item: interim }));
    expect(html).toContain('data-interim="true"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('data-segment-id');
    expect(html).toContain('Them');
    expect(html).toContain('and procurement wants');
  });
});
