import { describe, expect, it } from 'vitest';
import { isMeetingId, parseAppRoute } from './app';

const MEETING = '0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b';

describe('parseAppRoute', () => {
  it('accepts the closed set: home, settings, setup and meeting/<id>', () => {
    expect(parseAppRoute('home')).toBe('home');
    expect(parseAppRoute('settings')).toBe('settings');
    expect(parseAppRoute('setup')).toBe('setup');
    expect(parseAppRoute(`meeting/${MEETING}`)).toBe(`meeting/${MEETING}`);
  });

  it('refuses anything else, a meeting id that is not a lowercase UUID included', () => {
    for (const value of [
      '',
      'Settings',
      'meetings',
      'meeting/',
      'meeting/not-a-uuid',
      `meeting/${MEETING.toUpperCase()}`,
      `meeting/${MEETING}/notes`,
      `meetings/${MEETING}`,
      '__proto__',
      'constructor',
      undefined,
      null,
      42,
      { route: 'home' },
    ]) {
      expect(parseAppRoute(value)).toBeNull();
    }
  });
});

describe('isMeetingId', () => {
  it('takes the lowercase UUIDs the desktop and Postgres write, and nothing else', () => {
    expect(isMeetingId(MEETING)).toBe(true);
    expect(isMeetingId(MEETING.toUpperCase())).toBe(false);
    expect(isMeetingId(`${MEETING} `)).toBe(false);
    expect(isMeetingId('')).toBe(false);
  });
});
