import { useEffect, useState } from 'react';
import { describeError } from '../app/describeError';
import { meetingPhase } from '../app/captureMeeting';
import { useShell } from '../app/ShellContext';
import type { MeetingSlotProps } from '../app/slotRegistry';
import type { CalendarSettingsState } from './calendarSettingsStore';
import { useCalendarSettings } from './useCalendar';
import './calendar.css';

/** How long "Notice copied" stays up before the banner goes. */
const COPIED_SHOWN_MS = 4_000;

/**
 * Whether the notice banner shows on a meeting's page: while the meeting is being recorded, the
 * notice is on, and it was not copied or dismissed for this meeting before. Not before the
 * settings are read: a banner that appears and vanishes for a user who turned the notice off would
 * flash on every meeting page.
 */
export function noticeBannerVisible(input: {
  meetingId: string;
  /** This meeting is the one being recorded (meetingPhase is not idle for it). */
  recordingHere: boolean;
  settings: Pick<CalendarSettingsState, 'status' | 'noticeEnabled' | 'noticeDone'>;
}): boolean {
  const { meetingId, recordingHere, settings } = input;
  return (
    recordingHere &&
    settings.status === 'ready' &&
    settings.noticeEnabled &&
    !settings.noticeDone.includes(meetingId)
  );
}

/**
 * The consent notice's banner on the meeting page (M5-T12; M5-T13 mounts it in the shell's
 * `meetingBanner` slot): the same text and Copy button as the reminder, until copied or dismissed.
 * "Copy notice" never hides the banner at once: it says the notice is copied for a few seconds, so
 * the click is seen to have worked, and the meeting is marked done when the copy succeeds, not
 * when the confirmation goes, so leaving the page in between does not bring the banner back.
 *
 * Trap: the copy goes through the page's `navigator.clipboard`, which the page policy does not
 * grant as a permission (page-policy.ts denies all but `media`); Chromium lets a text write
 * through on a user click without one. A refusal shows in the banner, never silently: the user
 * would paste an older clipboard into a call.
 */
export function NoticeBanner({ meetingId }: MeetingSlotProps) {
  const { state, store } = useCalendarSettings();
  const { capture, captureMeeting } = useShell();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recordingHere =
    captureMeeting?.id === meetingId && meetingPhase(captureMeeting, capture.status) !== 'idle';
  const visible = noticeBannerVisible({ meetingId, recordingHere, settings: state });

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => {
      setCopied(false);
    }, COPIED_SHOWN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  if (!visible && !copied) return null;
  return (
    <NoticeBannerView
      text={state.noticeText}
      copied={copied}
      error={error}
      onCopy={() => {
        setError(null);
        navigator.clipboard.writeText(state.noticeText).then(
          () => {
            setCopied(true);
            store.markNoticeDone(meetingId);
          },
          (failure: unknown) => {
            setError(`Roger could not copy the notice: ${describeError(failure)}`);
          },
        );
      }}
      onDismiss={() => {
        store.markNoticeDone(meetingId);
      }}
    />
  );
}

export interface NoticeBannerViewProps {
  /** The notice text, as Copy notice puts it on the clipboard. */
  text: string;
  /** The text was just copied. */
  copied: boolean;
  /** Why the last copy failed, or null. */
  error: string | null;
  onCopy: () => void;
  onDismiss: () => void;
}

export function NoticeBannerView({
  text,
  copied,
  error,
  onCopy,
  onDismiss,
}: NoticeBannerViewProps) {
  if (copied) {
    return (
      <div className="notice calendar-notice" role="status">
        Notice copied. Paste it into the call’s chat.
      </div>
    );
  }
  return (
    <div className="notice calendar-notice" role="status">
      <div className="calendar-notice-body">
        <p className="calendar-notice-title">
          Let the others on the call know you are taking notes.
        </p>
        <p className="calendar-notice-text">{text}</p>
        {error === null ? null : <p className="calendar-notice-error">{error}</p>}
      </div>
      <div className="calendar-notice-actions">
        <button type="button" className="shell-button calendar-start" onClick={onCopy}>
          Copy notice
        </button>
        <button type="button" className="shell-button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
