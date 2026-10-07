import {
  Fragment,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type CitationAttrs,
  type DroppedLine,
  type DropReason,
  FROM_YOUR_NOTES_HEADING,
  NOT_SAID_ON_THE_CALL,
  type NoteTemplate,
} from '../../../shared/notes';
import { suggestTemplate } from '../../../shared/suggestTemplate';
import type { MeetingSlotProps } from '../app/slotRegistry';
import { MeetingViewContext } from '../meeting/useMeeting';
import { useCitationNavigator } from '../transcript/transcriptNavigator';
import {
  type AiNotesLayout,
  AiNotesSession,
  type AiNotesState,
  type Confirmation,
  type FailureBanner,
  layoutAiNotes,
  type Loadable,
} from './aiNotesActions';
import type { AiNotesStreamView } from './aiNotesStream';
import { CitationChipButton } from './CitationChip';
import { NoteEditor } from './NoteEditor';
import { TemplatePicker } from './TemplatePicker';
import './aiNotes.css';

/**
 * The "AI notes" tab of the meeting page (M4-T18; M4-T20 mounts it in the `meetingAiNotes` slot,
 * inside the page's CitationNavigatorProvider). It shows where the meeting's notes generate stands
 * (waiting for lines or notes, "Which kind of call was this?", writing, failed with Retry), a run's
 * lines as they stream, and then the AI notes in the editor (`<NoteEditor kind="ai" />`), with the
 * lines the API removed, Regenerate and "Restore previous notes". State and actions live in
 * aiNotesActions.ts, the stream in aiNotesStream.ts; this file only draws them.
 *
 * The editor stays mounted, hidden, under a run's live lines, and read-only while a run may write
 * the AI notes (the API refuses an AI-doc `PUT` during a run). A doc that arrives meanwhile (the
 * run's `done`) loads through `setContent` (useNoteDocument.ts), as an editor that holds no
 * unsaved typing takes any doc from elsewhere.
 */

const LABEL = 'AI notes';

export function AiNotesPanel({ meetingId }: MeetingSlotProps) {
  const session = useMemo(() => new AiNotesSession(window.roger, meetingId), [meetingId]);
  const state = useSyncExternalStore(session.subscribe, session.getState);
  useEffect(() => session.start(), [session]);
  // The page cannot read notes.sqlite's remembered picks (main uses them at Stop), so the title is
  // the only cue here. Outside a meeting page (a QA harness) there is none, and nothing is marked.
  const title = useContext(MeetingViewContext)?.meeting?.title ?? '';
  const suggested = suggestTemplate({ title, lastPick: () => null }).templateId;
  return (
    <AiNotesView meetingId={meetingId} state={state} actions={session} suggested={suggested} />
  );
}

/** What the view calls; AiNotesSession is one, a test passes stand-ins. */
export type AiNotesPanelActions = Pick<
  AiNotesSession,
  | 'openPicker'
  | 'closePicker'
  | 'pick'
  | 'generate'
  | 'regenerate'
  | 'restorePrevious'
  | 'confirmAction'
  | 'dismissConfirm'
  | 'cancel'
  | 'dismissFailure'
  | 'dismissError'
  | 'reload'
  | 'reloadTemplates'
  | 'reloadRun'
>;

export interface AiNotesViewProps {
  meetingId: string;
  state: AiNotesState;
  actions: AiNotesPanelActions;
  /** The template the meeting's title suggests (shared/suggestTemplate.ts), or null. */
  suggested: string | null;
}

export function AiNotesView({ meetingId, state, actions, suggested }: AiNotesViewProps) {
  if (state.status === 'loading') {
    return (
      <div className="ai-notes" aria-busy="true">
        <p className="ai-notes-message" role="status">
          Opening the AI notes...
        </p>
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <div className="ai-notes">
        <div className="error ai-notes-error" role="alert">
          <span>Roger could not open the AI notes: {state.loadError}</span>
          <div className="ai-notes-actions">
            <button
              type="button"
              className="btn"
              data-variant="secondary"
              data-size="sm"
              onClick={() => {
                actions.reload();
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  const layout = layoutAiNotes(state);
  const busy = state.busy !== null;
  // The session closes the picker for good once a generate starts (AiNotesSession `set`).
  const { picker } = state;

  return (
    <div className="ai-notes">
      {state.note !== null || layout.stop !== null ? (
        <AiNotesBar
          state={state}
          layout={layout}
          actions={actions}
          onRegenerate={() => {
            actions.openPicker('regenerate');
          }}
        />
      ) : null}
      {state.actionError === null ? null : (
        <div className="error ai-notes-error" role="alert">
          <span>{state.actionError}</span>
          <div className="ai-notes-actions">
            <button
              type="button"
              className="btn"
              data-variant="secondary"
              data-size="sm"
              onClick={() => {
                actions.dismissError();
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {state.confirm === null ? null : (
        <ConfirmReplace
          confirm={state.confirm}
          templates={state.templates}
          busy={busy}
          actions={actions}
        />
      )}
      {layout.failure === null ? null : (
        <RunFailure
          failure={layout.failure}
          cancelled={layout.failure.source === 'stream' && state.stream?.phase === 'cancelled'}
          busy={busy}
          actions={actions}
        />
      )}
      {layout.prompt?.kind === 'ask' ? (
        <AskWhichCall state={state} busy={busy} actions={actions} />
      ) : null}
      {picker === null ? null : (
        <TemplatePicker
          question={
            picker === 'regenerate'
              ? 'Regenerate as which kind of call?'
              : 'Which kind of call was this?'
          }
          hint={
            picker === 'regenerate'
              ? 'Roger keeps the notes it replaces: Restore previous notes brings them back.'
              : 'Roger writes the AI notes in the shape of the call.'
          }
          templates={state.templates}
          suggested={suggested}
          current={state.note?.templateId ?? null}
          takeFocus
          disabled={busy}
          onPick={(templateId) => {
            void actions.pick(templateId);
          }}
          onReload={() => {
            actions.reloadTemplates();
          }}
          dismiss={{
            label: 'Cancel',
            onDismiss: () => {
              actions.closePicker();
            },
          }}
        />
      )}
      {layout.stream !== null && state.stream !== null ? (
        <StreamedNotes view={state.stream} live={layout.stream === 'live'} />
      ) : null}
      {layout.editor === null ? null : (
        <div className="ai-notes-editor" hidden={layout.editor === 'hidden'}>
          <NoteEditor meetingId={meetingId} kind="ai" label={LABEL} readOnly={layout.readOnly} />
        </div>
      )}
      {layout.empty && picker === null ? (
        <div className="empty-state ai-notes-empty">
          <div>
            <p className="empty-state-title">No AI notes yet</p>
            <p className="empty-state-text">
              After the call, Roger turns your notes and the transcript into clean notes, every line
              linked to what was said.
            </p>
          </div>
          <button
            type="button"
            className="btn"
            data-variant="primary"
            data-size="sm"
            disabled={busy}
            onClick={() => {
              actions.openPicker('generate');
            }}
          >
            Generate notes
          </button>
        </div>
      ) : null}
      {layout.removed.length === 0 ? null : <RemovedLines lines={layout.removed} />}
      {layout.runProblem === null ? null : (
        <p className="ai-notes-run-problem">
          Roger could not read the run that wrote these notes ({layout.runProblem}), so it cannot
          list the lines it removed.
          <button
            type="button"
            className="btn"
            data-variant="secondary"
            data-size="sm"
            onClick={() => {
              actions.reloadRun();
            }}
          >
            Try again
          </button>
        </p>
      )}
    </div>
  );
}

interface AiNotesBarProps {
  state: AiNotesState;
  layout: AiNotesLayout;
  actions: AiNotesPanelActions;
  onRegenerate: () => void;
}

/**
 * Above the notes: where a pending generate stands (beside its Stop or Cancel), the notes'
 * template and lines to check, and Regenerate and Restore.
 */
function AiNotesBar({ state, layout, actions, onRegenerate }: AiNotesBarProps) {
  const busy = state.busy !== null;
  const { about, prompt } = layout;
  const name = about === null ? null : templateName(state.templates, about.templateId);
  const meta = [
    name === null ? null : `${name} template`,
    about === null || about.flagged === 0
      ? null
      : `${about.flagged} ${plural(about.flagged, 'line')} to check`,
  ].filter((part) => part !== null);
  return (
    <div className="ai-notes-bar">
      <div className="ai-notes-bar-text">
        {prompt === null || prompt.kind === 'ask' ? null : (
          <p
            className={
              prompt.kind === 'running'
                ? 'ai-notes-progress ai-notes-progress-running'
                : 'ai-notes-progress'
            }
            role="status"
          >
            {prompt.text}
          </p>
        )}
        {meta.length === 0 ? null : <p className="ai-notes-meta">{meta.join(', ')}</p>}
      </div>
      <div className="ai-notes-actions">
        {layout.canRegenerate ? (
          <button
            type="button"
            className="btn"
            data-variant="secondary"
            data-size="sm"
            disabled={busy}
            onClick={onRegenerate}
          >
            Regenerate
          </button>
        ) : null}
        {layout.restorable === null ? null : (
          <button
            type="button"
            className="btn"
            data-variant="secondary"
            data-size="sm"
            disabled={busy}
            onClick={() => {
              void actions.restorePrevious();
            }}
          >
            Restore previous notes
          </button>
        )}
        {layout.stop === null ? null : (
          // Never waits for main: its cancel answers once the API holds the run (up to 130 s).
          <button
            type="button"
            className="btn"
            data-variant="secondary"
            data-size="sm"
            disabled={state.cancelling}
            onClick={() => {
              actions.cancel();
            }}
          >
            {state.cancelling ? 'Stopping...' : layout.stop === 'stop' ? 'Stop' : 'Cancel'}
          </button>
        )}
      </div>
    </div>
  );
}

interface AskWhichCallProps {
  state: AiNotesState;
  busy: boolean;
  actions: AiNotesPanelActions;
}

/**
 * "Which kind of call was this?": the pending generate needs a template. Roger could not tell at
 * Stop (main applied the same rule, with the remembered picks the page cannot read), so nothing is
 * marked as suggested here. The answer keeps the generate's run id (main's `generate`).
 */
function AskWhichCall({ state, busy, actions }: AskWhichCallProps) {
  return (
    <TemplatePicker
      question="Which kind of call was this?"
      hint="Roger writes the AI notes in the shape of the call, and remembers your pick for meetings with the same title."
      templates={state.templates}
      suggested={null}
      disabled={busy}
      onPick={(templateId) => {
        void actions.generate(templateId);
      }}
      onReload={() => {
        actions.reloadTemplates();
      }}
      dismiss={{
        label: 'Not now',
        onDismiss: () => {
          actions.cancel();
        },
      }}
    />
  );
}

interface RunFailureProps {
  failure: FailureBanner;
  /** A cancel is the user's own doing: a notice, not an error. */
  cancelled: boolean;
  busy: boolean;
  actions: AiNotesPanelActions;
}

function RunFailure({ failure, cancelled, busy, actions }: RunFailureProps) {
  const { retryTemplateId } = failure;
  return (
    <div
      className={cancelled ? 'notice ai-notes-failure' : 'error ai-notes-failure'}
      role={cancelled ? 'status' : 'alert'}
    >
      <p className="ai-notes-failure-title">{failure.title}</p>
      {failure.detail === null ? null : <p className="ai-notes-failure-detail">{failure.detail}</p>}
      <div className="ai-notes-actions">
        {retryTemplateId === null ? null : (
          <button
            type="button"
            className="btn"
            data-variant="primary"
            data-size="sm"
            disabled={busy}
            onClick={() => {
              void actions.generate(retryTemplateId);
            }}
          >
            Retry
          </button>
        )}
        <button
          type="button"
          className="btn"
          data-variant="secondary"
          data-size="sm"
          onClick={() => {
            // A failed generate main keeps is cancelled: a stored failure would wait for Retry
            // until then, and main's own `internal_error` retries by itself, so that button says
            // Cancel (`retriesItself`). An ended run's banner is only the page's.
            if (failure.source === 'pending') actions.cancel();
            else actions.dismissFailure();
          }}
        >
          {failure.retriesItself ? 'Cancel' : 'Dismiss'}
        </button>
      </div>
    </div>
  );
}

interface ConfirmReplaceProps {
  confirm: Confirmation;
  templates: Loadable<NoteTemplate[]>;
  busy: boolean;
  actions: AiNotesPanelActions;
}

/** The question before AI notes edited since their run are replaced (M4, "AI notes and my notes"). */
function ConfirmReplace({ confirm, templates, busy, actions }: ConfirmReplaceProps) {
  const titleId = useId();
  const regenerate = confirm.action === 'regenerate';
  const name = regenerate ? templateName(templates, confirm.templateId) : null;
  return (
    <div className="ai-notes-confirm" role="group" aria-labelledby={titleId}>
      <p id={titleId} className="ai-notes-confirm-title">
        {regenerate
          ? 'Replace your edited AI notes?'
          : 'Replace your edited AI notes with the previous version?'}
      </p>
      <p className="ai-notes-confirm-text">
        {regenerate
          ? 'You changed these notes since Roger wrote them. Regenerating writes them again from the call; Restore previous notes brings this version back.'
          : 'You changed these notes since Roger wrote them, and no run holds your edits, so Roger cannot bring them back afterwards.'}
      </p>
      <div className="ai-notes-actions">
        <button
          type="button"
          className="btn"
          data-variant="primary"
          data-size="sm"
          disabled={busy}
          onClick={() => {
            void actions.confirmAction();
          }}
        >
          {regenerate
            ? name === null
              ? 'Regenerate'
              : `Regenerate as ${name}`
            : 'Restore previous notes'}
        </button>
        <button
          type="button"
          className="btn"
          data-variant="secondary"
          data-size="sm"
          onClick={() => {
            actions.dismissConfirm();
          }}
        >
          Keep my edits
        </button>
      </div>
    </div>
  );
}

/**
 * A run's lines, drawn with the editor's own styles (`.note-editor-content`) in the shape of the
 * doc the API saves (notes_generation.py): a heading per section, a bullet list of lines, each
 * line's chips after its text, and the closing "From your notes" list.
 *
 * Trap: this div carries the editor's class, and comes before the editor in the panel, so a
 * selector of `.note-editor-content` alone finds the streamed lines first (browser QA read
 * `contenteditable` from it and got null). Reach the editor as `.ai-notes-editor
 * .note-editor-content` (e2e/m4-t18.qa.e2e.ts, `EDITOR`).
 */
function StreamedNotes({ view, live }: { view: AiNotesStreamView; live: boolean }) {
  const empty = view.sections.length === 0 && view.fromNotes.length === 0;
  return (
    <div
      className={
        live ? 'ai-notes-stream ai-notes-stream-live' : 'ai-notes-stream ai-notes-stream-partial'
      }
      aria-busy={live ? true : undefined}
    >
      {live ? null : (
        <p className="ai-notes-stream-caption">Written before the run stopped. Not saved.</p>
      )}
      <div className="note-editor-content ai-notes-stream-doc">
        {empty ? (
          <p className="ai-notes-stream-waiting">Reading the transcript and your notes...</p>
        ) : null}
        {view.sections.map((section) => (
          <Fragment key={section.index}>
            {section.heading === '' ? null : <h2>{section.heading}</h2>}
            {section.items.length === 0 ? null : (
              <ul>
                {section.items.map((item, at) => (
                  <li key={at}>
                    <p>
                      {item.text}{' '}
                      {item.chips.map((chip, chipAt) => (
                        <StreamedChip key={chipAt} attrs={chip} />
                      ))}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Fragment>
        ))}
        {view.fromNotes.length === 0 ? null : (
          <>
            <h2>{FROM_YOUR_NOTES_HEADING}</h2>
            <p>
              <em>{NOT_SAID_ON_THE_CALL}</em>
            </p>
            <ul>
              {view.fromNotes.map((text, at) => (
                <li key={at}>
                  <p>{text}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/** A streamed line's chip: the editor's chip (CitationChip.tsx), outside an editor. */
function StreamedChip({ attrs }: { attrs: CitationAttrs }) {
  const navigator = useCitationNavigator();
  const [removed, setRemoved] = useState(false);
  return (
    <span className="citation-chip-node">
      <CitationChipButton
        attrs={attrs}
        removed={removed}
        onReveal={() => {
          setRemoved(navigator.reveal(attrs.segmentIds) === 'not_loaded');
        }}
      />
    </span>
  );
}

/** Why the API left a line out, by its reason code (services/citations.py). */
const DROP_REASONS: Readonly<Record<DropReason, string>> = {
  no_refs: 'cited no transcript line',
  unknown_refs: 'cited lines that are not in the transcript',
};

/** "Removed lines" (M4 D4): the AI lines no transcript line backs, kept out of the notes. */
function RemovedLines({ lines }: { lines: readonly DroppedLine[] }) {
  return (
    <details className="ai-notes-removed">
      <summary>Removed lines ({lines.length})</summary>
      <p className="ai-notes-removed-intro">
        Every AI line links to the transcript lines behind it. These had none, so Roger left them
        out.
      </p>
      <ul className="ai-notes-removed-list">
        {lines.map((line, at) => (
          <li key={at}>
            <span className="ai-notes-removed-text">{line.text}</span>{' '}
            <span className="ai-notes-removed-reason">({DROP_REASONS[line.reason]})</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function templateName(templates: Loadable<NoteTemplate[]>, id: string | null): string | null {
  if (id === null || templates.status !== 'ready') return null;
  return templates.value.find((template) => template.id === id)?.name ?? null;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
