import { describe, expect, it } from 'vitest';
import { CALENDAR_PREFERENCES, REMINDER_LEAD_MINUTES } from './calendarPrefs';

const lead = CALENDAR_PREFERENCES['calendar.reminderLeadMinutes'];
const openAtLogin = CALENDAR_PREFERENCES['app.openAtLogin'];

describe('calendar preferences', () => {
  it('registers each spec under its own key', () => {
    for (const [key, spec] of Object.entries(CALENDAR_PREFERENCES)) expect(spec.key).toBe(key);
  });

  it('has defaults its own parse accepts', () => {
    for (const spec of Object.values(CALENDAR_PREFERENCES)) {
      expect(spec.parse(spec.default)).toEqual(spec.default);
    }
  });

  it('defaults to a 1-minute reminder', () => {
    expect(lead.default).toBe(1);
  });

  // 2026-10-08: the call notice was removed end to end; its keys must not come back by accident.
  it('registers no call notice keys', () => {
    expect(Object.keys(CALENDAR_PREFERENCES).sort()).toEqual([
      'app.openAtLogin',
      'calendar.reminderLeadMinutes',
    ]);
  });

  it('keeps open at login off until the login item is proven on a real Mac', () => {
    expect(openAtLogin.default).toBe('off');
  });
});

describe('calendar.reminderLeadMinutes', () => {
  it.each(REMINDER_LEAD_MINUTES)('accepts %i', (minutes) => {
    expect(lead.parse(minutes)).toBe(minutes);
  });

  it.each([3, -1, 1.5, '1', null, undefined])('refuses %j and names the key', (raw) => {
    expect(() => lead.parse(raw)).toThrow(
      /calendar\.reminderLeadMinutes must be one of 0, 1, 2, 5 or 10/,
    );
  });
});

describe('app.openAtLogin', () => {
  it.each(['auto', 'on', 'off'] as const)('accepts %s', (value) => {
    expect(openAtLogin.parse(value)).toBe(value);
  });

  it.each(['yes', true, null])('refuses %j and names the key', (raw) => {
    expect(() => openAtLogin.parse(raw)).toThrow(/app\.openAtLogin must be one of auto, on or off/);
  });
});
