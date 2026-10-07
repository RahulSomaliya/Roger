import type { NotesStreamMessage } from '../../../shared/ipc/notes';
import type {
  CitationAttrs,
  CitationSupport,
  DroppedLine,
  LocalNote,
  Note,
  PendingGenerateState,
  RefCitation,
} from '../../../shared/notes';

/**
 * A notes run as the AI notes panel shows it while it streams (M4 "Streaming"): main forwards the
 * API's events on `notes:event` (NotesStreamEvent, src/shared/notes.ts) and this folds them into
 * the template's sections, the closing "From your notes" list (M4 D7) and the lines the API
 * removed ("Removed lines", by the API's reason codes `no_refs` and `unknown_refs`). Pure: the
 * panel's session (aiNotesActions.ts) applies each event, each note change and each change of the
 * pending generate, and the panel draws the result.
 *
 * Rules, each from how main sends a run's events (main/notes/LlmStreams.ts, NotesGenerator.ts):
 * - A `run` event always starts over, even for the run on show: after a stale-version 409 main
 *   retries the same run id, and the page gets the conflict's `error` first, then the retry's `run`.
 * - One terminal event per run. After a cancel the page is told `cancelled` at once, and the run
 *   can still be found failed by main's poll and announced; the first end stays.
 * - Lines of a run the panel never saw start are not shown: opened mid-run, it missed the `run`
 *   and `section` events, and the lines would sit under no heading. Its end is still shown.
 * - A run can save its notes with no `done` reaching the page: after a lost stream (main polls the
 *   run, then loads its notes) and after a cancel the run beat (`cancel_unconfirmed`). The page
 *   then hears only the AI note changing (`afterNoteChanged`) and the generate ending
 *   (`afterPendingChanged`), and either must end the view, or a finished run stays "writing", or
 *   says "cancelled" over notes it saved.
 */

export interface StreamedItem {
  text: string;
  /** One chip per run of neighbouring transcript lines, as the saved doc groups them. */
  chips: CitationAttrs[];
  support: CitationSupport;
}

export interface StreamedSection {
  /** The template section's position, or a number after the template's for one the model added. */
  index: number;
  heading: string;
  items: StreamedItem[];
}

/**
 * `streaming`: lines are arriving. `done`: the run saved its notes, which the editor shows.
 * `failed` and `cancelled`: it ended without notes; the earlier AI notes stay as they were.
 */
export type StreamPhase = 'streaming' | 'done' | 'failed' | 'cancelled';

export interface RunError {
  code: string;
  message: string;
}

export interface AiNotesStreamView {
  runId: string;
  phase: StreamPhase;
  /** From the `run` event; null for a run whose start the panel did not see. */
  templateId: string | null;
  /** In the order the model wrote them, which is not always the template's. */
  sections: StreamedSection[];
  /** The closing list: lines only the user's notes back, in the user's order. */
  fromNotes: string[];
  dropped: DroppedLine[];
  /** Why the run ended, while `failed` or `cancelled`. */
  error: RunError | null;
  /** What the run saved (`done`): the panel shows it in the editor, not in this view. */
  saved: Note | null;
}

/**
 * The view after one event of the meeting's notes runs (the caller keeps other meetings' events
 * out). Returns `view` itself when the event changes nothing.
 */
export function applyNotesEvent(
  view: AiNotesStreamView | null,
  message: NotesStreamMessage,
): AiNotesStreamView | null {
  const { runId, event } = message;
  if (event.type === 'run') return { ...started(runId), templateId: event.templateId };
  const current = view?.runId === runId ? view : null;
  if (current === null) {
    // A run whose start this panel did not see: its end is news, its lines are not.
    if (event.type === 'error') return ended(started(runId), event);
    if (event.type === 'done') return finished(started(runId), event.note);
    return view;
  }
  if (current.phase !== 'streaming') return current;
  switch (event.type) {
    case 'section':
      if (current.sections.some((section) => section.index === event.index)) return current;
      return {
        ...current,
        sections: [...current.sections, { index: event.index, heading: event.heading, items: [] }],
      };
    case 'item': {
      const item: StreamedItem = {
        text: event.text,
        chips: chipsFor(event.citations, event.support),
        support: event.support,
      };
      const known = current.sections.some((section) => section.index === event.section);
      // A line for a section with no heading event yet still shows, under no heading.
      const sections = known
        ? current.sections
        : [...current.sections, { index: event.section, heading: '', items: [] }];
      return {
        ...current,
        sections: sections.map((section) =>
          section.index === event.section
            ? { ...section, items: [...section.items, item] }
            : section,
        ),
      };
    }
    case 'from_notes':
      return { ...current, fromNotes: [...current.fromNotes, event.text] };
    case 'dropped':
      return {
        ...current,
        dropped: [...current.dropped, { text: event.text, reason: event.reason }],
      };
    case 'done':
      return finished(current, event.note);
    case 'error':
      return ended(current, event);
  }
}

/**
 * The view after the AI note changed. A note the view's run wrote means that run saved its notes:
 * the view ends whatever it said, `cancelled` included (a cancel the run beat).
 */
export function afterNoteChanged(
  view: AiNotesStreamView | null,
  note: LocalNote,
): AiNotesStreamView | null {
  if (view === null || note.kind !== 'ai' || note.lastRunId !== view.runId) return view;
  return null;
}

/**
 * The view after the meeting's pending generate changed. A generate that is gone ends a streaming
 * view (no more events can come: main found the run's end by polling and loaded its notes) and a
 * done one; a failure or a cancel stays on show until the user dismisses it or generates again. A
 * generate of another run (Retry takes a new run id) ends any view: that run's `run` event starts
 * the next.
 *
 * Trap: the same run id is no proof the run still streams. After a lost stream main polls the run,
 * and when the poll cannot reach the API, or an attempt fails in main (`internal_error`, which
 * sends no `error` event), the same generate waits or fails with no event to the page. A view kept
 * `streaming` then hides the AI notes and holds them read-only (layoutAiNotes) for as long as the
 * Mac is offline. So a streaming view ends once its generate leaves `running`; the next attempt
 * re-sends the run id, and its `run` event starts the view again.
 */
export function afterPendingChanged(
  view: AiNotesStreamView | null,
  pending: PendingGenerateState | null,
): AiNotesStreamView | null {
  if (view === null) return null;
  if (pending === null) return view.phase === 'failed' || view.phase === 'cancelled' ? view : null;
  if (pending.runId !== view.runId) return null;
  return view.phase === 'streaming' && pending.status.phase !== 'running' ? null : view;
}

/**
 * What of the view the panel shows: `live` lines while they arrive, `partial` lines a failed run
 * wrote before it stopped (kept with its error banner, never saved), or none.
 */
export function shownStream(view: AiNotesStreamView | null): 'live' | 'partial' | null {
  if (view === null) return null;
  if (view.phase === 'streaming') return 'live';
  if (view.phase !== 'failed') return null;
  const wrote = view.fromNotes.length > 0 || view.sections.some((s) => s.items.length > 0);
  return wrote ? 'partial' : null;
}

/**
 * A streamed line's chips: its citations cut into runs of neighbouring lines (L12, L13, L15 is a
 * chip for 12 and 13, then one for 15), each labelled with its first line's time. Mirrors the API's
 * doc builder (`_neighbours` and `chip_label` in apps/api/src/roger_api/services/notes_generation.py)
 * so the lines look the same once the saved doc replaces them: change both together.
 */
export function chipsFor(
  citations: readonly RefCitation[],
  support: CitationSupport,
): CitationAttrs[] {
  const runs: RefCitation[][] = [];
  let previous: number | null = null;
  for (const citation of citations) {
    const number = lineNumber(citation.ref);
    const last = runs.at(-1);
    if (last !== undefined && number !== null && previous !== null && number === previous + 1) {
      last.push(citation);
    } else {
      runs.push([citation]);
    }
    previous = number;
  }
  return runs.flatMap((run) => {
    const [first] = run;
    if (first === undefined) return [];
    return [
      {
        segmentIds: run.map((citation) => citation.segmentId),
        startMs: first.startMs,
        label: chipLabel(first.startMs),
        support,
      },
    ];
  });
}

/** The time a chip shows: "03:12", or "1:02:05" past an hour (`CitationAttrs.label`). */
export function chipLabel(startMs: number): string {
  const total = Math.floor(startMs / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mmss = `${pad(minutes)}:${pad(seconds)}`;
  return hours > 0 ? `${String(hours)}:${mmss}` : mmss;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `L12` is 12; any other ref shape is no line number, so it never joins a run. */
function lineNumber(ref: string): number | null {
  const match = /^L(\d+)$/.exec(ref);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function started(runId: string): AiNotesStreamView {
  return {
    runId,
    phase: 'streaming',
    templateId: null,
    sections: [],
    fromNotes: [],
    dropped: [],
    error: null,
    saved: null,
  };
}

function ended(view: AiNotesStreamView, error: RunError): AiNotesStreamView {
  return {
    ...view,
    phase: error.code === 'cancelled' ? 'cancelled' : 'failed',
    error: { code: error.code, message: error.message },
  };
}

/** The saved doc takes the lines' place; the removed lines stay listed. */
function finished(view: AiNotesStreamView, note: Note): AiNotesStreamView {
  return { ...view, phase: 'done', sections: [], fromNotes: [], saved: note };
}
