import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { SetupModel, type SetupScreenState } from './setupModel';
import { Icon } from '../ui/icons';
import {
  leadingFix,
  needsYou,
  passingLine,
  type SetupAction,
  type SetupActionKind,
  type SetupRowId,
  type SetupRowView,
  setupRows,
  splitRows,
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

interface SetupScreenProps {
  /** Done: leaves setup once every check passes. The header's Home leaves at any time. */
  onDone: () => void;
}

/**
 * The permission setup screen (M2-T19), in the shell's full-window `setup` route
 * (app/slots/m2-setup.ts): what Roger needs on this Mac, what is wrong in main's words, and the
 * buttons that fix it. Checks that pass fold into one line. It reads the status again whenever
 * the window regains focus, so a switch flipped in System Settings shows the moment the person
 * comes back.
 */
export function SetupScreen({ onDone }: SetupScreenProps) {
  // One model per mount: leaving setup and coming back reads the Mac afresh.
  const [model] = useState(() => new SetupModel(window.roger));
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [showPassing, setShowPassing] = useState(false);
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
      showPassing={showPassing}
      onTogglePassing={() => {
        setShowPassing((shown) => !shown);
      }}
      onAction={(row, action) => {
        void model.run(row, action);
      }}
      onRetry={() => {
        void model.load();
      }}
      onDone={onDone}
    />
  );
}

interface SetupViewProps {
  state: SetupScreenState;
  /** Whether the checks that pass are listed, not just counted. */
  showPassing: boolean;
  onTogglePassing: () => void;
  onAction: (row: SetupRowId, action: SetupAction) => void;
  onRetry: () => void;
  onDone: () => void;
}

/** The screen for one state. */
export function SetupView(props: SetupViewProps) {
  return (
    <div className="setup">
      <p className="setup-intro">
        Roger records your microphone and the call audio your Mac plays.
      </p>
      <SetupBody {...props} />
      <p className="setup-privacy">
        Call audio stays on this Mac for a few days, never uploaded, so a part Roger missed can be
        transcribed again.
      </p>
    </div>
  );
}

/** A failed read or action: a problem line (no box, no red) and, for a read, its one fix. */
function Failure({
  message,
  onRetry,
  busy,
}: {
  message: string;
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <div className="setup-failed">
      <div className="problem" role="alert">
        <Icon name="circle-alert" />
        <span className="problem-text">{message}</span>
      </div>
      <div className="setup-actions">
        <button
          type="button"
          className="btn"
          data-variant="secondary"
          data-size="sm"
          disabled={busy}
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    </div>
  );
}

function SetupBody({
  state,
  showPassing,
  onTogglePassing,
  onAction,
  onRetry,
  onDone,
}: SetupViewProps) {
  const { status, loadError } = state;
  if (status === null) {
    if (loadError === null) {
      return (
        <p className="setup-busy" role="status">
          Checking this Mac…
        </p>
      );
    }
    return (
      <Failure
        message={`Roger could not check this Mac: ${loadError}`}
        onRetry={onRetry}
        busy={state.running !== null}
      />
    );
  }
  const rows = setupRows(status);
  const { open, passing, untested } = splitRows(rows);
  const folded = [...passing, ...untested];
  const lead = leadingFix(rows);
  const list = (views: readonly SetupRowView[], label: string) =>
    views.length === 0 ? null : (
      <ul className="setup-list" aria-label={label}>
        {views.map((view) => (
          <SetupRow
            key={view.id}
            view={view}
            state={state}
            leads={view.id === lead}
            onAction={onAction}
          />
        ))}
      </ul>
    );
  return (
    <>
      {loadError === null ? null : (
        <Failure
          message={`Roger could not check again: ${loadError}`}
          onRetry={onRetry}
          busy={state.running !== null}
        />
      )}
      {list(open, 'What Roger needs')}
      {folded.length === 0 ? null : (
        <div className="setup-passing">
          <span>{passingLine(passing.length, untested.length)}</span>
          <span aria-hidden="true">&middot;</span>
          <button
            type="button"
            className="btn"
            data-variant="ghost"
            data-size="sm"
            aria-expanded={showPassing}
            onClick={onTogglePassing}
          >
            {showPassing ? 'Hide' : 'Show'}
          </button>
        </div>
      )}
      {showPassing ? list(folded, 'Checks that pass') : null}
      {/* The header's "Home" is the way out at any time (D6), so there is no Later. Done is the
          foot's only button and shows once nothing needs you; it is the one main button then. */}
      {needsYou(rows) ? null : (
        <div className="setup-actions">
          <button
            type="button"
            className="btn"
            data-variant="primary"
            data-size="md"
            onClick={onDone}
          >
            Done
          </button>
        </div>
      )}
    </>
  );
}

interface SetupRowProps {
  view: SetupRowView;
  state: SetupScreenState;
  /** This row's first fix is the screen's one main button (leadingFix). */
  leads: boolean;
  onAction: (row: SetupRowId, action: SetupAction) => void;
}

/** The icon beside a state's words: a check for a pass, an exclamation for what needs a look. */
function StateMark({ tone }: { tone: SetupRowView['tone'] }) {
  if (tone === 'ok') return <Icon name="check" />;
  if (tone === 'problem' || tone === 'attention') return <Icon name="circle-alert" />;
  return null;
}

function SetupRow({ view, state, leads, onAction }: SetupRowProps) {
  const titleId = useId();
  const running = state.running?.row === view.id ? state.running.action : null;
  const failure = state.failure?.row === view.id ? state.failure.message : null;
  return (
    <li
      className="setup-row"
      data-row={view.id}
      data-tone={view.tone}
      aria-labelledby={titleId}
      aria-busy={running !== null}
    >
      <div className="setup-row-head">
        <h2 id={titleId} className="setup-row-title">
          {view.title}
        </h2>
        <span className="setup-state">
          <StateMark tone={view.tone} />
          <span className="visually-hidden">Status: </span>
          {view.stateLabel}
        </span>
      </div>
      {view.message === null ? null : <p className="setup-row-message">{view.message}</p>}
      {failure === null ? null : (
        <div className="problem" role="alert">
          <Icon name="circle-alert" />
          <span className="problem-text">{failure}</span>
        </div>
      )}
      {running === null ? null : (
        <p className="setup-busy" role="status">
          {RUNNING_TEXT[running]}
        </p>
      )}
      {view.actions.length === 0 ? null : (
        <div className="setup-actions">
          {view.actions.map((action, index) => {
            // Busy is not disabled (docs/design.md): the button that runs keeps its colour and
            // takes no clicks; the rest wait, and the status line above says for what.
            const busy = running === action.kind;
            return (
              <button
                key={action.kind === 'open-pane' ? `${action.kind}-${action.pane}` : action.kind}
                type="button"
                className="btn"
                data-variant={leads && index === 0 ? 'primary' : 'secondary'}
                data-size="sm"
                data-action={action.kind}
                disabled={state.running !== null && !busy}
                aria-disabled={busy ? true : undefined}
                onClick={() => {
                  onAction(view.id, action);
                }}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}
