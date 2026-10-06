import '../meeting/recentMeetings.css';
import { recentMeetingLabel } from '../meeting/meetingTimes';
import { useRecentMeetings } from '../meeting/useMeeting';
import { meetingPhase } from './captureMeeting';
import { useShell } from './ShellContext';

/**
 * The sidebar's recent meetings: the newest stored on this Mac (`meetings:list`), the one Roger
 * records marked live, the one shown marked current. Each opens its meeting page. On a narrow
 * window the sidebar is a bar across the top and this list scrolls sideways in its own strip
 * (meeting/recentMeetings.css). Takes no props: the sidebar mounts it as it is.
 */
export function RecentMeetings() {
  const { route, navigate, capture, captureMeeting } = useShell();
  const livePhase = meetingPhase(captureMeeting, capture.status);
  const liveId = livePhase !== 'idle' ? (captureMeeting?.id ?? null) : null;
  // Read again on every status main sends outside a recording: a start adds a meeting, a Stop
  // ends it or deletes it when nobody spoke. Not only when the phase this page sees changes: React
  // renders a burst of statuses once (the preview's scenarios send `recording` then `idle` in one
  // task), so a key built from the phases it saw can miss a whole recording. While one records,
  // main sends a status with every line, so a recording reads once, at its start.
  const status = capture.status;
  const recent = useRecentMeetings(
    status?.phase === 'recording' ? `recording ${status.meetingId ?? ''}` : status,
  );
  const meetings = recent.value ?? [];
  const now = new Date();
  return (
    <section className="sidebar-section recent-meetings" aria-labelledby="recent-meetings">
      <h2 id="recent-meetings" className="sidebar-heading">
        Recent
      </h2>
      {recent.error !== null ? (
        <div role="alert" className="recent-meetings-error">
          <span>{recent.error}</span>
          <button type="button" className="recent-meetings-retry" onClick={recent.refresh}>
            Try again
          </button>
        </div>
      ) : null}
      {recent.value?.length === 0 ? <p className="sidebar-empty">No meetings yet</p> : null}
      {meetings.length > 0 ? (
        <ul className="sidebar-list recent-meetings-list">
          {meetings.map((meeting) => (
            <li key={meeting.id}>
              <button
                type="button"
                className="sidebar-link"
                // The whole title, for one the sidebar cuts short.
                title={meeting.title}
                aria-current={
                  route.name === 'meeting' && route.meetingId === meeting.id ? 'page' : undefined
                }
                onClick={() => {
                  navigate({ name: 'meeting', meetingId: meeting.id });
                }}
              >
                {meeting.id === liveId ? (
                  <>
                    <span className="recording-dot" aria-hidden="true" />
                    <span className="visually-hidden">Recording: </span>
                  </>
                ) : null}
                <span className="sidebar-link-text">{meeting.title}</span>
                <span className="sidebar-link-meta">
                  {recentMeetingLabel(meeting.startedAt, now)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
