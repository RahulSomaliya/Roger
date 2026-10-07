import {
  CALENDAR_PREFERENCES,
  type CalendarPreferenceKey,
  type OpenAtLogin,
  type ReminderLeadMinutes,
} from '../../../shared/calendarPrefs';
import type { LoginItemApi, LoginItemStatus } from '../../../shared/ipc/loginItem';
import type { PrefsApi } from '../../../shared/ipc/prefs';
import type { Unsubscribe } from '../../../shared/ipc/unsubscribe';
import type { PreferenceValues } from '../../../shared/preferences';
import { describeError } from '../app/describeError';
import type { ReadStatus } from './calendarStore';
import { RetainedStore } from './retainedStore';

/** What the store calls on `window.roger`; a test passes a stand-in. */
export type CalendarSettingsApi = Pick<
  PrefsApi,
  'getPreferences' | 'setPreference' | 'onPreferenceChanged'
> &
  LoginItemApi;

export interface CalendarSettingsState {
  /** `loading` until main answers; `failed` when it could not read the preferences. */
  status: ReadStatus;
  error: string | null;
  reminderLeadMinutes: ReminderLeadMinutes;
  noticeEnabled: boolean;
  noticeText: string;
  /** What the user chose. What macOS did with it is `loginItem`. */
  openAtLogin: OpenAtLogin;
  /** What macOS says about Roger as a login item; null until it answers or when it cannot. */
  loginItem: LoginItemStatus | null;
  loginItemError: string | null;
  saveError: string | null;
  /** Meetings whose notice was copied or dismissed: the meeting banner shows once per meeting. */
  noticeDone: readonly string[];
}

/**
 * The calendar's four preferences and the login item's state, for Settings, the meeting banner
 * and the line after the first connect. Main's PreferencesStore keeps the values; the page shows
 * what main stored and changes it only through `setPreference`, whose change event then updates
 * the page. A preference cannot say whether macOS accepted the login item (it can wait for the
 * user's approval), so that comes from its own channel.
 */
export class CalendarSettingsStore extends RetainedStore<CalendarSettingsState> {
  private run = 0;
  /** Keys a change event set since the read began: newer than what the read will answer. */
  private readonly changed = new Set<CalendarPreferenceKey>();

  constructor(private readonly api: CalendarSettingsApi) {
    super({
      status: 'loading',
      error: null,
      reminderLeadMinutes: CALENDAR_PREFERENCES['calendar.reminderLeadMinutes'].default,
      noticeEnabled: CALENDAR_PREFERENCES['notice.enabled'].default,
      noticeText: CALENDAR_PREFERENCES['notice.text'].default,
      openAtLogin: CALENDAR_PREFERENCES['app.openAtLogin'].default,
      loginItem: null,
      loginItemError: null,
      saveError: null,
      noticeDone: [],
    });
  }

  protected start(): Unsubscribe {
    this.run += 1;
    const run = this.run;
    const stops = [
      this.api.onPreferenceChanged((change) => {
        if (run !== this.run) return;
        switch (change.key) {
          case 'calendar.reminderLeadMinutes':
            this.update({ reminderLeadMinutes: change.value });
            break;
          case 'notice.enabled':
            this.update({ noticeEnabled: change.value });
            break;
          case 'notice.text':
            this.update({ noticeText: change.value });
            break;
          case 'app.openAtLogin':
            this.update({ openAtLogin: change.value });
            break;
          default:
            return; // another feature's key
        }
        this.changed.add(change.key);
      }),
      this.api.onLoginItemStateChanged((state) => {
        if (run === this.run) this.update({ loginItem: state.status, loginItemError: null });
      }),
    ];
    this.read(run);
    return () => {
      if (run !== this.run) return;
      this.run += 1;
      for (const stop of stops) stop();
    };
  }

  /** Reads again, after a failed read. */
  reload(): void {
    this.update({ status: 'loading', error: null });
    this.read(this.run);
  }

  /**
   * Saves one choice. Never rejects: a refusal shows in `saveError`, the stored value stays. Calls
   * may overlap (the notice text saves on blur, a click later saves another choice); main applies
   * them in the order they arrive, so there is no "saving" state for a control to wait on.
   */
  async choose<K extends CalendarPreferenceKey>(key: K, value: PreferenceValues[K]): Promise<void> {
    this.update({ saveError: null });
    try {
      await this.api.setPreference(key, value);
    } catch (error) {
      this.update({ saveError: `Roger could not save that setting: ${describeError(error)}` });
    }
  }

  /** The notice for this meeting was copied or dismissed: its banner is done. */
  markNoticeDone(meetingId: string): void {
    if (this.state.noticeDone.includes(meetingId)) return;
    this.update({ noticeDone: [...this.state.noticeDone, meetingId] });
  }

  private read(run: number): void {
    this.changed.clear();
    this.api.getPreferences().then(
      (values) => {
        if (run !== this.run) return;
        const keep = (key: CalendarPreferenceKey) => this.changed.has(key);
        this.update({
          status: 'ready',
          error: null,
          ...(keep('calendar.reminderLeadMinutes')
            ? {}
            : { reminderLeadMinutes: values['calendar.reminderLeadMinutes'] }),
          ...(keep('notice.enabled') ? {} : { noticeEnabled: values['notice.enabled'] }),
          ...(keep('notice.text') ? {} : { noticeText: values['notice.text'] }),
          ...(keep('app.openAtLogin') ? {} : { openAtLogin: values['app.openAtLogin'] }),
        });
      },
      (error: unknown) => {
        if (run === this.run) this.update({ status: 'failed', error: describeError(error) });
      },
    );
    this.api.getLoginItemState().then(
      (state) => {
        if (run === this.run) this.update({ loginItem: state.status, loginItemError: null });
      },
      (error: unknown) => {
        if (run === this.run) this.update({ loginItemError: describeError(error) });
      },
    );
  }
}
