import { useState } from 'react';
import { describeError } from '../app/describeError';
import { meetingPhase } from '../app/captureMeeting';
import { useShell } from '../app/ShellContext';
import type { MeetingSlotProps } from '../app/slotRegistry';
import { Icon } from '../components/ui/icons';
import type { CalendarSettingsState } from './calendarSettingsStore';
import { useCalendarSettings } from './useCalendar';
import './today.css';
import './calendarNotice.css';

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
 * The consent notice's line on the meeting page (M5-T12; M5-T13 mounts it in the shell's
 * `meetingBanner` slot): one line with Copy notice and Dismiss; the notice text shows on hover and
 * focus. "Copy notice" never hides the line: the button reads "Copied" and the line stays until
 * Dismiss (docs/design.md, Motion: success stays until read), so the click is seen to have worked.
 * The meeting is marked done when the copy succeeds, not when the line is dismissed, so leaving
 * the page in between does not bring the line back.
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
        setCopied(false);
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

/** The text's id, for the Copy button to point at: the line says what the notice is, the popover what it says. */
const NOTICE_TEXT_ID = 'calendar-notice-text';

/**
 * Trap: the notice text is in the page at all times and only its popover is shown on hover and
 * focus (calendarNotice.css, over the page, out of the flow). A line that grew on hover would move
 * the notes under the person's cursor mid-call, and `display: none` would take the text out of a
 * screen reader's reach. The copy error is its own loud problem line, never folded into the line:
 * a refused copy means an older clipboard gets pasted into a call.
 */
export function NoticeBannerView({
  text,
  copied,
  error,
  onCopy,
  onDismiss,
}: NoticeBannerViewProps) {
  return (
    <>
      <div className="calendar-notice" role="status">
        <span className="calendar-notice-line">Tell the others on the call you are recording</span>
        <div className="calendar-notice-buttons">
          <button
            type="button"
            className="btn"
            data-variant="secondary"
            data-size="sm"
            aria-describedby={NOTICE_TEXT_ID}
            onClick={onCopy}
          >
            {copied ? 'Copied' : 'Copy notice'}
          </button>
          <button
            type="button"
            className="btn"
            data-variant="ghost"
            data-size="sm"
            onClick={onDismiss}
          >
            Dismiss
          </button>
        </div>
        <p className="calendar-notice-text" id={NOTICE_TEXT_ID}>
          {text}
        </p>
      </div>
      {error === null ? null : (
        <div className="problem" role="alert">
          <Icon name="circle-alert" />
          <span className="problem-text">{error}</span>
        </div>
      )}
    </>
  );
}
