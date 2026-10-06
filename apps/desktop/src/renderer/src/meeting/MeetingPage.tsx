import { useShell } from '../app/ShellContext';
import { formatClockTime, PHASE_LABEL, UNTITLED_MEETING } from '../app/labels';
import { StatusPanel } from '../components/StatusPanel';
import { TranscriptView } from '../components/TranscriptView';

/**
 * Placeholder from M4-S1; M4-S4 owns this file afterwards and builds the page with its regions.
 * Until then it is M1's window for the meeting the capture view describes: the header with Stop,
 * the capture status (with the meter line the owner asked to see) and the live transcript. The
 * props stay `{ meetingId }`, so S4 rewrites it without touching AppLayout.
 */
export function MeetingPage({ meetingId }: { meetingId: string }) {
  const { capture, captureMeeting, stopRecording } = useShell();
  const { status, segments, interim, busy } = capture;

  if (captureMeeting?.id !== meetingId) {
    return (
      <div className="page">
        <header className="page-header">
          <h1 className="page-title">{UNTITLED_MEETING}</h1>
        </header>
        <p className="empty-state-text">
          Roger can show only the meeting it recorded last for now. This one is saved on this Mac.
        </p>
      </div>
    );
  }

  const phase = status?.phase ?? 'idle';
  const recording = phase === 'recording';
  return (
    <div className="meeting-page">
      <header className="page-header">
        <div className="page-header-text">
          <h1 className="page-title">{UNTITLED_MEETING}</h1>
          {captureMeeting.startedAt !== null ? (
            <p className="page-meta">Started {formatClockTime(captureMeeting.startedAt)}</p>
          ) : null}
        </div>
        <span className={`phase phase-${phase}`}>{PHASE_LABEL[phase]}</span>
        {recording ? (
          <button type="button" className="button stop" disabled={busy} onClick={stopRecording}>
            Stop
          </button>
        ) : null}
      </header>
      {status ? <StatusPanel status={status} /> : null}
      <TranscriptView segments={segments} interim={interim} recording={recording} />
    </div>
  );
}
