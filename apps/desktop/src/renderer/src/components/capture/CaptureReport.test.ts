import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CaptureReport as Report } from '../../../../shared/capture';
import { formatClockTime } from '../../app/labels';
import { CaptureReport } from './CaptureReport';

const REPORT: Report = {
  meetingId: 'm',
  stopReason: 'call-ended',
  gaps: [
    {
      id: 'g1',
      source: 'system',
      startMs: 61_000,
      endMs: 125_000,
      reason: 'offline',
      recoveredAt: '2026-10-07T10:30:00.000Z',
      recoverError: null,
    },
    {
      id: 'g2',
      source: 'mic',
      startMs: 300_000,
      endMs: 310_000,
      reason: 'stt_failed',
      recoveredAt: null,
      recoverError: 'the audio for it is gone',
    },
  ],
  events: [
    {
      at: '2026-10-07T09:01:00.000Z',
      offsetMs: 60_000,
      source: 'system',
      kind: 'warning',
      detail: { warning: 'offline', loud: true },
    },
    {
      at: '2026-10-07T09:02:35.000Z',
      offsetMs: 155_000,
      source: 'system',
      kind: 'warning-cleared',
      detail: { warning: 'offline', lastedMs: 95_000 },
    },
  ],
  echo: { hidden: 0, trimmed: 0, held: 0 },
  backup: { state: 'kept', bytes: 1, keepUntil: null, keptForRerun: true, message: null },
};

const render = (report: Report): string =>
  renderToStaticMarkup(createElement(CaptureReport, { report }));

describe('CaptureReport', () => {
  it('says why the recording ended and how the gaps stand', () => {
    const html = render(REPORT);
    expect(html).toContain('Roger stopped because the call ended.');
    expect(html).toContain('2 gaps, 1 transcribed again.');
  });

  it('lists each gap with its span, stream, reason and where transcribing it again stands', () => {
    const html = render(REPORT);
    expect(html).toContain('00:01:01 to 00:02:05');
    expect(html).toContain('Call audio');
    expect(html).not.toContain('Call audio (them)');
    expect(html).toContain('the Mac was offline');
    expect(html).toContain('data-status="recovered"');
    expect(html).toContain('Transcribing again failed: the audio for it is gone');
    expect(html).toContain('data-status="failed"');
  });

  it('keeps the timeline closed, counting its events, with each one’s time and words', () => {
    const html = render(REPORT);
    expect(html).toContain('<details');
    expect(html).not.toContain('<details open');
    expect(html).toContain('Timeline (2 events)');
    expect(html).toContain('Warning: the Mac is offline');
    expect(html).toContain('Cleared: the Mac is offline (lasted 1m 35s)');
    expect(html).toContain(formatClockTime('2026-10-07T09:01:00.000Z'));
  });

  it('says so plainly when nothing went wrong', () => {
    const html = render({ ...REPORT, stopReason: 'user', gaps: [], events: [] });
    expect(html).toContain('You pressed Stop.');
    expect(html).toContain('No gaps');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('<ul class="report-gaps"');
  });

  it('shows no stop line while the recording runs', () => {
    expect(render({ ...REPORT, stopReason: null })).not.toContain('report-stop');
  });
});
