import { describe, expect, it } from 'vitest';
import { CALENDAR_PREFERENCES, DEFAULT_NOTICE_TEXT } from '../../shared/calendarPrefs';
import { APP_PREFERENCES } from '../../shared/preferences';
import { createLogger } from '../logger';
import { PreferencesStore, type PreferenceFiles } from '../preferences/PreferencesStore';
import { createConsentNotice } from './consentNotice';

/** A preferences.json that lives in memory: nothing on disk, nothing to clean up. */
function memoryFiles(): PreferenceFiles {
  const files = new Map<string, string>();
  return {
    readFileSync: (path) => {
      const text = files.get(path);
      if (text === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      return text;
    },
    writeFileSync: (path, text) => {
      files.set(path, text);
    },
    renameSync: (from, to) => {
      const text = files.get(from);
      if (text === undefined) throw new Error(`ENOENT: ${from}`);
      files.set(to, text);
      files.delete(from);
    },
  };
}

function harness() {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) });
  const preferences = new PreferencesStore({ path: '/prefs.json', logger, files: memoryFiles() });
  preferences.register(APP_PREFERENCES);
  preferences.register(CALENDAR_PREFERENCES);
  const copied: string[] = [];
  const notice = createConsentNotice({
    preferences,
    clipboard: {
      writeText: (text) => {
        copied.push(text);
      },
    },
    logger,
  });
  return { preferences, notice, copied, lines };
}

describe('the consent notice', () => {
  it('is on by default and copies the default text', () => {
    const h = harness();
    expect(h.notice.enabled()).toBe(true);
    expect(h.notice.copy()).toBe(true);
    expect(h.copied).toEqual([DEFAULT_NOTICE_TEXT]);
  });

  it('copies the text as it reads at the moment of the copy', () => {
    const h = harness();
    h.preferences.set('notice.text', 'Recording this with Roger, shout if not.');
    expect(h.notice.copy()).toBe(true);
    expect(h.copied).toEqual(['Recording this with Roger, shout if not.']);
  });

  it('copies nothing while the notice is off', () => {
    const h = harness();
    h.preferences.set('notice.enabled', false);
    expect(h.notice.enabled()).toBe(false);
    expect(h.notice.copy()).toBe(false);
    expect(h.copied).toEqual([]);
  });

  it('never writes the text into a log line', () => {
    const h = harness();
    h.preferences.set('notice.text', 'A private wording only the clipboard may hold.');
    h.notice.copy();
    expect(h.lines.join('\n')).not.toContain('private wording');
    const messages = h.lines.map((line) => (JSON.parse(line) as { message: string }).message);
    expect(messages).toContain('consent notice copied');
  });

  it('tells a listener when the notice is turned on or off, and only then', () => {
    const h = harness();
    const seen: boolean[] = [];
    const stop = h.notice.onEnabledChange((enabled) => seen.push(enabled));
    h.preferences.set('notice.text', 'New words.');
    h.preferences.set('calendar.reminderLeadMinutes', 5);
    h.preferences.set('notice.enabled', false);
    h.preferences.set('notice.enabled', true);
    stop();
    h.preferences.set('notice.enabled', false);
    expect(seen).toEqual([false, true]);
  });
});
