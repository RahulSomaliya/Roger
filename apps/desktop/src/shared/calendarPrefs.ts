/**
 * Calendar preference keys, defaults and validators: defined here once, read by main (reminders,
 * the login item) and by the renderer's Settings. `registerCalendarPreferences`
 * (M5-T9a) hands `CALENDAR_PREFERENCES` to M4-S2's `PreferencesStore.register`, which stores them
 * in `userData/preferences.json`.
 * Keep this file free of runtime imports: it is bundled into every process.
 */

/** The reminder lead times Settings offers, in minutes before the start. */
export const REMINDER_LEAD_MINUTES = [0, 1, 2, 5, 10] as const;
export type ReminderLeadMinutes = (typeof REMINDER_LEAD_MINUTES)[number];

/** `auto`: turned on when the calendar first connects. `on` and `off`: the user chose. */
export type OpenAtLogin = 'auto' | 'on' | 'off';
const OPEN_AT_LOGIN: readonly OpenAtLogin[] = ['auto', 'on', 'off'];

export interface CalendarPreferenceValues {
  'calendar.reminderLeadMinutes': ReminderLeadMinutes;
  'app.openAtLogin': OpenAtLogin;
}

export type CalendarPreferenceKey = keyof CalendarPreferenceValues;

/**
 * One entry of the `PreferencesStore` registry (M4-S2): `parse` returns the value, or throws with
 * a message that names the key. The store refuses a bad `set` with that message and falls back to
 * the default when the file holds a bad value.
 */
export interface CalendarPreferenceSpec<K extends CalendarPreferenceKey> {
  key: K;
  default: CalendarPreferenceValues[K];
  parse: (raw: unknown) => CalendarPreferenceValues[K];
}

export const CALENDAR_PREFERENCES: {
  readonly [K in CalendarPreferenceKey]: CalendarPreferenceSpec<K>;
} = {
  'calendar.reminderLeadMinutes': {
    key: 'calendar.reminderLeadMinutes',
    default: 1,
    parse: (raw) => {
      if (isOneOf(REMINDER_LEAD_MINUTES, raw)) return raw;
      throw new Error(
        `calendar.reminderLeadMinutes must be one of ${listOf(REMINDER_LEAD_MINUTES)} (got ${describe(raw)})`,
      );
    },
  },
  'app.openAtLogin': {
    key: 'app.openAtLogin',
    // The plan's default is `auto` (on at first connect). It ships only once real-Mac check 1 in
    // docs/plans/M5-calendar.md passes: a login item registered from a build signed without an
    // Apple team id is unproven, and a default that silently does nothing would hide the missed
    // prompts it causes. Flip to 'auto' in the change that logs that check.
    default: 'off',
    parse: (raw) => {
      if (isOneOf(OPEN_AT_LOGIN, raw)) return raw;
      throw new Error(
        `app.openAtLogin must be one of ${listOf(OPEN_AT_LOGIN)} (got ${describe(raw)})`,
      );
    },
  },
};

function isOneOf<T>(choices: readonly T[], raw: unknown): raw is T {
  return choices.some((choice) => choice === raw);
}

/** "0, 1, 2, 5 or 10". Every list here has at least two choices. */
function listOf(choices: readonly (string | number)[]): string {
  return `${choices.slice(0, -1).join(', ')} or ${String(choices.at(-1))}`;
}

/** Enough of a bad value to fix it, without copying a long text into a log line. */
function describe(raw: unknown): string {
  if (typeof raw === 'string') return raw.length > 40 ? `${raw.length} characters` : `"${raw}"`;
  if (typeof raw === 'number' || typeof raw === 'boolean' || raw === null) return String(raw);
  return typeof raw;
}
