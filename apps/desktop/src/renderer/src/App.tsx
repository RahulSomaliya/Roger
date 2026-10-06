import { StatusPanel } from './components/StatusPanel';
import { TranscriptView } from './components/TranscriptView';
import { useCapture } from './state/useCapture';

const PHASE_LABEL = {
  idle: 'Not recording',
  starting: 'Starting…',
  recording: 'Recording',
  stopping: 'Stopping…',
} as const;

export function App() {
  const { status, segments, interim, localError, busy, start, stop } = useCapture();
  const phase = status?.phase ?? 'idle';
  const recording = phase === 'recording';
  const canStart = phase === 'idle' && !busy;
  const canStop = recording && !busy;
  const error = localError ?? status?.error ?? null;

  return (
    <main className="app">
      <header className="header">
        <h1>Roger</h1>
        <span className={`phase phase-${phase}`}>{PHASE_LABEL[phase]}</span>
      </header>

      <div className="controls">
        {recording ? (
          <button
            type="button"
            className="button stop"
            onClick={() => void stop()}
            disabled={!canStop}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="button start"
            onClick={() => void start()}
            disabled={!canStart}
          >
            Start
          </button>
        )}
      </div>

      {error ? (
        <div role="alert" className="error">
          {error}
        </div>
      ) : null}

      {status?.notice ? (
        <div role="status" className="notice">
          {status.notice}
        </div>
      ) : null}

      {status ? <StatusPanel status={status} /> : null}

      <TranscriptView segments={segments} interim={interim} recording={recording} />
    </main>
  );
}
