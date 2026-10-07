import { useId, useState } from 'react';
import {
  DEFAULT_NOTICE_TEXT,
  MAX_NOTICE_TEXT_LENGTH,
  REMINDER_LEAD_MINUTES,
  type ReminderLeadMinutes,
} from '../../../shared/calendarPrefs';
import { createCalendarFormat, openAtLoginHint, reconnectLabel } from './calendarFormat';
import type { CalendarSettingsState, CalendarSettingsStore } from './calendarSettingsStore';
import type { CalendarState, CalendarStore } from './calendarStore';
import { useCalendar, useCalendarSettings, useNow } from './useCalendar';
import './today.css';
import './calendarSettings.css';

/** What the section calls on its two stores; the stores are one, a test passes stand-ins. */
export interface CalendarSettingsActions {
  calendar: Pick<CalendarStore, 'connect' | 'disconnect' | 'reload'>;
  settings: Pick<CalendarSettingsStore, 'choose' | 'reload'>;
}

/**
 * Settings: the Calendar section (M5-T12; M5-T13 mounts it in the shell's `settings` slot): the
 * Google account with Connect, Reconnect and Disconnect, how long before a call the reminder
 * shows, the notice to the other people on the call with its text, and whether Roger opens at
 * login, with what macOS did about that. Main's PreferencesStore keeps the choices; this shows
 * what main stored and changes it only through `setPreference` (calendarSettingsStore.ts).
 */
export function CalendarSettings() {
  const calendar = useCalendar();
  const settings = useCalendarSettings();
  const nowMs = useNow();
  return (
    <CalendarSettingsSection
      calendar={calendar.state}
      settings={settings.state}
      nowMs={nowMs}
      actions={{ calendar: calendar.store, settings: settings.store }}
    />
  );
}

export interface CalendarSettingsSectionProps {
  calendar: CalendarState;
  settings: CalendarSettingsState;
  nowMs: number;
  actions: CalendarSettingsActions;
}

export function CalendarSettingsSection({
  calendar,
  settings,
  nowMs,
  actions,
}: CalendarSettingsSectionProps) {
  const headingId = useId();
  return (
    <section className="card calendar-settings" aria-labelledby={headingId}>
      <h2 id={headingId} className="calendar-settings-title">
        Calendar
      </h2>
      <p className="calendar-settings-intro">
        Roger reads your Google Calendar to list today’s meetings and to remind you just before a
        call. It never changes your events.
      </p>
      <AccountRow calendar={calendar} nowMs={nowMs} actions={actions.calendar} />
      {settings.status === 'loading' ? (
        <p className="calendar-status" role="status">
          Loading the calendar settings…
        </p>
      ) : null}
      {settings.status === 'failed' ? (
        <div className="error calendar-problem" role="alert">
          <span>Roger could not read the calendar settings: {settings.error}</span>
          <button
            type="button"
            className="btn"
            data-variant="secondary"
            data-size="sm"
            onClick={() => {
              actions.settings.reload();
            }}
          >
            Try again
          </button>
        </div>
      ) : null}
      {settings.status === 'ready' ? (
        <>
          <ReminderField settings={settings} actions={actions.settings} />
          <NoticeFields settings={settings} actions={actions.settings} />
          <OpenAtLoginField settings={settings} actions={actions.settings} />
        </>
      ) : null}
      {settings.saveError === null ? null : (
        <div className="error calendar-problem" role="alert">
          {settings.saveError}
        </div>
      )}
    </section>
  );
}

function AccountRow({
  calendar,
  nowMs,
  actions,
}: {
  calendar: CalendarState;
  nowMs: number;
  actions: CalendarSettingsActions['calendar'];
}) {
  const { connection } = calendar;
  // Per render, not at import: createCalendarFormat says why.
  const reconnect = reconnectLabel(connection, calendar.sync, nowMs, createCalendarFormat());
  const connect = (): void => {
    void actions.connect();
  };
  return (
    <div className="calendar-field" role="group" aria-label="Google account">
      <div className="calendar-account">
        {connection === null ? (
          <>
            <span className="calendar-account-text">
              {calendar.connectionStatus === 'failed'
                ? 'Roger could not read the connection.'
                : 'No calendar connected.'}
            </span>
            {calendar.connectionStatus === 'failed' ? (
              <button
                type="button"
                className="btn"
                data-variant="secondary"
                data-size="sm"
                onClick={() => {
                  actions.reload();
                }}
              >
                Try again
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                data-variant="primary"
                data-size="sm"
                onClick={connect}
              >
                {calendar.connecting ? 'Open Google again' : 'Connect Google Calendar'}
              </button>
            )}
          </>
        ) : (
          <>
            <span className="calendar-account-text">
              Connected as <strong>{connection.accountEmail}</strong>
            </span>
            {reconnect === null ? null : (
              <button
                type="button"
                className="btn"
                data-variant="primary"
                data-size="sm"
                onClick={connect}
              >
                {calendar.connecting ? 'Open Google again' : reconnect}
              </button>
            )}
            <button
              type="button"
              className="btn"
              data-variant="secondary"
              data-size="sm"
              disabled={calendar.disconnecting}
              onClick={() => {
                void actions.disconnect();
              }}
            >
              {calendar.disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </>
        )}
      </div>
      {calendar.connecting ? (
        <p className="calendar-status" role="status">
          Finish signing in in your browser. Roger waits up to 3 minutes.
        </p>
      ) : null}
      {calendar.connectError === null ? null : (
        <div className="error calendar-problem" role="alert">
          Roger could not connect Google Calendar: {calendar.connectError}
        </div>
      )}
      {calendar.disconnectError === null ? null : (
        <div className="error calendar-problem" role="alert">
          Roger could not disconnect Google Calendar: {calendar.disconnectError}. Your calendar is
          still connected.
        </div>
      )}
    </div>
  );
}

interface FieldProps {
  settings: CalendarSettingsState;
  actions: CalendarSettingsActions['settings'];
}

/** "When the meeting starts", "1 minute before", "5 minutes before". */
function leadLabel(minutes: ReminderLeadMinutes): string {
  if (minutes === 0) return 'When the meeting starts';
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} before`;
}

function ReminderField({ settings, actions }: FieldProps) {
  const id = useId();
  return (
    <div className="calendar-field">
      <label htmlFor={id} className="calendar-label">
        Remind me
      </label>
      <select
        id={id}
        className="calendar-select"
        value={settings.reminderLeadMinutes}
        disabled={settings.saving !== null}
        onChange={(event) => {
          const chosen = REMINDER_LEAD_MINUTES.find(
            (minutes) => String(minutes) === event.currentTarget.value,
          );
          if (chosen !== undefined) void actions.choose('calendar.reminderLeadMinutes', chosen);
        }}
      >
        {REMINDER_LEAD_MINUTES.map((minutes) => (
          <option key={minutes} value={minutes}>
            {leadLabel(minutes)}
          </option>
        ))}
      </select>
    </div>
  );
}

function NoticeFields({ settings, actions }: FieldProps) {
  return (
    <div className="calendar-field">
      <label className="calendar-check">
        <input
          type="checkbox"
          checked={settings.noticeEnabled}
          disabled={settings.saving !== null}
          onChange={(event) => {
            void actions.choose('notice.enabled', event.currentTarget.checked);
          }}
        />
        <span className="calendar-check-text">
          <span>Offer a notice for the other people on the call</span>
          <span className="calendar-hint">
            The reminder and the meeting page get a Copy notice button, to paste into the call’s
            chat.
          </span>
        </span>
      </label>
      {settings.noticeEnabled ? (
        // Keyed by the stored text: after a save the draft starts again from what main stored.
        <NoticeTextEditor
          key={settings.noticeText}
          stored={settings.noticeText}
          saving={settings.saving !== null}
          onSave={(text) => {
            void actions.choose('notice.text', text);
          }}
        />
      ) : null}
    </div>
  );
}

function NoticeTextEditor({
  stored,
  saving,
  onSave,
}: {
  stored: string;
  saving: boolean;
  onSave: (text: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(stored);
  const blank = draft.trim() === '';
  return (
    <div className="calendar-notice-editor">
      <label htmlFor={id} className="calendar-label">
        Notice text
      </label>
      <textarea
        id={id}
        className="calendar-textarea"
        rows={3}
        maxLength={MAX_NOTICE_TEXT_LENGTH}
        value={draft}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
        }}
      />
      {blank ? (
        <p className="calendar-hint calendar-hint-warn">
          Write the notice, or turn it off above: a blank notice would paste nothing.
        </p>
      ) : null}
      <div className="calendar-notice-actions">
        <button
          type="button"
          className="btn"
          data-variant="primary"
          data-size="sm"
          disabled={saving || blank || draft === stored}
          onClick={() => {
            onSave(draft);
          }}
        >
          Save notice
        </button>
        <button
          type="button"
          className="btn"
          data-variant="secondary"
          data-size="sm"
          disabled={draft === DEFAULT_NOTICE_TEXT}
          onClick={() => {
            setDraft(DEFAULT_NOTICE_TEXT);
          }}
        >
          Use the default text
        </button>
      </div>
    </div>
  );
}

function OpenAtLoginField({ settings, actions }: FieldProps) {
  const { openAtLogin, loginItem } = settings;
  return (
    <div className="calendar-field">
      <label className="calendar-check">
        <input
          type="checkbox"
          checked={openAtLogin !== 'off'}
          disabled={settings.saving !== null || loginItem === 'unavailable'}
          onChange={(event) => {
            void actions.choose('app.openAtLogin', event.currentTarget.checked ? 'on' : 'off');
          }}
        />
        <span className="calendar-check-text">
          <span>Open Roger at login</span>
          <span
            className={
              loginItem === 'requires-approval'
                ? 'calendar-hint calendar-hint-warn'
                : 'calendar-hint'
            }
            data-login-item={loginItem ?? 'unknown'}
          >
            {openAtLoginHint(openAtLogin, loginItem)}
          </span>
        </span>
      </label>
      {settings.loginItemError === null ? null : (
        <p className="calendar-hint calendar-hint-warn" role="alert">
          Roger could not ask macOS about it: {settings.loginItemError}
        </p>
      )}
    </div>
  );
}
