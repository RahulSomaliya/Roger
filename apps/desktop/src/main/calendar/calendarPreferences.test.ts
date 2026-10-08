import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_PREFERENCES } from '../../shared/preferences';
import { createLogger } from '../logger';
import { PreferencesStore } from '../preferences/PreferencesStore';
import { registerCalendarPreferences } from './calendarPreferences';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roger-calendar-prefs-'));
  path = join(dir, 'preferences.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The store as main builds it: the shell's keys first (M4-S2's slot), then M5's. */
function openStore(): PreferencesStore {
  const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
  const store = new PreferencesStore({ path, logger });
  store.register(APP_PREFERENCES);
  registerCalendarPreferences(store);
  return store;
}

describe('registerCalendarPreferences', () => {
  it('registers every calendar key with its default, open at login off until real-Mac check 1', () => {
    expect(openStore().getAll()).toMatchObject({
      'calendar.reminderLeadMinutes': 1,
      'app.openAtLogin': 'off',
    });
  });

  it('reads a saved lead time, and refuses one Settings does not offer', () => {
    writeFileSync(path, JSON.stringify({ 'calendar.reminderLeadMinutes': 5 }));
    const store = openStore();

    expect(store.get('calendar.reminderLeadMinutes')).toBe(5);
    expect(() => store.parseAndSet('calendar.reminderLeadMinutes', 3)).toThrow(
      /calendar\.reminderLeadMinutes must be one of 0, 1, 2, 5 or 10/,
    );
    expect(store.get('calendar.reminderLeadMinutes')).toBe(5);
  });
});

// 2026-10-08: the call notice was removed end to end. A Mac that chose a notice before then still
// holds both keys; nobody registers them now, so the store must keep them, quietly, and no page
// may be told about them.
describe('the retired call notice keys', () => {
  it('are ignored on read without a log line, and kept on save', () => {
    writeFileSync(
      path,
      JSON.stringify({ 'notice.enabled': false, 'notice.text': 'My own words.', theme: 'light' }),
    );
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', format: 'json', sink: (l) => lines.push(l) });
    const store = new PreferencesStore({ path, logger });
    store.register(APP_PREFERENCES);
    registerCalendarPreferences(store);

    expect(store.getAll()).toEqual({
      theme: 'light',
      'calendar.reminderLeadMinutes': 1,
      'app.openAtLogin': 'off',
    });
    expect(() => store.get('notice.enabled' as 'theme')).toThrow(
      'unknown preference "notice.enabled"',
    );
    expect(lines).toEqual([]);

    store.set('theme', 'dark');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      'notice.enabled': false,
      'notice.text': 'My own words.',
      theme: 'dark',
    });
  });
});
