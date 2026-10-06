import { formatClockTime, UNTITLED_MEETING } from './labels';
import { useShell } from './ShellContext';

/**
 * Placeholder from M4-S1; M4-S4 owns this file afterwards and lists the meetings stored on this
 * Mac (meetings:list). Until then: the meeting this window recorded last, so its transcript is one
 * click away after Stop. Takes no props, so S4 rewrites it without touching the sidebar.
 */
export function RecentMeetings() {
  const { route, navigate, capture, captureMeeting } = useShell();
  const recording = (capture.status?.phase ?? 'idle') !== 'idle';
  return (
    <section className="sidebar-section" aria-labelledby="recent-meetings">
      <h2 id="recent-meetings" className="sidebar-heading">
        Recent
      </h2>
      {captureMeeting === null ? (
        <p className="sidebar-empty">No meetings yet</p>
      ) : (
        <ul className="sidebar-list">
          <li>
            <button
              type="button"
              className="sidebar-link"
              aria-current={
                route.name === 'meeting' && route.meetingId === captureMeeting.id
                  ? 'page'
                  : undefined
              }
              onClick={() => {
                navigate({ name: 'meeting', meetingId: captureMeeting.id });
              }}
            >
              {recording ? (
                <>
                  <span className="recording-dot" aria-hidden="true" />
                  <span className="visually-hidden">Recording: </span>
                </>
              ) : null}
              <span className="sidebar-link-text">{UNTITLED_MEETING}</span>
              {captureMeeting.startedAt !== null ? (
                <span className="sidebar-link-meta">
                  {formatClockTime(captureMeeting.startedAt)}
                </span>
              ) : null}
            </button>
          </li>
        </ul>
      )}
    </section>
  );
}
