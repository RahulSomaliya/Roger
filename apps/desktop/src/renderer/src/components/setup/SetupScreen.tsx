import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { SetupModel, type SetupScreenState } from './setupModel';
import {
  type SetupAction,
  type SetupActionKind,
  type SetupRowId,
  type SetupRowView,
  setupRows,
  setupSummary,
} from './setupRows';
import './setup.css';

/** What a row says while its action runs: most wait on the Mac, or on the person. */
const RUNNING_TEXT: Record<SetupActionKind, string> = {
  'request-microphone': 'Waiting for your answer in the macOS dialog…',
  'test-system-audio': 'Playing a test sound and listening for it…',
  'confirm-system-audio': 'Playing a test sound and listening for it…',
  'test-notification': 'Waiting for macOS to show the notification…',
  'open-pane': 'Opening System Settings…',
  relaunch: 'Relaunching Roger…',
  recheck: 'Checking…',
};

/**
 * The permission setup screen (M2-T19), in the shell's full-window `setup` route
 * (app/slots/m2-setup.ts): one row per thing Roger needs on this Mac, what is wrong in main's
 * words, and the buttons that fix it. It reads the status again whenever the window regains
 * focus, so a switch flipped in System Settings shows the moment the person comes back.
 */
export function SetupScreen() {
  // One model per mount: leaving setup and coming back reads the Mac afresh.
  const [model] = useState(() => new SetupModel(window.roger));
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  useEffect(() => {
    // load() and run() never reject: a failure becomes the state that shows it.
    void model.load();
    const reload = (): void => {
      void model.load();
    };
    window.addEventListener('focus', reload);
    return () => {
      window.removeEventListener('focus', reload);
    };
  }, [model]);
  return (
    <SetupView
      state={state}
      onAction={(row, action) => {
        void model.run(row, action);
      }}
      onRetry={() => {
        void model.load();
      }}
    />
  );
}

interface SetupViewProps {
  state: SetupScreenState;
  onAction: (row: SetupRowId, action: SetupAction) => void;
  onRetry: () => void;
}

/** The screen for one state. */
export function SetupView({ state, onAction, onRetry }: SetupViewProps) {
  return (
    <div className="setup">
      <p className="setup-intro">
        Roger records two things on this Mac: your microphone, and the call audio your Mac plays.
        Each check below says what is missing and how to fix it.
      </p>
      <SetupBody state={state} onAction={onAction} onRetry={onRetry} />
      <p className="setup-privacy">
        Roger keeps each call’s audio on this Mac for a few days (7 unless audioRetentionDays says
        otherwise), so a part it missed can be transcribed again. It is never uploaded.
      </p>
    </div>
  );
}

function SetupBody({ state, onAction, onRetry }: SetupViewProps) {
  const { status, loadError } = state;
  const retry = (
    <button
      type="button"
      className="btn"
      data-variant="secondary"
      data-size="sm"
      disabled={state.running !== null}
      onClick={onRetry}
    >
      Try again
    </button>
  );
  if (status === null) {
    if (loadError === null) {
      return (
        <p className="setup-busy" role="status">
          Checking this Mac…
        </p>
      );
    }
    return (
      <div className="setup-failed">
        <p className="error" role="alert">
          Roger could not check this Mac: {loadError}
        </p>
        <div className="setup-actions">{retry}</div>
      </div>
    );
  }
  const rows = setupRows(status);
  return (
    <>
      {loadError === null ? null : (
        <div className="setup-failed">
          <p className="error" role="alert">
            Roger could not check again: {loadError}
          </p>
          <div className="setup-actions">{retry}</div>
        </div>
      )}
      <p className="setup-summary" role="status">
        {setupSummary(rows)}
      </p>
      <ul className="setup-list" aria-label="What Roger needs">
        {rows.map((view) => (
          <SetupRow key={view.id} view={view} state={state} onAction={onAction} />
        ))}
      </ul>
    </>
  );
}

interface SetupRowProps {
  view: SetupRowView;
  state: SetupScreenState;
  onAction: (row: SetupRowId, action: SetupAction) => void;
}

function SetupRow({ view, state, onAction }: SetupRowProps) {
  const titleId = useId();
  const running = state.running?.row === view.id ? state.running.action : null;
  const failure = state.failure?.row === view.id ? state.failure.message : null;
  // The first fix stands out only where something needs fixing; a test on a fine row does not.
  const leads = view.tone === 'problem' || view.tone === 'attention';
  return (
    <li
      className="setup-row"
      data-row={view.id}
      data-tone={view.tone}
      aria-labelledby={titleId}
      aria-busy={running !== null}
    >
      <div className="setup-row-head">
        <div className="setup-row-text">
          <h2 id={titleId} className="setup-row-title">
            {view.title}
          </h2>
          <p className="setup-row-description">{view.description}</p>
        </div>
        <span className="setup-state">
          <span className="visually-hidden">Status: </span>
          {view.stateLabel}
        </span>
      </div>
      {view.message === null ? null : <p className="setup-row-message">{view.message}</p>}
      {failure === null ? null : (
        <p className="error setup-row-error" role="alert">
          {failure}
        </p>
      )}
      {running === null ? null : (
        <p className="setup-busy" role="status">
          {RUNNING_TEXT[running]}
        </p>
      )}
      {view.actions.length === 0 ? null : (
        <div className="setup-actions">
          {view.actions.map((action, index) => (
            <button
              key={action.kind === 'open-pane' ? `${action.kind}-${action.pane}` : action.kind}
              type="button"
              className="btn"
              data-variant={leads && index === 0 ? 'primary' : 'secondary'}
              data-size="sm"
              data-action={action.kind}
              disabled={state.running !== null}
              onClick={() => {
                onAction(view.id, action);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
