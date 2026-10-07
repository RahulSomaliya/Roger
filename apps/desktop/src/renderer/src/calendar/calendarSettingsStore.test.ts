import { describe, expect, it, vi } from 'vitest';
import { CALENDAR_PREFERENCES, DEFAULT_NOTICE_TEXT } from '../../../shared/calendarPrefs';
import type { LoginItemApi, LoginItemState } from '../../../shared/ipc/loginItem';
import type { PrefsApi } from '../../../shared/ipc/prefs';
import type { PreferenceChange, PreferenceValues } from '../../../shared/preferences';
import { CalendarSettingsStore, type CalendarSettingsApi } from './calendarSettingsStore';

const stored: PreferenceValues = {
  theme: 'system',
  'notes.autoGenerate': true,
  'notes.whenUnsure': 'ask',
  'calendar.reminderLeadMinutes': 5,
  'notice.enabled': false,
  'notice.text': 'Recording this one.',
  'app.openAtLogin': 'on',
};

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Fake {
  api: CalendarSettingsApi;
  changePreference(change: PreferenceChange): void;
  changeLoginItem(state: LoginItemState): void;
  attached(): number;
}

function fake(overrides: Partial<PrefsApi & LoginItemApi> = {}): Fake {
  const preferenceListeners = new Set<(change: PreferenceChange) => void>();
  const loginListeners = new Set<(state: LoginItemState) => void>();
  const api: CalendarSettingsApi = {
    getPreferences: () => Promise.resolve(stored),
    setPreference: () => Promise.resolve(),
    onPreferenceChanged: (listener) => {
      preferenceListeners.add(listener);
      return () => {
        preferenceListeners.delete(listener);
      };
    },
    getLoginItemState: () => Promise.resolve({ status: 'enabled' }),
    onLoginItemStateChanged: (listener) => {
      loginListeners.add(listener);
      return () => {
        loginListeners.delete(listener);
      };
    },
    ...overrides,
  };
  return {
    api,
    changePreference: (change) => {
      preferenceListeners.forEach((listener) => {
        listener(change);
      });
    },
    changeLoginItem: (state) => {
      loginListeners.forEach((listener) => {
        listener(state);
      });
    },
    attached: () => preferenceListeners.size + loginListeners.size,
  };
}

describe('CalendarSettingsStore', () => {
  it('starts on the defaults the preferences register, loading', () => {
    const state = new CalendarSettingsStore(fake().api).getState();
    expect(state.status).toBe('loading');
    expect(state.reminderLeadMinutes).toBe(
      CALENDAR_PREFERENCES['calendar.reminderLeadMinutes'].default,
    );
    expect(state.noticeEnabled).toBe(true);
    expect(state.noticeText).toBe(DEFAULT_NOTICE_TEXT);
    expect(state.openAtLogin).toBe('off');
    expect(state.loginItem).toBeNull();
  });

  it('reads the four calendar preferences and the login item state', async () => {
    const store = new CalendarSettingsStore(fake().api);
    store.retain();
    await settle();
    expect(store.getState()).toMatchObject({
      status: 'ready',
      reminderLeadMinutes: 5,
      noticeEnabled: false,
      noticeText: 'Recording this one.',
      openAtLogin: 'on',
      loginItem: 'enabled',
    });
  });

  it('says why the preferences could not be read, and reads again on reload', async () => {
    const getPreferences = vi
      .fn<PrefsApi['getPreferences']>()
      .mockRejectedValueOnce(new Error('preferences.json is unreadable'))
      .mockResolvedValue(stored);
    const store = new CalendarSettingsStore(fake({ getPreferences }).api);
    store.retain();
    await settle();
    expect(store.getState()).toMatchObject({
      status: 'failed',
      error: 'preferences.json is unreadable',
    });
    store.reload();
    await settle();
    expect(store.getState()).toMatchObject({ status: 'ready', error: null });
  });

  it('lets a change that arrives during the read win over the read', async () => {
    const read = deferred<PreferenceValues>();
    const calendar = fake({ getPreferences: () => read.promise });
    const store = new CalendarSettingsStore(calendar.api);
    store.retain();
    calendar.changePreference({ key: 'calendar.reminderLeadMinutes', value: 10 });
    read.resolve(stored);
    await settle();
    expect(store.getState().reminderLeadMinutes).toBe(10);
    expect(store.getState().noticeText).toBe('Recording this one.');
  });

  it('follows a preference changed elsewhere, and ignores the keys it does not own', async () => {
    const calendar = fake();
    const store = new CalendarSettingsStore(calendar.api);
    store.retain();
    await settle();
    calendar.changePreference({ key: 'notice.enabled', value: true });
    calendar.changePreference({ key: 'app.openAtLogin', value: 'off' });
    calendar.changePreference({ key: 'theme', value: 'dark' });
    expect(store.getState()).toMatchObject({ noticeEnabled: true, openAtLogin: 'off' });
  });

  it('saves one choice through setPreference and waits for its change event to show it', async () => {
    const setPreference = vi.fn<PrefsApi['setPreference']>(() => Promise.resolve());
    const store = new CalendarSettingsStore(fake({ setPreference }).api);
    store.retain();
    await settle();
    await store.choose('notice.enabled', true);
    expect(setPreference).toHaveBeenCalledWith('notice.enabled', true);
    expect(store.getState()).toMatchObject({ saving: null, saveError: null, noticeEnabled: false });
  });

  it('says why a save failed and keeps the stored value', async () => {
    const setPreference = vi
      .fn<PrefsApi['setPreference']>()
      .mockRejectedValue(
        new Error("Error invoking remote method 'prefs:set': Error: notice.text is blank"),
      );
    const store = new CalendarSettingsStore(fake({ setPreference }).api);
    store.retain();
    await settle();
    await store.choose('notice.text', ' ');
    expect(store.getState().saveError).toBe(
      'Roger could not save that setting: notice.text is blank',
    );
    expect(store.getState()).toMatchObject({ saving: null, noticeText: 'Recording this one.' });
  });

  it('follows what macOS says about the login item, and why it could not be asked', async () => {
    const calendar = fake();
    const store = new CalendarSettingsStore(calendar.api);
    store.retain();
    await settle();
    calendar.changeLoginItem({ status: 'requires-approval' });
    expect(store.getState().loginItem).toBe('requires-approval');

    const failing = new CalendarSettingsStore(
      fake({ getLoginItemState: () => Promise.reject(new Error('macOS did not answer')) }).api,
    );
    failing.retain();
    await settle();
    expect(failing.getState()).toMatchObject({
      status: 'ready',
      loginItem: null,
      loginItemError: 'macOS did not answer',
    });
  });

  it('remembers the meetings whose notice was copied or dismissed', () => {
    const store = new CalendarSettingsStore(fake().api);
    store.markNoticeDone('m1');
    store.markNoticeDone('m1');
    store.markNoticeDone('m2');
    expect(store.getState().noticeDone).toEqual(['m1', 'm2']);
  });

  it('stops listening with its last holder', () => {
    const calendar = fake();
    const store = new CalendarSettingsStore(calendar.api);
    const release = store.retain();
    expect(calendar.attached()).toBe(2);
    release();
    expect(calendar.attached()).toBe(0);
  });
});
