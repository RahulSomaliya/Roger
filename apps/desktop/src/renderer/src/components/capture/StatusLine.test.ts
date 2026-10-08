import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CapturePhase, CaptureWarning } from '../../../../shared/capture';
import { formatClockTime } from '../../app/labels';
import { StatusLine } from './StatusLine';

const STARTED = '2026-10-07T09:00:00.000Z';
const at = (minutes: number): number => Date.parse(STARTED) + minutes * 60_000;

const NO_CALL_AUDIO: CaptureWarning = {
  kind: 'no-audio',
  source: 'system',
  since: '2026-10-07T09:12:00.000Z',
  message: 'No call audio has reached Roger for 5 seconds: it cannot hear the call.',
  loud: true,
};
const MIC_DEAD: CaptureWarning = {
  kind: 'mic-dead',
  source: 'mic',
  since: '2026-10-07T09:13:00.000Z',
  message: 'The mic sends only silence: Roger cannot hear you.',
  loud: true,
};
const CALL_SILENT: CaptureWarning = {
  kind: 'call-audio-silent',
  source: 'system',
  since: '2026-10-07T09:20:00.000Z',
  message: 'Call audio is silent. That is normal in a pause.',
  loud: false,
};

function line(
  props: {
    phase?: CapturePhase;
    startedAt?: string | null;
    nowMs?: number;
    warnings?: CaptureWarning[];
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(StatusLine, {
      phase: 'recording',
      startedAt: STARTED,
      nowMs: at(12) + 30_000,
      warnings: [],
      ...props,
    }),
  );
}

/** The text content, tags removed and the apostrophe React escapes read back. */
const text = (html: string): string => html.replace(/<[^>]*>/g, '').replaceAll('&#x27;', "'");

describe('StatusLine', () => {
  it('is one line while recording: "Recording · 12m", whole minutes', () => {
    const html = line();
    expect(text(html)).toBe('Recording · 12m');
    expect(html).toContain('aria-label="Meeting status"');
    // Not a live region: it changes every 15 s and a screen reader would read it out each time.
    expect(html).not.toContain('role=');
  });

  it('reads an hour as 1h 23m, and a start main has not reported as just "Recording"', () => {
    expect(text(line({ nowMs: at(83) }))).toBe('Recording · 1h 23m');
    expect(text(line({ startedAt: null }))).toBe('Recording');
  });

  it('says a loud problem in words, in the status line’s place, with when it began', () => {
    const html = line({ warnings: [NO_CALL_AUDIO] });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain(
      `Roger can't hear the call · since ${formatClockTime(NO_CALL_AUDIO.since)}`,
    );
    // The editor below must not move: the line is replaced, never added to.
    expect(html).not.toContain('Recording');
    // Main's long message (what to do) is the tooltip and Details' text, not a second line.
    expect(html).toContain(`title="${NO_CALL_AUDIO.message}"`);
  });

  // R8: a tooltip is hover only. The line takes focus and shows the whole message on it too;
  // aria-describedby hands the same text to a screen reader while the box stays closed.
  it('takes keyboard focus and holds the full message for focus and hover, not only a tooltip', () => {
    const html = line({ warnings: [NO_CALL_AUDIO] });
    const id = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeDefined();
    expect(html).toMatch(/class="problem meeting-status-problem"[^>]*tabindex="0"/);
    expect(html).toContain(`id="${id}" class="meeting-status-full">${NO_CALL_AUDIO.message}<`);
  });

  it('keeps to one line when two streams have a problem: the first, and how many more', () => {
    const html = line({ warnings: [MIC_DEAD, NO_CALL_AUDIO] });
    expect(text(html)).toContain("Roger can't hear you");
    expect(text(html)).toContain('· +1 more');
    expect(html.match(/role="alert"/g)).toHaveLength(1);
  });

  it('leaves the quiet warnings to Details', () => {
    expect(text(line({ warnings: [CALL_SILENT] }))).toBe('Recording · 12m');
  });

  it('says nothing before Roger records and while it stops: the button says it', () => {
    expect(line({ phase: 'starting' })).toBe('');
    expect(line({ phase: 'stopping' })).toBe('');
    expect(line({ phase: 'idle' })).toBe('');
  });
});
