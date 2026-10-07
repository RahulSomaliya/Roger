import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import type { PrefsApi } from '../../../shared/ipc/prefs';
import type { Unsubscribe } from '../../../shared/ipc/unsubscribe';
import {
  APP_PREFERENCES,
  type NotesWhenUnsure,
  type PreferenceValues,
} from '../../../shared/preferences';
import { describeError } from '../app/describeError';
import './aiNotes.css';

/**
 * Settings: the notes section (M4-T18; M4-T20 mounts it in the shell's `settings` slot). Two
 * preferences main reads at Stop (main/notes/NotesGenerator.ts, through `[slot M4-T16 notes]`):
 * `notes.autoGenerate`, whether AI notes generate after a call, and `notes.whenUnsure`, what Roger
 * does at Stop when no rule picks a template (ask "Which kind of call was this?", or use General).
 * Main's PreferencesStore keeps them (shared/preferences.ts); the page shows what main stored and
 * changes it only through `setPreference`, whose change event then updates the page.
 */

export type NotesPrefsApi = Pick<
  PrefsApi,
  'getPreferences' | 'setPreference' | 'onPreferenceChanged'
>;

type NotesPreferenceKey = 'notes.autoGenerate' | 'notes.whenUnsure';

export interface NotesSettingsState {
  /** `loading` until main answers; `failed` when it could not read the preferences. */
  status: 'loading' | 'ready' | 'failed';
  autoGenerate: boolean;
  whenUnsure: NotesWhenUnsure;
  error: string | null;
  /** The key a choice is being saved for; both controls wait meanwhile. */
  saving: NotesPreferenceKey | null;
  saveError: string | null;
}

/** The two notes preferences over main's preferences channels. */
export class NotesPreferences {
  private state: NotesSettingsState = {
    status: 'loading',
    autoGenerate: APP_PREFERENCES['notes.autoGenerate'].default,
    whenUnsure: APP_PREFERENCES['notes.whenUnsure'].default,
    error: null,
    saving: null,
    saveError: null,
  };
  private readonly listeners = new Set<() => void>();
  /** Bumped by every start and stop, so an answer to an earlier start is dropped. */
  private run = 0;
  /** Keys a change event set since the read began: newer than what the read will answer. */
  private readonly changed = new Set<NotesPreferenceKey>();

  constructor(private readonly api: NotesPrefsApi) {}

  readonly getState = (): NotesSettingsState => this.state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Follows main's changes, then reads; returns the function that stops both. */
  start(): Unsubscribe {
    this.run += 1;
    const run = this.run;
    const unsubscribe = this.api.onPreferenceChanged((change) => {
      if (run !== this.run) return;
      if (change.key === 'notes.autoGenerate') {
        this.changed.add(change.key);
        this.update({ autoGenerate: change.value });
      } else if (change.key === 'notes.whenUnsure') {
        this.changed.add(change.key);
        this.update({ whenUnsure: change.value });
      }
    });
    this.read(run);
    return () => {
      if (run !== this.run) return;
      this.run += 1;
      unsubscribe();
    };
  }

  /** Try again after a failed read. */
  reload(): void {
    this.update({ status: 'loading', error: null });
    this.read(this.run);
  }

  /** Saves one choice. Never rejects: a refusal shows in `saveError`, the stored value stays. */
  async choose<K extends NotesPreferenceKey>(key: K, value: PreferenceValues[K]): Promise<void> {
    this.update({ saving: key, saveError: null });
    try {
      await this.api.setPreference(key, value);
    } catch (error) {
      this.update({ saveError: `Roger could not save that setting: ${describeError(error)}` });
    } finally {
      this.update({ saving: null });
    }
  }

  private read(run: number): void {
    this.changed.clear();
    this.api.getPreferences().then(
      (values) => {
        if (run !== this.run) return;
        this.update({
          status: 'ready',
          error: null,
          autoGenerate: this.changed.has('notes.autoGenerate')
            ? this.state.autoGenerate
            : values['notes.autoGenerate'],
          whenUnsure: this.changed.has('notes.whenUnsure')
            ? this.state.whenUnsure
            : values['notes.whenUnsure'],
        });
      },
      (error: unknown) => {
        if (run === this.run) this.update({ status: 'failed', error: describeError(error) });
      },
    );
  }

  private update(change: Partial<NotesSettingsState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of [...this.listeners]) listener();
  }
}

export function NotesSettings() {
  const [preferences] = useState(() => new NotesPreferences(window.roger));
  const state = useSyncExternalStore(preferences.subscribe, preferences.getState);
  useEffect(() => preferences.start(), [preferences]);
  return <NotesSettingsSection state={state} preferences={preferences} />;
}

export interface NotesSettingsSectionProps {
  state: NotesSettingsState;
  /** NotesPreferences is one; a test passes stand-ins. */
  preferences: Pick<NotesPreferences, 'choose' | 'reload'>;
}

export function NotesSettingsSection({ state, preferences }: NotesSettingsSectionProps) {
  const headingId = useId();
  const groupName = useId();
  return (
    <section className="card notes-settings" aria-labelledby={headingId}>
      <h2 id={headingId} className="notes-settings-title">
        Notes
      </h2>
      <p className="notes-settings-intro">
        After a call, Roger turns your notes and the transcript into AI notes, every line linked to
        what was said.
      </p>
      {state.status === 'loading' ? (
        <p className="notes-settings-status" role="status">
          Loading the notes settings...
        </p>
      ) : null}
      {state.status === 'failed' ? (
        <div className="error ai-notes-error" role="alert">
          <span>Roger could not read the notes settings: {state.error}</span>
          <div className="ai-notes-actions">
            <button
              type="button"
              className="note-button"
              onClick={() => {
                preferences.reload();
              }}
            >
              Try again
            </button>
          </div>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <>
          <label className="notes-settings-option">
            <input
              type="checkbox"
              checked={state.autoGenerate}
              disabled={state.saving !== null}
              onChange={(event) => {
                void preferences.choose('notes.autoGenerate', event.currentTarget.checked);
              }}
            />
            <span className="notes-settings-text">
              <span>Write AI notes when a call stops</span>
              <span className="notes-settings-hint">
                Roger starts once the call has uploaded. Off, the AI notes tab offers Generate
                instead.
              </span>
            </span>
          </label>
          <fieldset
            className="notes-settings-group"
            disabled={!state.autoGenerate || state.saving !== null}
          >
            <legend>When Roger cannot tell what kind of call it was</legend>
            <p className="notes-settings-hint">
              Roger first uses the template you picked last for a meeting with the same title, then
              words in the title, such as standup or client.
            </p>
            <WhenUnsureOption
              name={groupName}
              value="ask"
              label="Ask me which kind of call it was"
              state={state}
              preferences={preferences}
            />
            <WhenUnsureOption
              name={groupName}
              value="general"
              label="Use the General template"
              state={state}
              preferences={preferences}
            />
          </fieldset>
          {state.saveError === null ? null : (
            <p className="error notes-settings-error" role="alert">
              {state.saveError}
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}

interface WhenUnsureOptionProps extends NotesSettingsSectionProps {
  name: string;
  value: NotesWhenUnsure;
  label: string;
}

function WhenUnsureOption({ name, value, label, state, preferences }: WhenUnsureOptionProps) {
  return (
    <label className="notes-settings-option">
      <input
        type="radio"
        name={name}
        value={value}
        checked={state.whenUnsure === value}
        onChange={() => {
          void preferences.choose('notes.whenUnsure', value);
        }}
      />
      <span>{label}</span>
    </label>
  );
}
