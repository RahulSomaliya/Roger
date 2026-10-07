import { createCalendarFormat, calendarNotices, type CalendarNotice } from './calendarFormat';
import { useCalendar, useNow } from './useCalendar';
import './today.css';
import './calendarNotice.css';

export interface CalendarStatusBannerViewProps {
  notices: readonly CalendarNotice[];
  /** A sign-in is waiting on the browser. */
  connecting: boolean;
  /** Why the last connect (the reconnect button's) failed, or null. */
  connectError: string | null;
  onReconnect: () => void;
}

/**
 * The calendar's health above every page (M5-T12; M5-T13 mounts it in the shell's `banner` slot):
 * "Calendar not updated since 09:12" while the copy is stale, "Reconnect Google Calendar" once
 * Google refused the grant, and "Reconnect before Wed 14 Oct" from a day before an External-in-
 * Testing grant expires. The menu bar says the same (main/app/trayMenu.ts). Nothing renders for a
 * healthy calendar or none at all.
 */
export function CalendarStatusBanner() {
  const { state, store } = useCalendar();
  const nowMs = useNow();
  // Per render, not at import: createCalendarFormat says why.
  const format = createCalendarFormat();
  const notices = calendarNotices({
    connection: state.connection,
    sync: state.sync,
    nowMs,
    format,
  });
  return (
    <CalendarStatusBannerView
      notices={notices}
      connecting={state.connecting}
      connectError={state.connectError}
      onReconnect={() => {
        void store.connect();
      }}
    />
  );
}

export function CalendarStatusBannerView({
  notices,
  connecting,
  connectError,
  onReconnect,
}: CalendarStatusBannerViewProps) {
  if (notices.length === 0) return null;
  return (
    <>
      {notices.map((notice) => (
        <div
          key={notice.kind}
          role={notice.kind === 'reconnect-required' ? 'alert' : 'status'}
          className={
            notice.kind === 'reconnect-required'
              ? 'error calendar-banner'
              : 'notice calendar-banner'
          }
          data-notice={notice.kind}
        >
          <span className="calendar-banner-text">{notice.text}</span>
          {notice.action === null ? null : (
            <button
              type="button"
              className="btn"
              data-variant="secondary"
              data-size="sm"
              onClick={onReconnect}
            >
              {connecting ? 'Open Google again' : notice.action}
            </button>
          )}
        </div>
      ))}
      {connectError === null ? null : (
        <div role="alert" className="error calendar-banner">
          Roger could not reconnect Google Calendar: {connectError}
        </div>
      )}
    </>
  );
}
