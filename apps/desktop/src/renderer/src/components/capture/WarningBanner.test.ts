import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CaptureWarning } from '../../../../shared/capture';
import { formatClockTime } from '../../app/labels';
import { WarningBanner, warningRows } from './WarningBanner';

// Messages as main writes them (capture/warnings.ts, audio/system/TapSystemAudio.ts).
const HELPER_HUNG: CaptureWarning = {
  kind: 'helper-hung',
  source: 'system',
  since: '2026-10-07T09:12:03.000Z',
  message: 'Call audio stopped: the call audio helper stopped responding, so Roger restarted it.',
  loud: true,
};
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
const MIC_DEAD: CaptureWarning = {
  kind: 'mic-dead',
  source: 'mic',
  since: '2026-10-07T09:21:00.000Z',
  message:
    'The mic sends only silence: Roger cannot hear you. Check that the input volume is not at 0 and that Roger is on under System Settings, Privacy & Security, Microphone.',
  loud: true,
};
const OFFLINE: CaptureWarning = {
  kind: 'offline',
  source: null,
  since: '2026-10-07T09:30:00.000Z',
  message:
    'The Mac is offline, so transcription stopped. Roger reconnects on its own when the network is back.',
  loud: true,
};
const BACKUP_PAUSED: CaptureWarning = {
  kind: 'backup-paused',
  source: null,
  since: '2026-10-07T09:31:00.000Z',
  message:
    "Less than 2 GB of disk is free, so Roger stopped keeping this call's audio. The transcript goes on; free some space and the backup starts again.",
  loud: true,
};

const render = (warnings: CaptureWarning[]): string =>
  renderToStaticMarkup(createElement(WarningBanner, { warnings }));

describe('warningRows', () => {
  it("puts a stream's warnings in one row: a helper restart and no audio, both said once", () => {
    const rows = warningRows([HELPER_HUNG, NO_CALL_AUDIO]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'system', loud: true });
    expect(rows[0]?.messages).toEqual([HELPER_HUNG.message, NO_CALL_AUDIO.message]);
  });

  it('dates a row from the earliest spell in it', () => {
    expect(warningRows([HELPER_HUNG, NO_CALL_AUDIO])[0]?.since).toBe(NO_CALL_AUDIO.since);
  });

  it('shows loud rows before quiet ones, and keeps the order main sent otherwise', () => {
    const rows = warningRows([CALL_SILENT, OFFLINE, MIC_DEAD]);
    expect(rows.map(({ source, loud }) => [source, loud])).toEqual([
      [null, true],
      ['mic', true],
      ['system', false],
    ]);
  });

  it('makes a row loud when any of its warnings is, and says the loud one first', () => {
    const [row] = warningRows([CALL_SILENT, { ...NO_CALL_AUDIO, since: CALL_SILENT.since }]);
    expect(row?.loud).toBe(true);
    expect(row?.messages).toEqual([NO_CALL_AUDIO.message, CALL_SILENT.message]);
  });

  it('gives the warnings about neither stream (offline, the backup) a row of their own', () => {
    const rows = warningRows([OFFLINE, MIC_DEAD, BACKUP_PAUSED]);
    expect(rows.map(({ source }) => source)).toEqual([null, 'mic']);
    expect(rows[0]?.messages).toEqual([OFFLINE.message, BACKUP_PAUSED.message]);
  });

  it('says the same words once, whoever raised them', () => {
    const [row] = warningRows([NO_CALL_AUDIO, { ...NO_CALL_AUDIO, kind: 'source-ended' }]);
    expect(row?.messages).toEqual([NO_CALL_AUDIO.message]);
  });
});

describe('WarningBanner', () => {
  it('names the stream and when it began, and reads a loud row out at once', () => {
    const html = render([HELPER_HUNG, NO_CALL_AUDIO]);
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-loud="true"');
    expect(html).toContain('Call audio (them)');
    expect(html).toContain(`since ${formatClockTime(NO_CALL_AUDIO.since)}`);
    expect(html).toContain(HELPER_HUNG.message);
    expect(html).toContain('No call audio has reached Roger for 5 seconds');
  });

  it('shows a quiet row as a status, not an alert', () => {
    const html = render([CALL_SILENT]);
    expect(html).toContain('role="status"');
    expect(html).toContain('data-loud="false"');
    expect(html).not.toContain('role="alert"');
  });

  it('heads the warnings about neither stream "This recording"', () => {
    expect(render([OFFLINE])).toContain('This recording');
  });

  it('shows nothing while nothing is wrong', () => {
    expect(render([])).toBe('');
  });
});
