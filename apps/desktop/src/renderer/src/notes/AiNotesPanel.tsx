import { Fragment, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  type CitationAttrs,
  type DroppedLine,
  type DropReason,
  FROM_YOUR_NOTES_HEADING,
  NOT_SAID_ON_THE_CALL,
} from '../../../shared/notes';
import type { MeetingSlotProps } from '../app/slotRegistry';
import { Icon } from '../components/ui/icons';
import { rogerNotes } from '../meeting/useMeeting';
import { useCitationNavigator } from '../transcript/transcriptNavigator';
import {
  type FailureBanner,
  AiNotesSession,
  type AiNotesState,
  layoutAiNotes,
} from './aiNotesActions';
import type { AiNotesStreamView } from './aiNotesStream';
import { CitationChipButton } from './CitationChip';
import { NoteEditor } from './NoteEditor';
import './aiNotes.css';

/**
 * The "AI notes" tab of the meeting page (M4-T18; M4-T20 mounts it in the `meetingAiNotes` slot,
 * inside the page's CitationNavigatorProvider). It exists once notes exist, a generate is pending
 * or a run failed (`aiNotesTabExists`, meeting/headerAction.ts), so it has no empty state and no
 * action of its own to start one: the meeting header owns Write notes, Cancel, the ⋯ menu (Write
 * again as, Restore previous notes) and the question before AI notes the person edited are
 * replaced, from the page's own AiNotesSession. This panel follows main with a session of its own
 * and draws what the header does not: why a generate waits, a run's lines as they stream, a failed
 * run with Try again, then the AI notes in the editor (`<NoteEditor kind="ai" />`) and the lines
 * the API left out. State and actions live in aiNotesActions.ts, the stream in aiNotesStream.ts.
 *
 * Trap: this session never starts a generate except Try again, so the only `actionError` it can
 * hold is that one's (or a Cancel's). It shows here as a problem line: the header's session does
 * not see this one, so dropping it would hide a failed Try again (house rule 1, no silent
 * failure).
 *
 * The editor stays mounted, hidden, under a run's live lines, and read-only while a run may write
 * the AI notes (the API refuses an AI-doc `PUT` during a run). A doc that arrives meanwhile (the
 * run's `done`) loads through `setContent` (useNoteDocument.ts), as an editor that holds no
 * unsaved typing takes any doc from elsewhere.
 */

const LABEL = 'AI notes';

export function AiNotesPanel({ meetingId }: MeetingSlotProps) {
  // `rogerNotes` looks `window.roger` up at each call: this render also runs under Node.
  const session = useMemo(() => new AiNotesSession(rogerNotes, meetingId), [meetingId]);
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  useEffect(() => session.start(), [session]);
  return <AiNotesView meetingId={meetingId} state={state} actions={session} />;
}

/** What the view calls; AiNotesSession is one, a test passes stand-ins. */
export type AiNotesPanelActions = Pick<
  AiNotesSession,
  'generate' | 'cancel' | 'dismissFailure' | 'dismissError' | 'reload' | 'reloadRun'
>;

export interface AiNotesViewProps {
  meetingId: string;
  state: AiNotesState;
  actions: AiNotesPanelActions;
}

export function AiNotesView({ meetingId, state, actions }: AiNotesViewProps) {
  if (state.status === 'loading') {
    // Nothing to say: main answers within a frame or two (docs/design.md, Loading).
    return <div className="ai-notes" aria-busy="true" />;
  }
  if (state.status === 'failed') {
    return (
      <div className="ai-notes">
        <div className="problem" role="alert">
          <Icon name="circle-alert" />
          <span className="problem-text">Roger could not open the AI notes: {state.loadError}</span>
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
    );
  }

  const layout = layoutAiNotes(state);
  const busy = state.busy !== null;

  return (
    <div className="ai-notes">
      {state.actionError === null ? null : (
        <div className="problem" role="alert">
          <Icon name="circle-alert" />
          <span className="problem-text">{state.actionError}</span>
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
      )}
      {layout.failure === null ? null : (
        <RunFailure
          failure={layout.failure}
          cancelled={layout.failure.source === 'stream' && state.stream?.phase === 'cancelled'}
          busy={busy}
          actions={actions}
        />
      )}
      {layout.waiting === null ? null : (
        <p className="ai-notes-waiting" role="status">
          {layout.waiting}
        </p>
      )}
      {layout.stream !== null && state.stream !== null ? (
        <StreamedNotes view={state.stream} live={layout.stream === 'live'} />
      ) : null}
      {layout.editor === null ? null : (
        <div className="ai-notes-editor" hidden={layout.editor === 'hidden'}>
          <NoteEditor meetingId={meetingId} kind="ai" label={LABEL} readOnly={layout.readOnly} />
        </div>
      )}
      {layout.removed.length === 0 ? null : <RemovedLines lines={layout.removed} />}
      {layout.runProblem === null ? null : (
        <div className="problem" role="status">
          <Icon name="circle-alert" />
          <span className="problem-text">
            Roger could not read the run that wrote these notes ({layout.runProblem}), so it cannot
            list the lines it left out.
          </span>
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
        </div>
      )}
    </div>
  );
}

interface RunFailureProps {
  failure: FailureBanner;
  /** A cancel is the user's own doing: a quiet line, not a problem. */
  cancelled: boolean;
  busy: boolean;
  actions: AiNotesPanelActions;
}

/**
 * A run that failed or was cancelled, as a problem line (an icon, the sentence, Try again as the
 * one secondary action) with its way out beside it. Try again is not the page's primary: when the
 * notes failed the header offers Write notes only if no generate is pending, and the page has one
 * primary at most.
 */
function RunFailure({ failure, cancelled, busy, actions }: RunFailureProps) {
  const { retryTemplateId } = failure;
  return (
    <div className="problem ai-notes-failure" role={cancelled ? 'status' : 'alert'}>
      {cancelled ? null : <Icon name="circle-alert" />}
      <div className="problem-text">
        <p className="ai-notes-failure-title">{failure.title}</p>
        {failure.detail === null ? null : (
          <p className="ai-notes-failure-detail">{failure.detail}</p>
        )}
        <div className="ai-notes-actions">
          {retryTemplateId === null ? null : (
            // Busy is not disabled: full colour, aria-disabled, and it says what it is doing.
            <button
              type="button"
              className="btn"
              data-variant="secondary"
              data-size="sm"
              aria-disabled={busy ? 'true' : undefined}
              onClick={() => {
                if (!busy) void actions.generate(retryTemplateId);
              }}
            >
              {busy ? 'Trying again…' : 'Try again'}
            </button>
          )}
          <button
            type="button"
            className="btn"
            data-variant="ghost"
            data-size="sm"
            onClick={() => {
              // A failed generate main keeps is cancelled: a stored failure would wait for Try again
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
 * .note-editor-content`.
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
          <p className="ai-notes-stream-waiting">Reading the transcript and your notes…</p>
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

/**
 * The AI lines no transcript line backs, kept out of the notes (M4 D4), closed. Every AI line
 * links to the transcript lines behind it; the reason for each is in the list, so there is no
 * intro paragraph.
 */
function RemovedLines({ lines }: { lines: readonly DroppedLine[] }) {
  return (
    <details className="ai-notes-removed">
      <summary>
        {lines.length} {lines.length === 1 ? 'line' : 'lines'} left out
      </summary>
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
