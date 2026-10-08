import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CaptureWarning } from '../../../../shared/capture';
import { formatClockTime } from '../../app/labels';
import { WarningBanner } from './WarningBanner';

const NO_CALL_AUDIO: CaptureWarning = {
  kind: 'no-audio',
  source: 'system',
  since: '2026-10-07T09:12:00.000Z',
  message:
    'No call audio has reached Roger for 5 seconds: it cannot hear the call. If it does not come back, press Stop, then Start again.',
  loud: true,
};
const HELPER_HUNG: CaptureWarning = {
  kind: 'helper-hung',
  source: 'system',
  since: '2026-10-07T09:12:03.000Z',
  message: 'Call audio stopped: the call audio helper stopped responding, so Roger restarted it.',
  loud: true,
};
const CALL_SILENT: CaptureWarning = {
  kind: 'call-audio-silent',
  source: 'system',
  since: '2026-10-07T09:20:00.000Z',
  message:
    'Call audio is silent. That is normal in a pause; if the others are talking, Roger is not hearing them.',
  loud: false,
};
const OFFLINE: CaptureWarning = {
  kind: 'offline',
  source: null,
  since: '2026-10-07T09:30:00.000Z',
  message:
    'The Mac is offline, so transcription stopped. Roger reconnects on its own when the network is back.',
  loud: true,
};

const render = (warnings: CaptureWarning[]): string =>
  renderToStaticMarkup(createElement(WarningBanner, { warnings }));

describe('WarningBanner', () => {
  it('is a problem line, read out at once, with what to do and when it began', () => {
    const html = render([HELPER_HUNG, NO_CALL_AUDIO]);
    expect(html).toContain('class="problem"');
    expect(html).toContain('role="alert"');
    expect(html).toContain(HELPER_HUNG.message);
    expect(html).toContain('No call audio has reached Roger for 5 seconds');
    // The time is folded into the line, not a heading row of its own, and is the earliest spell's.
    expect(html).toMatch(
      new RegExp(`class="problem-since">since ${formatClockTime(NO_CALL_AUDIO.since)}<`),
    );
    expect(html).not.toContain('Call audio (them)');
  });

  it('draws no box: no tint, no stream heading, no data-loud', () => {
    const html = render([OFFLINE]);
    // Not `toContain('capture-warning')`: the wrapper is `capture-warnings`.
    expect(html).not.toMatch(/class="(?:[^"]* )?capture-warning[" ]/);
    expect(html).not.toContain('This recording');
  });

  it('puts each stream on its own line', () => {
    const html = render([OFFLINE, NO_CALL_AUDIO]);
    expect(html.match(/role="alert"/g)).toHaveLength(2);
  });

  it('leaves the quiet warnings to Details: the band never shows "normal in a pause"', () => {
    expect(render([CALL_SILENT])).toBe('');
    const html = render([CALL_SILENT, NO_CALL_AUDIO]);
    expect(html).not.toContain('normal in a pause');
    expect(html).toContain(NO_CALL_AUDIO.message);
  });

  it('shows nothing while nothing is wrong', () => {
    expect(render([])).toBe('');
  });
});
