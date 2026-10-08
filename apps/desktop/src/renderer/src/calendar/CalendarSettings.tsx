import { useId, useRef, useState } from 'react';
import {
  DEFAULT_NOTICE_TEXT,
  MAX_NOTICE_TEXT_LENGTH,
  REMINDER_LEAD_MINUTES,
  type ReminderLeadMinutes,
} from '../../../shared/calendarPrefs';
import { SettingsProblem } from '../settings/SettingsProblem';
import { createCalendarFormat, openAtLoginHint, reconnectLabel } from './calendarFormat';
import type { CalendarSettingsState, CalendarSettingsStore } from './calendarSettingsStore';
import type { CalendarState, CalendarStore } from './calendarStore';
import { noticeToSave } from './noticeDraft';
import { useCalendar, useCalendarSettings, useNow } from './useCalendar';
import '../settings/settings.css';
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
 * login. Every choice saves as it is made (no Save buttons, redesign R6): the select and the
 * switches on change, the notice text on blur. Main's PreferencesStore keeps the choices; this
 * shows what main stored and changes it only through `setPreference` (calendarSettingsStore.ts).
 *
 * Trap: no control here is ever `disabled` while a save is out. The notice box saves on blur, and
 * a blur comes BEFORE the click that caused it: a switch or "Use the default text" that went
 * disabled in between would swallow that click.
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
    <section className="settings-section calendar-settings" aria-labelledby={headingId}>
      <h2 id={headingId} className="settings-section-title">
        Calendar
      </h2>
      <p className="settings-help">
        Roger reads your Google Calendar to list today’s meetings and to remind you just before a
        call. It never changes your events.
      </p>
      <AccountRow calendar={calendar} nowMs={nowMs} actions={actions.calendar} />
      {settings.status === 'loading' ? (
        <p className="settings-help" role="status">
          Loading the calendar settings…
        </p>
      ) : null}
      {settings.status === 'failed' ? (
        <SettingsProblem
          role="alert"
          action={
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
          }
        >
          Roger could not read the calendar settings: {settings.error}
        </SettingsProblem>
      ) : null}
      {settings.status === 'ready' ? (
        <>
          <ReminderField settings={settings} actions={actions.settings} />
          <NoticeFields settings={settings} actions={actions.settings} />
          <OpenAtLoginField settings={settings} actions={actions.settings} />
        </>
      ) : null}
      {settings.saveError === null ? null : (
        <SettingsProblem role="alert">{settings.saveError}</SettingsProblem>
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
  const disconnect = (): void => {
    // Busy is not disabled (docs/design.md): the button keeps its colour and takes no click.
    if (calendar.disconnecting) return;
    void actions.disconnect();
  };
  return (
    <div className="settings-field" role="group" aria-label="Google account">
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
              // The view's one primary. While Roger waits for the browser the button stays, and
              // opens Google again if the tab was closed: the line below says so.
              <button
                type="button"
                className="btn"
                data-variant="primary"
                data-size="sm"
                onClick={connect}
              >
                Connect Google Calendar
              </button>
            )}
          </>
        ) : (
          <>
            <span className="calendar-account-text">
              Connected as <strong>{connection.accountEmail}</strong>
            </span>
            {reconnect === null ? null : (
              // A refused or expiring grant is the one thing to do on this screen, so it takes
              // the primary; Disconnect is a ghost either way.
              <button
                type="button"
                className="btn"
                data-variant="primary"
                data-size="sm"
                onClick={connect}
              >
                {reconnect}
              </button>
            )}
            <button
              type="button"
              className="btn"
              data-variant="ghost"
              data-size="sm"
              aria-disabled={calendar.disconnecting ? 'true' : undefined}
              onClick={disconnect}
            >
              {calendar.disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </>
        )}
      </div>
      {calendar.connecting ? (
        <p className="settings-help" role="status">
          Finish signing in in your browser. Roger waits up to 3 minutes.
        </p>
      ) : null}
      {calendar.connectError === null ? null : (
        <SettingsProblem role="alert">
          Roger could not connect Google Calendar: {calendar.connectError}
        </SettingsProblem>
      )}
      {calendar.disconnectError === null ? null : (
        <SettingsProblem role="alert">
          Roger could not disconnect Google Calendar: {calendar.disconnectError}. Your calendar is
          still connected.
        </SettingsProblem>
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
    <div className="settings-field">
      <label htmlFor={id} className="settings-label">
        Remind me
      </label>
      <select
        id={id}
        className="settings-input calendar-select"
        value={settings.reminderLeadMinutes}
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
    <div className="settings-field">
      <label className="calendar-check">
        <input
          type="checkbox"
          checked={settings.noticeEnabled}
          onChange={(event) => {
            void actions.choose('notice.enabled', event.currentTarget.checked);
          }}
        />
        <span className="calendar-check-text">
          <span>Offer a notice for the other people on the call</span>
          <span className="calendar-hint">
            The meeting page gets a Copy notice button, to paste into the call’s chat.
          </span>
        </span>
      </label>
      {settings.noticeEnabled ? (
        // Keyed by the stored text: after a save the draft starts again from what main stored.
        <NoticeTextEditor
          key={settings.noticeText}
          stored={settings.noticeText}
          onSave={(text) => {
            void actions.choose('notice.text', text);
          }}
        />
      ) : null}
    </div>
  );
}

function NoticeTextEditor({ stored, onSave }: { stored: string; onSave: (text: string) => void }) {
  const id = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(stored);
  const blank = draft.trim() === '';
  return (
    <div className="calendar-notice-editor">
      <label htmlFor={id} className="settings-label">
        Notice text
      </label>
      <textarea
        ref={box}
        id={id}
        className="settings-input calendar-textarea"
        rows={3}
        maxLength={MAX_NOTICE_TEXT_LENGTH}
        value={draft}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
        }}
        onBlur={() => {
          const text = noticeToSave(draft, stored);
          if (text !== null) onSave(text);
        }}
      />
      {blank ? (
        <SettingsProblem role="status">
          Write the notice, or turn it off above: a blank notice would paste nothing.
        </SettingsProblem>
      ) : null}
      {draft === DEFAULT_NOTICE_TEXT ? null : (
        <div className="calendar-notice-actions">
          <button
            type="button"
            className="btn"
            data-variant="ghost"
            data-size="sm"
            onClick={() => {
              // Saves itself: the click blurs the box first, and a draft set here would otherwise
              // sit unsaved until a blur that never comes.
              setDraft(DEFAULT_NOTICE_TEXT);
              onSave(DEFAULT_NOTICE_TEXT);
              // The button goes with the difference; keep the keyboard in the editor.
              box.current?.focus();
            }}
          >
            Use the default text
          </button>
        </div>
      )}
    </div>
  );
}

function OpenAtLoginField({ settings, actions }: FieldProps) {
  const { openAtLogin, loginItem } = settings;
  // Said only when there is something to do or to know: macOS waits on a click in System
  // Settings, or this build cannot register a login item. Otherwise the switch says it all.
  const hint =
    loginItem === 'requires-approval' || loginItem === 'unavailable'
      ? openAtLoginHint(loginItem)
      : null;
  return (
    <div className="settings-field">
      <label className="calendar-check">
        <input
          type="checkbox"
          checked={openAtLogin !== 'off'}
          disabled={loginItem === 'unavailable'}
          onChange={(event) => {
            void actions.choose('app.openAtLogin', event.currentTarget.checked ? 'on' : 'off');
          }}
        />
        <span className="calendar-check-text">
          <span>Open Roger at login</span>
          {hint === null ? null : (
            <span className="calendar-hint" data-login-item={loginItem}>
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
