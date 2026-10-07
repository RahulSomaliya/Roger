import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CALENDAR_PREFERENCES } from '../../../shared/calendarPrefs';
import {
  APP_PREFERENCES,
  type PreferenceChange,
  PreferenceRegistry,
} from '../../../shared/preferences';
import {
  NotesPreferences,
  type NotesPrefsApi,
  NotesSettingsSection,
  type NotesSettingsState,
} from './NotesSettings';

/**
 * Main's PreferencesStore as the page reaches it, checked by the real registry: a set is stored,
 * then told as a change.
 */
class FakePrefs {
  private readonly registry = new PreferenceRegistry();
  readonly stored = new Map<string, unknown>();
  readonly listeners = new Set<(change: PreferenceChange) => void>();

  readonly api = {
    getPreferences: vi.fn<NotesPrefsApi['getPreferences']>(() =>
      Promise.resolve(this.registry.snapshot(this.stored)),
    ),
    setPreference: vi.fn<NotesPrefsApi['setPreference']>((key, value) => {
      const change = this.registry.parse(key, value);
      this.stored.set(change.key, change.value);
      this.emit(change);
      return Promise.resolve();
    }),
    onPreferenceChanged: (listener: (change: PreferenceChange) => void) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    },
  } satisfies NotesPrefsApi;

  constructor() {
    this.registry.register({ ...APP_PREFERENCES, ...CALENDAR_PREFERENCES });
  }

  emit(change: PreferenceChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }
}

const answered = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function opened(prefs: FakePrefs): Promise<NotesPreferences> {
  const model = new NotesPreferences(prefs.api);
  model.start();
  await answered();
  return model;
}

describe('NotesPreferences', () => {
  it('reads both notes preferences and follows changes made elsewhere', async () => {
    const prefs = new FakePrefs();
    prefs.stored.set('notes.whenUnsure', 'general');
    const model = await opened(prefs);
    expect(model.getState()).toMatchObject({
      status: 'ready',
      autoGenerate: true,
      whenUnsure: 'general',
    });
    prefs.emit({ key: 'notes.autoGenerate', value: false });
    expect(model.getState().autoGenerate).toBe(false);
    // Another key changes nothing here.
    const before = model.getState();
    prefs.emit({ key: 'theme', value: 'dark' });
    expect(model.getState()).toBe(before);
  });

  it('a change that arrives before the read answers wins', async () => {
    const prefs = new FakePrefs();
    const model = new NotesPreferences(prefs.api);
    model.start();
    prefs.emit({ key: 'notes.whenUnsure', value: 'general' });
    await answered();
    expect(model.getState().whenUnsure).toBe('general');
  });

  it('saves a choice through main, and shows what main stored', async () => {
    const prefs = new FakePrefs();
    const model = await opened(prefs);
    const saving = model.choose('notes.whenUnsure', 'general');
    expect(model.getState().saving).toBe('notes.whenUnsure');
    await saving;
    expect(prefs.api.setPreference).toHaveBeenCalledWith('notes.whenUnsure', 'general');
    expect(model.getState()).toMatchObject({
      saving: null,
      whenUnsure: 'general',
      saveError: null,
    });
  });

  it('says why a choice was not saved, and keeps the stored one', async () => {
    const prefs = new FakePrefs();
    prefs.api.setPreference.mockRejectedValueOnce(
      new Error("Error invoking remote method 'prefs:set': Error: preferences.json is read-only"),
    );
    const model = await opened(prefs);
    await model.choose('notes.autoGenerate', false);
    expect(model.getState()).toMatchObject({
      saving: null,
      autoGenerate: true,
      saveError: 'Roger could not save that setting: preferences.json is read-only',
    });
  });

  it('says why the preferences could not be read, and reads them again', async () => {
    const prefs = new FakePrefs();
    prefs.api.getPreferences.mockRejectedValueOnce(new Error('preferences unavailable'));
    const model = await opened(prefs);
    expect(model.getState()).toMatchObject({ status: 'failed', error: 'preferences unavailable' });
    model.reload();
    await answered();
    expect(model.getState().status).toBe('ready');
  });

  it('stops following once stopped', async () => {
    const prefs = new FakePrefs();
    const model = new NotesPreferences(prefs.api);
    const stop = model.start();
    await answered();
    stop();
    expect(prefs.listeners.size).toBe(0);
  });
});

function state(overrides: Partial<NotesSettingsState> = {}): NotesSettingsState {
  return {
    status: 'ready',
    autoGenerate: true,
    whenUnsure: 'ask',
    error: null,
    saving: null,
    saveError: null,
    ...overrides,
  };
}

const render = (given: NotesSettingsState): string =>
  renderToStaticMarkup(
    createElement(NotesSettingsSection, {
      state: given,
      preferences: {
        choose: () => Promise.resolve(),
        reload: () => undefined,
      },
    }),
  ).replaceAll('<!-- -->', '');

describe('NotesSettingsSection', () => {
  it('shows the auto-generate switch and what Roger does when it cannot tell', () => {
    const html = render(state());
    expect(html).toMatch(/^<section class="card notes-settings" aria-labelledby="[^"]+">/);
    expect(html).toContain('>Notes</h2>');
    expect(html).toMatch(/<input type="checkbox"[^>]* checked=""/);
    expect(html).toContain('Write AI notes when a call stops');
    expect(html).toContain('<legend>When Roger cannot tell what kind of call it was</legend>');
    expect(html).toMatch(/<input type="radio"[^>]* checked="" value="ask"\/>/);
    expect(html).toMatch(/<input type="radio" name="[^"]+" value="general"\/>/);
    expect(html).toContain('Ask me which kind of call it was');
    expect(html).toContain('Use the General template');
    expect(html).not.toMatch(/<fieldset[^>]* disabled=""/);
  });

  it('turns the when-unsure choice off while notes do not generate after a call', () => {
    const html = render(state({ autoGenerate: false, whenUnsure: 'general' }));
    expect(html).not.toMatch(/<input type="checkbox"[^>]* checked=""/);
    expect(html).toMatch(/<fieldset class="notes-settings-group" disabled=""/);
    expect(html).toMatch(/checked="" value="general"\/>/);
  });

  it('holds both while a choice is saved, and says when it was not', () => {
    const saving = render(state({ saving: 'notes.autoGenerate' }));
    expect(saving).toMatch(/<input type="checkbox"[^>]* disabled=""/);
    expect(saving).toMatch(/<fieldset class="notes-settings-group" disabled=""/);
    const failed = render(state({ saveError: 'Roger could not save that setting: disk full' }));
    expect(failed).toContain(
      '<p class="error notes-settings-error" role="alert">Roger could not save that setting: disk full</p>',
    );
  });

  it('says it is loading, or why it could not read the settings, with Try again', () => {
    expect(render(state({ status: 'loading' }))).toContain('Loading the notes settings...');
    const failed = render(state({ status: 'failed', error: 'preferences unavailable' }));
    expect(failed).toContain('Roger could not read the notes settings: preferences unavailable');
    expect(failed).toContain('>Try again</button>');
    expect(failed).not.toContain('type="checkbox"');
  });
});
