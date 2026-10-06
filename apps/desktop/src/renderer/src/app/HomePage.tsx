import { formatClockTime, UNTITLED_MEETING } from './labels';
import { isSlotEmpty, SlotOutlet } from './SlotOutlet';
import { useShell } from './ShellContext';

/** Home: the recording in progress, then the `home` slot (M2's kept-audio card, M5's Today). */
export function HomePage() {
  const { capture, captureMeeting, navigate } = useShell();
  const recording = (capture.status?.phase ?? 'idle') !== 'idle' && captureMeeting !== null;
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Home</h1>
      </header>
      {recording ? (
        <section className="card live-card" aria-label="Recording now">
          <span className="recording-dot" aria-hidden="true" />
          <div className="card-text">
            <p className="card-title">{UNTITLED_MEETING}</p>
            <p className="card-meta">
              {captureMeeting.startedAt !== null
                ? `Recording since ${formatClockTime(captureMeeting.startedAt)}`
                : 'Recording'}
            </p>
          </div>
          <button
            type="button"
            className="shell-button"
            onClick={() => {
              navigate({ name: 'meeting', meetingId: captureMeeting.id });
            }}
          >
            Open
          </button>
        </section>
      ) : null}
      {!recording && isSlotEmpty('home') ? (
        <div className="empty-state">
          <p className="empty-state-title">Take notes on your next call</p>
          <p className="empty-state-text">
            Press New note when the call starts. Roger records your microphone and the call audio,
            and writes the transcript as people speak.
          </p>
        </div>
      ) : null}
      <SlotOutlet name="home" props={{}} />
    </div>
  );
}
