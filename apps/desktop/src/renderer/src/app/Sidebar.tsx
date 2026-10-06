import { PHASE_LABEL } from './labels';
import { RecentMeetings } from './RecentMeetings';
import { HOME, type Route } from './router';
import { useShell } from './ShellContext';

const SETTINGS: Route = { name: 'settings' };

/**
 * The sidebar: "New note", Home, recent meetings and Settings. On a narrow window (app.css) it is
 * a bar across the top. Every item is a button that calls navigate(): a link to `#/...` would
 * change the hash, which router.ts explains must never happen.
 */
export function Sidebar() {
  return (
    <nav className="sidebar" aria-label="Roger">
      <div className="sidebar-head">
        <span className="sidebar-brand">Roger</span>
        <RecordingAction />
      </div>
      <ul className="sidebar-list">
        <li>
          <NavItem label="Home" target={HOME} />
        </li>
      </ul>
      <RecentMeetings />
      <ul className="sidebar-list sidebar-foot">
        <li>
          <NavItem label="Settings" target={SETTINGS} />
        </li>
      </ul>
    </nav>
  );
}

/**
 * "New note" while idle. While a recording runs (or starts, or stops) the same place shows its
 * state and opens its meeting, where Stop is: one recording at a time.
 */
function RecordingAction() {
  const { navigate, capture, captureMeeting, startNewNote } = useShell();
  const phase = capture.status?.phase ?? 'idle';
  if (phase !== 'idle' && captureMeeting !== null) {
    return (
      <button
        type="button"
        className="sidebar-action sidebar-live"
        onClick={() => {
          navigate({ name: 'meeting', meetingId: captureMeeting.id });
        }}
      >
        <span className="recording-dot" aria-hidden="true" />
        {PHASE_LABEL[phase]}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="button start sidebar-action"
      disabled={phase !== 'idle' || capture.busy}
      onClick={startNewNote}
    >
      {phase === 'idle' ? 'New note' : PHASE_LABEL[phase]}
    </button>
  );
}

function NavItem({ label, target }: { label: string; target: Route }) {
  const { route, navigate } = useShell();
  return (
    <button
      type="button"
      className="sidebar-link"
      aria-current={route.name === target.name ? 'page' : undefined}
      onClick={() => {
        navigate(target);
      }}
    >
      <span className="sidebar-link-text">{label}</span>
    </button>
  );
}
