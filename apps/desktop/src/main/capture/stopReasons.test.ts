import { describe, expect, it } from 'vitest';
import { DEFAULT_COST_GUARDS } from '../costGuards';
import { stopNotice } from './stopReasons';

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
    expect(notice('quit')).toBe('Stopped at 14:32 because Roger quit.');
    expect(notice('window-closed')).toBe('Stopped at 14:32 because the Roger window closed.');
    expect(notice('renderer-gone', 'oom')).toBe(
      'Stopped at 14:32 because the Roger window crashed (oom).',
    );
    expect(notice('page-reloaded')).toBe('Stopped at 14:32 because the Roger window reloaded.');
    expect(notice('system-sleep')).toBe('Stopped at 14:32 because the Mac went to sleep.');
  });

  it('spells configured limits in the largest whole unit', () => {
    const guards = { noSpeechStopMs: 90_000, maxRecordingMs: 60_000 };
    expect(stopNotice('no-speech', at, guards)).toContain('after 90 seconds with no speech');
    expect(stopNotice('max-duration', at, guards)).toContain('capped at 1 minute');
  });
});
