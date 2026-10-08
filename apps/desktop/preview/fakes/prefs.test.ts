import { describe, expect, it } from 'vitest';
import { CALENDAR_PREFERENCES } from '../../src/shared/calendarPrefs';
import { prefsChannels } from '../../src/shared/ipc/prefs';
import type { PreferenceChange } from '../../src/shared/preferences';
import { FakeHub } from './hub';
import { createPrefsFake } from './prefs';

describe('the preview fake of the preferences', () => {
  // Every milestone's keys, M5's included: main gets M5's from M5-T9c's slot, but no M5 task
  // writes this fake, so it registers them itself. M5's defaults are read from its specs: M5 owns
  // them and plans to flip app.openAtLogin, which must not break a test it cannot edit.
  it('answers the defaults of every key in the app until something is set', async () => {
    const calendarDefaults = Object.fromEntries(
      Object.values(CALENDAR_PREFERENCES).map((spec) => [spec.key, spec.default]),
    );
    expect(Object.keys(calendarDefaults)).toHaveLength(4);
    await expect(createPrefsFake(new FakeHub()).getPreferences()).resolves.toEqual({
      theme: 'system',
      ...calendarDefaults,
    });
  });

  it("sets M5's calendar keys and refuses their bad values, as main will", async () => {
    const hub = new FakeHub();
    const prefs = createPrefsFake(hub);
    await prefs.setPreference('calendar.reminderLeadMinutes', 5);
    hub.emit(prefsChannels.PrefsChanged, { key: 'notice.enabled', value: false });
    await expect(prefs.getPreferences()).resolves.toMatchObject({
      'calendar.reminderLeadMinutes': 5,
      'notice.enabled': false,
    });
    await expect(prefs.setPreference('notice.text', ' ')).rejects.toThrow(
      'notice.text is blank: write the notice, or turn the notice off',
    );
  });

  it('answers a set on the next read and sends it to every listener once', async () => {
    const prefs = createPrefsFake(new FakeHub());
    const first: PreferenceChange[] = [];
    const second: PreferenceChange[] = [];
    prefs.onPreferenceChanged((change) => first.push(change));
    prefs.onPreferenceChanged((change) => second.push(change));
    await prefs.setPreference('theme', 'light');
    await expect(prefs.getPreferences()).resolves.toMatchObject({ theme: 'light' });
    expect(first).toEqual([{ key: 'theme', value: 'light' }]);
    expect(second).toEqual(first);
  });

  it("refuses a bad value with main's words, as a failed invoke does", async () => {
    const prefs = createPrefsFake(new FakeHub());
    // A value the type allows nowhere, as a bug in the page could send.
    const bad = 'sepia' as 'dark';
    await expect(prefs.setPreference('theme', bad)).rejects.toThrow(
      'Error invoking remote method \'prefs:set\': Error: theme must be one of system, light or dark (got "sepia")',
    );
    await expect(prefs.getPreferences()).resolves.toMatchObject({ theme: 'system' });
  });

  // How the QA driver forces a theme without a Settings screen: it pushes the change main would
  // send, and the page (useTheme) and later reads both follow it.
  it('takes a change a scenario pushes through the hub as the stored value', async () => {
    const hub = new FakeHub();
    const prefs = createPrefsFake(hub);
    const seen: PreferenceChange[] = [];
    prefs.onPreferenceChanged((change) => seen.push(change));
    hub.emit(prefsChannels.PrefsChanged, { key: 'theme', value: 'dark' });
    expect(seen).toEqual([{ key: 'theme', value: 'dark' }]);
    await expect(prefs.getPreferences()).resolves.toMatchObject({ theme: 'dark' });
  });

  it('fails loudly on a pushed change that main would refuse', () => {
    const hub = new FakeHub();
    createPrefsFake(hub);
    expect(() => {
      hub.emit(prefsChannels.PrefsChanged, { key: 'theme', value: 'sepia' });
    }).toThrow('theme must be one of system, light or dark (got "sepia")');
  });
});
