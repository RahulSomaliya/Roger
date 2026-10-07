import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CaptureWarning } from '../../../../shared/capture';
import { formatClockTime } from '../../app/labels';
import { WarningNotes } from './WarningNotes';

const NO_CALL_AUDIO: CaptureWarning = {
  kind: 'no-audio',
  source: 'system',
  since: '2026-10-07T09:12:00.000Z',
  message:
    'No call audio has reached Roger for 5 seconds: it cannot hear the call. If it does not come back, press Stop, then Start again.',
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

const render = (warnings: CaptureWarning[]): string =>
  renderToStaticMarkup(createElement(WarningNotes, { warnings }));

describe('WarningNotes', () => {
  it("says every warning in main's full words, with when it began", () => {
    const html = render([CALL_SILENT, NO_CALL_AUDIO]);
    expect(html).toContain(NO_CALL_AUDIO.message);
    expect(html).toContain(CALL_SILENT.message);
    expect(html).toContain(`since ${formatClockTime(NO_CALL_AUDIO.since)}`);
  });

  it('puts the loud ones first: they are what needs doing', () => {
    const html = render([CALL_SILENT, NO_CALL_AUDIO]);
    expect(html.indexOf('No call audio has reached')).toBeLessThan(
      html.indexOf('normal in a pause'),
    );
  });

  it('is a plain list: no alert and no tint, Details is not where a problem is announced', () => {
    const html = render([NO_CALL_AUDIO]);
    expect(html).not.toContain('role=');
  });

  it('shows nothing while nothing is wrong', () => {
    expect(render([])).toBe('');
  });
});
