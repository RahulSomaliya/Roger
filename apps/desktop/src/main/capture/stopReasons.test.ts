import { describe, expect, expectTypeOf, it } from 'vitest';
import { DEFAULT_COST_GUARDS } from '../costGuards';
import { type StopReason, stopNotice } from './stopReasons';

describe('StopReason', () => {
  // Checked by tsc, not at run time. A reload no longer stops a recording (M2-T12): the reloaded
  // page reopens the mic. Rows written before keep the string (TranscriptStore.MeetingStopReason).
  it('has no reload stop any more', () => {
    expectTypeOf<Extract<StopReason, 'page-reloaded'>>().toBeNever();
  });
});

describe('stopNotice', () => {
  const at = new Date(2026, 9, 6, 14, 32);

  it('says nothing about a Stop someone pressed', () => {
    expect(stopNotice('user', at, DEFAULT_COST_GUARDS)).toBeNull();
  });

  it('says when and why Roger stopped on its own', () => {
    const notice = (reason: Parameters<typeof stopNotice>[0], detail: string | null = null) =>
      stopNotice(reason, at, DEFAULT_COST_GUARDS, detail);
    expect(notice('no-speech')).toBe('Stopped at 2:32 pm after 15 minutes with no speech.');
    expect(notice('max-duration')).toBe('Stopped at 2:32 pm: one meeting is capped at 4 hours.');
    expect(notice('renderer-gone', 'it crashed again: oom')).toBe(
      'Stopped at 2:32 pm because the Roger window could not reload (it crashed again: oom).',
    );
    expect(notice('renderer-gone')).toBe(
      'Stopped at 2:32 pm because the Roger window could not reload.',
    );
    expect(notice('system-sleep')).toBe('Stopped at 2:32 pm because the Mac went to sleep.');
    expect(notice('call-ended', 'Zoom')).toBe('Stopped at 2:32 pm: the call in Zoom ended.');
    expect(notice('call-ended')).toBe('Stopped at 2:32 pm: the call ended.');
  });

  it('has no notice for a stop that leaves no window to show it: quit and a closed window', () => {
    // Only a quit exits Roger (closing the window hides it, M5-T11), and nothing keeps a notice
    // across launches: the reason is in the log and the meeting's stt_usage row instead.
    expect(stopNotice('quit', at, DEFAULT_COST_GUARDS)).toBeNull();
    expect(stopNotice('window-closed', at, DEFAULT_COST_GUARDS)).toBeNull();
  });

  it('spells configured limits in the largest whole unit', () => {
    const guards = { noSpeechStopMs: 90_000, maxRecordingMs: 60_000 };
    expect(stopNotice('no-speech', at, guards)).toContain('after 90 seconds with no speech');
    expect(stopNotice('max-duration', at, guards)).toContain('capped at 1 minute');
  });
});

describe('stopNotice clock', () => {
  // docs/design.md, Copy: clock times are 12-hour and lowercase, never "09:05" or "9:05 AM".
  it('writes a morning time with no leading zero, in lowercase', () => {
    const morning = new Date(2026, 9, 6, 9, 5);
    expect(stopNotice('system-sleep', morning, DEFAULT_COST_GUARDS)).toBe(
      'Stopped at 9:05 am because the Mac went to sleep.',
    );
  });
});
