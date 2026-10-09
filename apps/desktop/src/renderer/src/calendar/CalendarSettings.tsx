import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { REMINDER_LEAD_MINUTES, type ReminderLeadMinutes } from '../../../shared/calendarPrefs';
import { SettingsProblem } from '../settings/SettingsProblem';
import { SettingsRow } from '../settings/SettingsRow';
import {
  createCalendarFormat,
  GOOGLE_NOT_SET_UP,
  isGoogleNotSetUp,
  reconnectLabel,
} from './calendarFormat';
import type { CalendarSettingsState, CalendarSettingsStore } from './calendarSettingsStore';
import type { CalendarState, CalendarStore } from './calendarStore';
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
 * Google account with Connect, Reconnect and Disconnect (which asks first, in place), and how long
 * before a call the reminder shows. Opening Roger at login lives in the Mac section
 * (settings/MacSettings.tsx). Every choice saves as it is made (no Save buttons, redesign R6): the
 * select on change. Main's PreferencesStore keeps the choices; this shows what main stored and
 * changes it only through `setPreference` (calendarSettingsStore.ts).
 *
 * Trap: no control here is ever `disabled` while a save is out. A blur comes BEFORE the click that
 * caused it, so a control that went disabled in between would swallow that click.
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
  /** Whether Disconnect's question starts open; a test shows that state without a click. */
  confirmingDisconnect?: boolean;
}

export function CalendarSettingsSection({
  calendar,
  settings,
  nowMs,
  actions,
  confirmingDisconnect = false,
}: CalendarSettingsSectionProps) {
  const headingId = useId();
  const accountId = useId();
  return (
    <section className="settings-section calendar-settings" aria-labelledby={headingId}>
      <h2 id={headingId} className="settings-section-title">
        Calendar
      </h2>
      <SettingsRow
        label="Google account"
        labelId={accountId}
        help="Roger reads your Google Calendar to list today’s meetings and to remind you just before a call. It never changes your events."
      >
        <AccountRow
          calendar={calendar}
          nowMs={nowMs}
          actions={actions.calendar}
          labelId={accountId}
          confirmingDisconnect={confirmingDisconnect}
        />
      </SettingsRow>
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
        <ReminderField settings={settings} actions={actions.settings} />
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
  labelId,
  confirmingDisconnect,
}: {
  calendar: CalendarState;
  nowMs: number;
  actions: CalendarSettingsActions['calendar'];
  labelId: string;
  confirmingDisconnect: boolean;
}) {
  const { connection } = calendar;
  // Per render, not at import: createCalendarFormat says why.
  const reconnect = reconnectLabel(connection, calendar.sync, nowMs, createCalendarFormat());
  const notSetUp = isGoogleNotSetUp(calendar.connectError);
  const [confirming, setConfirming] = useState(confirmingDisconnect);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // Focus follows the question: onto Cancel (the safe answer) when it opens, back onto Disconnect
  // when it is cancelled. Confirming clears `asked` first: the button is about to go away with the
  // connection, and focus has nowhere useful to return to.
  const asked = useRef(false);
  useEffect(() => {
    if (confirming) {
      asked.current = true;
      cancel.current?.focus();
    } else if (asked.current) {
      asked.current = false;
      trigger.current?.focus();
    }
  }, [confirming]);
  const connect = (): void => {
    void actions.connect();
  };
  const disconnect = (): void => {
    asked.current = false;
    setConfirming(false);
    // Busy is not disabled (docs/design.md): the button keeps its colour and takes no click.
    if (calendar.disconnecting) return;
    void actions.disconnect();
  };
  const leaveQuestion = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape' || !confirming) return;
    // Escape closes the question only: it must not also leave Settings for Home (the shell's
    // Escape), so the key stops here.
    event.preventDefault();
    event.stopPropagation();
    setConfirming(false);
  };
  return (
    <div
      className="settings-field"
      role="group"
      aria-labelledby={labelId}
      onKeyDown={leaveQuestion}
    >
      <div className="calendar-account">
        {connection === null ? (
          <>
            {calendar.connectionStatus === 'failed' ? (
              <>
                <span className="calendar-account-text">Roger could not read the connection.</span>
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
              </>
            ) : (
              // The view's one primary. While Roger waits for the browser the button stays, and
              // opens Google again if the tab was closed: the line below says so. With no Google
              // client on the server (D4) pressing it can only fail again, so it is disabled and
              // the reason sits beside it.
              <>
                <button
                  type="button"
                  className="btn"
                  data-variant="primary"
                  data-size="sm"
                  disabled={notSetUp}
                  aria-describedby={notSetUp ? `${labelId}-why` : undefined}
                  onClick={connect}
                >
                  Connect Google Calendar
                </button>
                {notSetUp ? (
                  <span id={`${labelId}-why`} className="calendar-account-text" role="status">
                    {GOOGLE_NOT_SET_UP}
                  </span>
                ) : null}
              </>
            )}
          </>
        ) : confirming ? (
          <>
            <span className="calendar-account-text" role="alert">
              Disconnect Google Calendar? Reminders stop.
            </span>
            <button
              ref={cancel}
              type="button"
              className="btn"
              data-variant="ghost"
              data-size="sm"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              data-variant="secondary"
              data-size="sm"
              onClick={disconnect}
            >
              Disconnect
            </button>
          </>
        ) : (
          <>
            <span className="calendar-account-text">
              Connected as{' '}
              <strong>
                {connection.provider === 'fake' ? 'Demo calendar' : connection.accountEmail}
              </strong>
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
              ref={trigger}
              type="button"
              className="btn"
              data-variant="ghost"
              data-size="sm"
              aria-disabled={calendar.disconnecting ? 'true' : undefined}
              onClick={() => {
                if (!calendar.disconnecting) setConfirming(true);
              }}
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
      {calendar.connectError === null || notSetUp ? null : (
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
    <SettingsRow label="Remind me" htmlFor={id}>
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
    </SettingsRow>
  );
}
