import { describe, expect, it } from 'vitest';
import { prefsChannels } from '../../src/shared/ipc/prefs';
import type { PreferenceChange } from '../../src/shared/preferences';
import { FakeHub } from './hub';
import { createPrefsFake } from './prefs';

describe('the preview fake of the preferences', () => {
  it('answers the defaults until something is set', async () => {
    await expect(createPrefsFake(new FakeHub()).getPreferences()).resolves.toEqual({
      theme: 'system',
      'notes.autoGenerate': true,
      'notes.whenUnsure': 'ask',
    });
  });

  it('answers a set on the next read and sends it to every listener once', async () => {
    const prefs = createPrefsFake(new FakeHub());
    const first: PreferenceChange[] = [];
    const second: PreferenceChange[] = [];
    prefs.onPreferenceChanged((change) => first.push(change));
    prefs.onPreferenceChanged((change) => second.push(change));
    await prefs.setPreference('notes.whenUnsure', 'general');
    await expect(prefs.getPreferences()).resolves.toMatchObject({ 'notes.whenUnsure': 'general' });
    expect(first).toEqual([{ key: 'notes.whenUnsure', value: 'general' }]);
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
