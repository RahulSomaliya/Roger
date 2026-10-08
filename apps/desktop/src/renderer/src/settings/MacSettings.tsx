import { useId } from 'react';
import type { Route } from '../app/router';
import { useShell } from '../app/ShellContext';
import { openAtLoginHint } from '../calendar/calendarFormat';
import type {
  CalendarSettingsState,
  CalendarSettingsStore,
} from '../calendar/calendarSettingsStore';
import { useCalendarSettings } from '../calendar/useCalendar';
import { SettingsProblem } from './SettingsProblem';
import { SettingsRow } from './SettingsRow';
import './settings.css';

const SETUP: Route = { name: 'setup' };

/** What the section calls on the settings store. */
export type MacSettingsActions = Pick<CalendarSettingsStore, 'choose'>;

/**
 * Settings: the Mac section (sweep section 4): whether Roger opens at login, and a way into Set up
 * Roger, which is otherwise only in the app menu. The login choice is a calendar-store preference
 * (it keeps the reminders coming for the first call of the day), so this reads the same shared
 * store as the Calendar section and saves on change like every Settings choice.
 */
export function MacSettings() {
  const { state, store } = useCalendarSettings();
  const { navigate } = useShell();
  return (
    <MacSettingsSection
      settings={state}
      actions={store}
      onOpenSetup={() => {
        navigate(SETUP);
      }}
    />
  );
}

interface MacSettingsSectionProps {
  settings: CalendarSettingsState;
  actions: MacSettingsActions;
  onOpenSetup: () => void;
}

export function MacSettingsSection({ settings, actions, onOpenSetup }: MacSettingsSectionProps) {
  const headingId = useId();
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="settings-section-title">
        Mac
      </h2>
      {settings.status === 'ready' ? (
        <SettingsRow label="At login">
          <OpenAtLogin settings={settings} actions={actions} />
        </SettingsRow>
      ) : null}
      <SettingsRow
        label="Check the microphone and call audio"
        help="Roger needs both to record a call."
      >
        <div>
          <button
            type="button"
            className="btn"
            data-variant="secondary"
            data-size="sm"
            onClick={onOpenSetup}
          >
            Open Set up Roger
          </button>
        </div>
      </SettingsRow>
      {settings.saveError === null ? null : (
        <SettingsProblem role="alert">{settings.saveError}</SettingsProblem>
      )}
    </section>
  );
}

function OpenAtLogin({
  settings,
  actions,
}: {
  settings: CalendarSettingsState;
  actions: MacSettingsActions;
}) {
  const { openAtLogin, loginItem } = settings;
  // Said only when there is something to do or to know: macOS waits on a click in System
  // Settings, or this copy cannot register a login item. Otherwise the switch says it all.
  const hint =
    loginItem === 'requires-approval' || loginItem === 'unavailable'
      ? openAtLoginHint(loginItem)
      : null;
  return (
    <div className="settings-field">
      <label className="settings-check">
        <input
          type="checkbox"
          checked={openAtLogin !== 'off'}
          disabled={loginItem === 'unavailable'}
          onChange={(event) => {
            void actions.choose('app.openAtLogin', event.currentTarget.checked ? 'on' : 'off');
          }}
        />
        <span className="settings-check-text">
          <span>Open Roger at login</span>
          {hint === null ? null : (
            <span className="settings-hint" data-login-item={loginItem}>
              {hint}
            </span>
          )}
        </span>
      </label>
      {settings.loginItemError === null ? null : (
        <SettingsProblem role="alert">
          Roger could not ask macOS about it: {settings.loginItemError}
        </SettingsProblem>
      )}
    </div>
  );
}
