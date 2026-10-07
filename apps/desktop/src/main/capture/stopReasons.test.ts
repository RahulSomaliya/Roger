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
    expect(notice('no-speech')).toBe('Stopped at 14:32 after 15 minutes with no speech.');
    expect(notice('max-duration')).toBe('Stopped at 14:32: one recording is capped at 4 hours.');
    expect(notice('renderer-gone', 'it crashed again: oom')).toBe(
      'Stopped at 14:32 because the Roger window could not reload (it crashed again: oom).',
    );
    expect(notice('renderer-gone')).toBe(
      'Stopped at 14:32 because the Roger window could not reload.',
    );
    expect(notice('system-sleep')).toBe('Stopped at 14:32 because the Mac went to sleep.');
    expect(notice('call-ended', 'Zoom')).toBe('Stopped at 14:32: the call in Zoom ended.');
    expect(notice('call-ended')).toBe('Stopped at 14:32: the call ended.');
  });

  it('has no notice for a stop that leaves no window to show it: quit and a closed window', () => {
    // A closed window quits Roger (index.ts, window-all-closed), and nothing keeps a notice across
    // launches: the reason is in the log and the meeting's stt_usage row instead.
    expect(stopNotice('quit', at, DEFAULT_COST_GUARDS)).toBeNull();
    expect(stopNotice('window-closed', at, DEFAULT_COST_GUARDS)).toBeNull();
  });

  it('spells configured limits in the largest whole unit', () => {
    const guards = { noSpeechStopMs: 90_000, maxRecordingMs: 60_000 };
    expect(stopNotice('no-speech', at, guards)).toContain('after 90 seconds with no speech');
    expect(stopNotice('max-duration', at, guards)).toContain('capped at 1 minute');
  });
});
