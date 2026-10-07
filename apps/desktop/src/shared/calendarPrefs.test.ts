import { describe, expect, it } from 'vitest';
import {
  CALENDAR_PREFERENCES,
  DEFAULT_NOTICE_TEXT,
  MAX_NOTICE_TEXT_LENGTH,
  REMINDER_LEAD_MINUTES,
} from './calendarPrefs';

const lead = CALENDAR_PREFERENCES['calendar.reminderLeadMinutes'];
const noticeEnabled = CALENDAR_PREFERENCES['notice.enabled'];
const noticeText = CALENDAR_PREFERENCES['notice.text'];
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

  it('defaults to a 1-minute reminder and the notice on, with the agreed text', () => {
    expect(lead.default).toBe(1);
    expect(noticeEnabled.default).toBe(true);
    expect(noticeText.default).toBe(DEFAULT_NOTICE_TEXT);
    expect(DEFAULT_NOTICE_TEXT).toBe(
      "Hi all, I'm using Roger to transcribe this call for my notes. Let me know if you'd rather I didn't.",
    );
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

describe('notice.enabled', () => {
  it('accepts true and false only', () => {
    expect(noticeEnabled.parse(true)).toBe(true);
    expect(noticeEnabled.parse(false)).toBe(false);
    expect(() => noticeEnabled.parse('true')).toThrow(/notice\.enabled must be true or false/);
    expect(() => noticeEnabled.parse(1)).toThrow(/notice\.enabled/);
  });
});

describe('notice.text', () => {
  it('accepts the user’s own wording as written', () => {
    const text = '  Heads up: Roger is taking notes on this call.  ';
    expect(noticeText.parse(text)).toBe(text);
  });

  it('refuses a blank text and says to turn the notice off instead', () => {
    expect(() => noticeText.parse('  \n ')).toThrow(/notice\.text.*turn the notice off/);
  });

  it('refuses a text longer than a chat message', () => {
    expect(noticeText.parse('x'.repeat(MAX_NOTICE_TEXT_LENGTH))).toHaveLength(
      MAX_NOTICE_TEXT_LENGTH,
    );
    expect(() => noticeText.parse('x'.repeat(MAX_NOTICE_TEXT_LENGTH + 1))).toThrow(
      /notice\.text.*at most 1000 characters \(got 1001\)/,
    );
  });

  it('refuses anything but a string', () => {
    expect(() => noticeText.parse(42)).toThrow(/notice\.text must be text/);
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
