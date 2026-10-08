import { describe, expect, it } from 'vitest';
import type { CaptureWarning, UploadStatus } from '../../../../shared/capture';
import { warningHeadline as sharedHeadline } from '../../../../shared/captureWords';
import { groupWarnings, refusedLinesProblem, warningHeadline } from './captureProblems';

const upload = (rejected: number): UploadStatus => ({
  state: 'idle',
  pending: 0,
  rejected,
  lastError: null,
  nextAttemptAt: null,
});

describe('refusedLinesProblem', () => {
  // House rule 1: lines the server refused for good never reach it, and the person must see that.
  // The capture panel's "Postgres" row said it before; this is what says it now.
  it('says nothing while the server took every line', () => {
    expect(refusedLinesProblem(upload(0))).toBeNull();
  });

  it('says one line or many, and that they stay on this Mac', () => {
    expect(refusedLinesProblem(upload(1))).toBe(
      "Roger's server refused 1 line for good. It stays saved on this Mac only.",
    );
    expect(refusedLinesProblem(upload(3))).toBe(
      "Roger's server refused 3 lines for good. They stay saved on this Mac only.",
    );
  });

  it('does not hide behind a retry in progress: a backoff is not a refusal', () => {
    expect(
      refusedLinesProblem({ ...upload(0), state: 'backoff', pending: 4, lastError: 'down' }),
    ).toBeNull();
  });
});

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

describe('groupWarnings', () => {
  it("puts a stream's loud warnings in one group: a helper restart and no audio, both said once", () => {
    const groups = groupWarnings([HELPER_HUNG, NO_CALL_AUDIO], true);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ source: 'system' });
    expect(groups[0]?.messages).toEqual([HELPER_HUNG.message, NO_CALL_AUDIO.message]);
  });

  it('dates a group from the earliest spell in it, and heads it with that warning', () => {
    const [group] = groupWarnings([HELPER_HUNG, NO_CALL_AUDIO], true);
    expect(group?.since).toBe(NO_CALL_AUDIO.since);
    expect(group?.headline).toBe(warningHeadline(HELPER_HUNG));
  });

  it('keeps the order main sent: offline first, then the mic, then call audio', () => {
    const groups = groupWarnings([OFFLINE, MIC_DEAD, NO_CALL_AUDIO], true);
    expect(groups.map(({ source }) => source)).toEqual([null, 'mic', 'system']);
  });

  it('splits loud from quiet: the quiet ones are not in the loud list, and the reverse', () => {
    // A stream can hold both at once. The banner and the status line take the loud ones only;
    // the quiet ones are Details' (docs/plans/redesign.md, Banners and warnings).
    const all = [CALL_SILENT, NO_CALL_AUDIO, MIC_DEAD];
    expect(groupWarnings(all, true).flatMap((group) => group.messages)).toEqual([
      NO_CALL_AUDIO.message,
      MIC_DEAD.message,
    ]);
    expect(groupWarnings(all, false).flatMap((group) => group.messages)).toEqual([
      CALL_SILENT.message,
    ]);
  });

  it('gives the warnings about neither stream (offline, the backup) a group of their own', () => {
    const groups = groupWarnings([OFFLINE, MIC_DEAD, BACKUP_PAUSED], true);
    expect(groups.map(({ source }) => source)).toEqual([null, 'mic']);
    expect(groups[0]?.messages).toEqual([OFFLINE.message, BACKUP_PAUSED.message]);
  });

  it('says the same words once, whoever raised them', () => {
    const [group] = groupWarnings(
      [NO_CALL_AUDIO, { ...NO_CALL_AUDIO, kind: 'source-ended' }],
      true,
    );
    expect(group?.messages).toEqual([NO_CALL_AUDIO.message]);
  });

  it('is empty while nothing is wrong', () => {
    expect(groupWarnings([], true)).toEqual([]);
  });
});

describe('warningHeadline', () => {
  it('says what Roger cannot hear, in a few words, for the one-line status', () => {
    expect(warningHeadline(NO_CALL_AUDIO)).toBe("Roger can't hear the call");
    expect(warningHeadline(MIC_DEAD)).toBe("Roger can't hear you");
    expect(warningHeadline({ kind: 'no-audio', source: 'mic' })).toBe("Roger can't hear you");
    expect(warningHeadline(OFFLINE)).toBe('The Mac is offline');
  });

  it("is the shared word list's, so the page and a notification never disagree (sweep N1)", () => {
    expect(warningHeadline).toBe(sharedHeadline);
  });
});
