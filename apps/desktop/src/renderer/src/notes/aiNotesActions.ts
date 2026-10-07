import { noteSaveBase, type NotesApi, type NotesStreamMessage } from '../../../shared/ipc/notes';
import type { Unsubscribe } from '../../../shared/ipc/unsubscribe';
import type {
  DroppedLine,
  LlmRun,
  LocalNote,
  PendingGenerateStatus,
  NoteDoc,
  NoteTemplate,
  PendingGenerateState,
} from '../../../shared/notes';
import { describeError } from '../app/describeError';
import {
  afterNoteChanged,
  afterPendingChanged,
  type AiNotesStreamView,
  applyNotesEvent,
  type RunError,
  shownStream,
} from './aiNotesStream';

/**
 * The AI notes panel's state and actions (M4-T18), apart from React so they test under Node: one
 * meeting's pending generate (notes.sqlite's `pending_generate`, through main's NotesGenerator),
 * its AI note as main holds it, the run streaming now (aiNotesStream.ts), the run that wrote the
 * notes on show (for "Removed lines" and "Restore previous notes") and the template list.
 *
 * What the panel offers (M4 "Generate after Stop", "AI notes and my notes"):
 * - The waiting states and the question "Which kind of call was this?" come from the pending
 *   generate main keeps, never from the page: a generate is a stored intent that outlives a
 *   reload, a quit and an offline API, and main says where it stands (`describePending`).
 * - Generate, Retry and the answer to the question all go through `generateNotes`. Main keeps the
 *   run id of a generate that has not failed (a new one would start a second paid run) and makes a
 *   new one for Retry after a stored failure (the API replays a finished run's result to its id).
 * - Regenerating AI notes edited since their run asks first (`editedSinceRun`), and so does
 *   restoring over them: the edits are in no run, so nothing would bring them back.
 * - "Restore previous notes" saves the doc the last run replaced (`replacedDoc` of
 *   `GET .../runs/{id}`) as a new local revision on the note on show; NotesSync uploads it as the
 *   next version. The open editor then loads it as a doc from elsewhere (useNoteDocument.ts), and
 *   typing it had not saved becomes the conflict copy rather than being lost.
 * - Stop does not wait: main's cancel resolves only once the API holds the run (up to its 130 s
 *   header wait), and the page hears the cancel as a `cancelled` event long before.
 */

export type AiNotesApi = Pick<
  NotesApi,
  | 'getNotes'
  | 'saveNote'
  | 'listNoteTemplates'
  | 'generateNotes'
  | 'cancelNotesGenerate'
  | 'getPendingGenerate'
  | 'getNotesRun'
  | 'onNoteChanged'
  | 'onNotesEvent'
  | 'onPendingGenerateChanged'
>;

export type Loadable<T> =
  { status: 'loading' } | { status: 'ready'; value: T } | { status: 'failed'; error: string };

/** The run that wrote the AI notes on show (`note.lastRunId`), as read from the API. */
export type LastRunRead =
  | { status: 'none' }
  | { status: 'loading'; runId: string }
  | { status: 'ready'; runId: string; run: LlmRun }
  | { status: 'failed'; runId: string; error: string };

/** An action waiting for the user's yes: it would replace AI notes edited since their run. */
export type Confirmation = { action: 'regenerate'; templateId: string } | { action: 'restore' };

/** Why the user opened the template picker: a first generate, or a regenerate. */
export type PickerPurpose = 'generate' | 'regenerate';

export interface AiNotesState {
  /** `loading` until main answers with the pending generate and the AI note; `failed` if not. */
  status: 'loading' | 'ready' | 'failed';
  loadError: string | null;
  pending: PendingGenerateState | null;
  /** The AI note as notes.sqlite holds it; null while there is none. */
  note: LocalNote | null;
  stream: AiNotesStreamView | null;
  lastRun: LastRunRead;
  /** In picker order (`orderTemplates`). */
  templates: Loadable<NoteTemplate[]>;
  confirm: Confirmation | null;
  /**
   * The template picker the user opened (Generate notes, Regenerate); null while it is closed.
   * Never open while a generate is pending or a run streams (`pickerMoot`).
   */
  picker: PickerPurpose | null;
  /** A generate or a restore on its way to main; the panel's buttons wait for it. */
  busy: 'generate' | 'restore' | null;
  /** Stop was pressed and main has not answered; only the Stop button waits for it. */
  cancelling: boolean;
  /** Why the last action failed, for the page. */
  actionError: string | null;
}

/**
 * What the pending generate says above the notes. `ask`: "Which kind of call was this?" with the
 * templates. A failed generate is a banner with Retry instead (`AiNotesLayout.failure`).
 */
export type PendingPrompt =
  { kind: 'ask' } | { kind: 'waiting'; text: string } | { kind: 'running'; text: string };

export interface FailureBanner {
  /**
   * `pending`: a failed generate main keeps for Retry (`llm_provider_error`, or main's own
   * `internal_error`); dismissing it cancels the generate. `stream`: a run that ended with an
   * error and left nothing pending; dismissing only hides the banner.
   */
  source: 'pending' | 'stream';
  title: string;
  detail: string | null;
  /** The template Retry generates with; null when there is nothing to retry. */
  retryTemplateId: string | null;
}

/** What the panel shows, worked out from the state alone (`layoutAiNotes`). */
export interface AiNotesLayout {
  prompt: PendingPrompt | null;
  failure: FailureBanner | null;
  /** A run's lines: arriving now (`live`), or written before it failed (`partial`, unsaved). */
  stream: 'live' | 'partial' | null;
  /** The AI notes editor: none before the first notes; hidden under a run's live lines. */
  editor: 'shown' | 'hidden' | null;
  /** While a run may write the AI notes, the API refuses an edit (a `409`): nobody types. */
  readOnly: boolean;
  /** No AI notes, nothing pending and nothing streaming: the empty state with Generate. */
  empty: boolean;
  canRegenerate: boolean;
  /** The doc "Restore previous notes" puts back, or null when there is none to offer. */
  restorable: NoteDoc | null;
  /** "Removed lines": the streaming run's, else the run that wrote the notes on show. */
  removed: DroppedLine[];
  /**
   * What the bar says the notes are: the template of the run streaming now, or of the run that
   * wrote the notes on show and its lines marked "check this". Null while neither describes what
   * is on show: notes edited since their run, or restored from an earlier one.
   */
  about: { templateId: string | null; flagged: number } | null;
  /** Why the run behind the notes on show could not be read (its removed lines are unknown). */
  runProblem: string | null;
  /** `stop` a running run, or `cancel` a waiting generate; null when there is nothing to stop. */
  stop: 'stop' | 'cancel' | null;
}

/**
 * Whether the AI notes hold edits no run wrote: typed and not uploaded yet (`dirty`), stored as a
 * later version than their run's (`generatedVersion`), a conflict copy of other typing, or notes
 * no run wrote at all. Regenerating or restoring over such notes asks first.
 */
export function editedSinceRun(note: LocalNote | null): boolean {
  if (note === null) return false;
  if (note.dirty || note.conflictCopy !== null) return true;
  if (note.lastRunId === null || note.generatedVersion === null) return true;
  return note.baseVersion > note.generatedVersion;
}

/** The pending generate's words (M4 "Generate after Stop"; main's PendingGenerateStatus). */
export function describePending(pending: PendingGenerateState | null): PendingPrompt | null {
  if (pending === null) return null;
  const { status } = pending;
  switch (status.phase) {
    case 'needs_template':
      return { kind: 'ask' };
    case 'waiting_for_lines': {
      const lines =
        status.waitingLines === 1 ? '1 line finishes' : `${status.waitingLines} lines finish`;
      return { kind: 'waiting', text: `Notes will generate when ${lines} uploading.` };
    }
    case 'waiting_for_notes':
      return { kind: 'waiting', text: waitingForNotes(status.cause) };
    case 'running':
      return { kind: 'running', text: 'Writing your notes...' };
    case 'failed':
      return null;
  }
}

type NotesWaitCause = Extract<PendingGenerateStatus, { phase: 'waiting_for_notes' }>['cause'];

function waitingForNotes(cause: NotesWaitCause): string {
  switch (cause) {
    // Not in Postgres yet, which also covers a call still recording: a Generate pressed during the
    // call waits for Stop, so the notes cover all of it (NotesGenerator.waitFor).
    case 'meeting':
      return 'Notes will generate once the call has ended and reached your workspace.';
    // The notes could not upload, or a generate request or the poll after a lost stream could not
    // reach the API (M4-T23).
    case 'offline':
      return 'Roger is offline; notes will generate when it is back.';
    case 'conflict':
      return 'Resolve the conflict in My notes first: notes generate once you pick a version.';
  }
}

/**
 * A run's error for people: what happened, by code (NotesStreamEvent's `error` codes, and the
 * API's refusals before a stream), and what main or the API said when it adds to that.
 */
export function describeRunError(error: RunError): { title: string; detail: string | null } {
  const title = RUN_ERROR_TITLES[error.code] ?? 'Roger could not generate the notes.';
  const said = error.message.trim();
  // A cancel is the user's own doing: whatever main says of it adds nothing.
  const adds = error.code !== 'cancelled' && said !== '' && !said.startsWith(title);
  const detail = adds ? said : null;
  return { title, detail };
}

const RUN_ERROR_TITLES: Readonly<Record<string, string>> = {
  llm_provider_error: 'The AI service could not write the notes.',
  cut_off: 'The notes ran too long and were cut off, so Roger kept the earlier AI notes.',
  cancelled: 'Notes generation was cancelled.',
  internal_error: 'Roger could not generate the notes.',
  empty_meeting: 'There is nothing to write notes from yet: no transcript lines and no notes.',
  network_error: 'Roger could not reach its server.',
  conflict: 'The notes changed while Roger was starting to write them.',
};

/**
 * The picker's order. The API lists templates by name, ignoring case (1:1, Client call, General,
 * Standup); General leads here, as the one that fits any call, and the rest keep the API's order.
 */
export function orderTemplates(templates: readonly NoteTemplate[]): NoteTemplate[] {
  const general = templates.filter((template) => template.id === 'general');
  return [...general, ...templates.filter((template) => template.id !== 'general')];
}

export function layoutAiNotes(state: AiNotesState): AiNotesLayout {
  const { pending, note, stream, lastRun } = state;
  const phase = pending?.status.phase ?? null;
  const shown = shownStream(stream);
  const live = shown === 'live';
  const runOfNote =
    lastRun.status === 'ready' && note !== null && lastRun.runId === note.lastRunId
      ? lastRun.run
      : null;
  const canRegenerate = note !== null && pending === null && !live && state.busy === null;
  const replaced = runOfNote?.replacedDoc ?? null;
  const restorable =
    canRegenerate && replaced !== null && !sameDoc(replaced, note.doc) ? replaced : null;
  // The run's template and "check this" count describe the doc it wrote, and stop doing so once
  // the user edits it or restores an earlier one. While a run starts, neither doc is settled.
  const about =
    stream !== null && live
      ? { templateId: stream.templateId, flagged: 0 }
      : note !== null && phase !== 'running' && !editedSinceRun(note)
        ? { templateId: note.templateId, flagged: runOfNote?.flaggedCount ?? 0 }
        : null;
  return {
    prompt: describePending(pending),
    failure: failureOf(pending, stream),
    stream: shown,
    editor: note === null ? null : live ? 'hidden' : 'shown',
    readOnly: phase === 'running' || live,
    empty: state.status === 'ready' && note === null && pending === null && !live,
    canRegenerate,
    restorable,
    removed: shown !== null && stream !== null ? stream.dropped : (runOfNote?.dropped ?? []),
    about,
    runProblem:
      lastRun.status === 'failed' && note?.lastRunId === lastRun.runId ? lastRun.error : null,
    stop:
      phase === 'running'
        ? 'stop'
        : phase === 'waiting_for_lines' || phase === 'waiting_for_notes'
          ? 'cancel'
          : null,
  };
}

function failureOf(
  pending: PendingGenerateState | null,
  stream: AiNotesStreamView | null,
): FailureBanner | null {
  if (pending?.status.phase === 'failed') {
    return {
      source: 'pending',
      ...describeRunError(pending.status),
      retryTemplateId: pending.templateId,
    };
  }
  if (stream !== null && stream.phase !== 'streaming' && stream.error !== null) {
    return { source: 'stream', ...describeRunError(stream.error), retryTemplateId: null };
  }
  return null;
}

/**
 * A generate is pending or a run streams, so the template picker the user opened is moot: a pick
 * would only start a second run.
 */
function pickerMoot(
  pending: PendingGenerateState | null,
  stream: AiNotesStreamView | null,
): boolean {
  return pending !== null || shownStream(stream) === 'live';
}

function sameDoc(a: NoteDoc, b: NoteDoc): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const INITIAL: AiNotesState = {
  status: 'loading',
  loadError: null,
  pending: null,
  note: null,
  stream: null,
  lastRun: { status: 'none' },
  templates: { status: 'loading' },
  confirm: null,
  picker: null,
  busy: null,
  cancelling: false,
  actionError: null,
};

/**
 * One meeting's AI notes panel over main's notes channels, for as long as the panel is mounted:
 * `start()` follows main and returns the stop. A snapshot store for useSyncExternalStore.
 */
export class AiNotesSession {
  private state: AiNotesState = INITIAL;
  private readonly listeners = new Set<() => void>();
  /** Bumped by every start and stop, so answers and events of an earlier start are dropped. */
  private run = 0;
  /** A change arrived since the first read began: it is newer than what the read will answer. */
  private pendingSeen = false;
  private noteSeen = false;
  private stopListening: Unsubscribe | null = null;

  constructor(
    private readonly api: AiNotesApi,
    readonly meetingId: string,
  ) {}

  readonly getState = (): AiNotesState => this.state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Follows main's changes, then reads what main holds; returns the function that stops both. */
  start(): Unsubscribe {
    this.stopListening?.();
    this.run += 1;
    const run = this.run;
    const live = (): boolean => run === this.run;
    const unsubscribes = [
      this.api.onPendingGenerateChanged((change) => {
        if (live() && change.meetingId === this.meetingId) this.pendingChanged(change.pending);
      }),
      this.api.onNotesEvent((message) => {
        if (live() && message.meetingId === this.meetingId) this.streamEvent(message);
      }),
      this.api.onNoteChanged((note) => {
        if (live() && note.meetingId === this.meetingId && note.kind === 'ai') {
          this.noteChanged(note);
        }
      }),
    ];
    this.stopListening = () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
    this.load(run);
    this.loadTemplates(run);
    return () => {
      if (!live()) return;
      this.run += 1;
      this.stopListening?.();
      this.stopListening = null;
    };
  }

  /** Try again after a failed first read. */
  reload(): void {
    this.set({ status: 'loading', loadError: null });
    this.load(this.run);
  }

  reloadTemplates(): void {
    this.loadTemplates(this.run);
  }

  /** Try again after the run behind the notes on show could not be read. */
  reloadRun(): void {
    const { lastRun } = this.state;
    if (lastRun.status === 'failed') this.readRun(lastRun.runId);
  }

  /** Opens the template picker; it stays closed while a generate is pending or a run streams. */
  openPicker(purpose: PickerPurpose): void {
    this.set({ picker: purpose });
  }

  closePicker(): void {
    this.set({ picker: null });
  }

  /**
   * The user's pick in the picker they opened: a first generate, or a regenerate (which asks
   * first over notes edited since their run). Resolves false when no picker was open.
   */
  async pick(templateId: string): Promise<boolean> {
    const { picker } = this.state;
    if (picker === null) return false;
    this.set({ picker: null });
    return picker === 'regenerate' ? this.regenerate(templateId) : this.generate(templateId);
  }

  /**
   * Generate, Retry, or the answer to "Which kind of call was this?". Resolves true once main took
   * it; false when main refused, with the reason in `actionError` (another template while the API
   * may hold the run, a run already streaming).
   */
  async generate(templateId: string): Promise<boolean> {
    this.set({ busy: 'generate', actionError: null, confirm: null });
    try {
      await this.api.generateNotes({ meetingId: this.meetingId, templateId });
      // The user moved on from an ended run: its banner and lines go. A new run's `run` event,
      // or main's pending change, says what happens next.
      const { stream } = this.state;
      if (stream !== null && stream.phase !== 'streaming') this.set({ stream: null });
      return true;
    } catch (error) {
      this.set({ actionError: `Roger could not start the notes: ${describeError(error)}` });
      return false;
    } finally {
      this.set({ busy: null });
    }
  }

  /** Regenerate with a template; asks first over notes edited since their run. */
  async regenerate(templateId: string): Promise<boolean> {
    if (editedSinceRun(this.state.note)) {
      this.set({ confirm: { action: 'regenerate', templateId }, actionError: null });
      return false;
    }
    return this.generate(templateId);
  }

  /** "Restore previous notes"; asks first over notes edited since their run. */
  async restorePrevious(): Promise<boolean> {
    if (layoutAiNotes(this.state).restorable === null) return false;
    if (editedSinceRun(this.state.note)) {
      this.set({ confirm: { action: 'restore' }, actionError: null });
      return false;
    }
    return this.restore();
  }

  /** The user said yes to the question `confirm` holds. */
  async confirmAction(): Promise<boolean> {
    const { confirm } = this.state;
    this.set({ confirm: null });
    if (confirm === null) return false;
    return confirm.action === 'regenerate' ? this.generate(confirm.templateId) : this.restore();
  }

  dismissConfirm(): void {
    this.set({ confirm: null });
  }

  /**
   * Stop the run, or drop a waiting or failed generate. Never awaited by the page: main answers
   * only once the API holds the run, and the page hears the stop sooner (`cancelled`, then the
   * generate's end). A failure shows in `actionError`.
   */
  cancel(): void {
    this.set({ cancelling: true, actionError: null });
    const run = this.run;
    this.api.cancelNotesGenerate(this.meetingId).then(
      () => {
        if (run === this.run) this.set({ cancelling: false });
      },
      (error: unknown) => {
        if (run !== this.run) return;
        this.set({
          cancelling: false,
          actionError: `Roger could not stop the notes: ${describeError(error)}`,
        });
      },
    );
  }

  /** Hides an ended run's banner and the lines it wrote before it stopped. */
  dismissFailure(): void {
    const { stream } = this.state;
    if (stream !== null && stream.phase !== 'streaming') this.set({ stream: null });
  }

  dismissError(): void {
    this.set({ actionError: null });
  }

  private async restore(): Promise<boolean> {
    const { note } = this.state;
    const doc = layoutAiNotes(this.state).restorable;
    if (note === null || doc === null) return false;
    this.set({ busy: 'restore', actionError: null });
    try {
      // Built on the note on show. When an editor's save landed first, main keeps this doc as
      // the conflict copy instead of writing over that save, and the banner lets the user pick.
      await this.api.saveNote({
        meetingId: this.meetingId,
        kind: 'ai',
        doc,
        base: noteSaveBase(note),
      });
      return true;
    } catch (error) {
      this.set({
        actionError: `Roger could not restore the previous notes: ${describeError(error)}`,
      });
      return false;
    } finally {
      this.set({ busy: null });
    }
  }

  private load(run: number): void {
    this.pendingSeen = false;
    this.noteSeen = false;
    Promise.all([
      this.api.getPendingGenerate(this.meetingId),
      this.api.getNotes(this.meetingId),
    ]).then(
      ([pending, notes]) => {
        if (run !== this.run) return;
        this.set({
          status: 'ready',
          loadError: null,
          pending: this.pendingSeen ? this.state.pending : pending,
          note: this.noteSeen ? this.state.note : notes.ai,
        });
        this.followRun();
      },
      (error: unknown) => {
        if (run !== this.run) return;
        this.set({ status: 'failed', loadError: describeError(error) });
      },
    );
  }

  private loadTemplates(run: number): void {
    this.set({ templates: { status: 'loading' } });
    this.api.listNoteTemplates().then(
      (templates) => {
        if (run === this.run) {
          this.set({ templates: { status: 'ready', value: orderTemplates(templates) } });
        }
      },
      (error: unknown) => {
        if (run === this.run) {
          this.set({ templates: { status: 'failed', error: describeError(error) } });
        }
      },
    );
  }

  private pendingChanged(pending: PendingGenerateState | null): void {
    this.pendingSeen = true;
    const stream = afterPendingChanged(this.state.stream, pending);
    // A run that started makes a question about replacing the notes moot.
    const confirm = pending?.status.phase === 'running' ? null : this.state.confirm;
    const cancelling = pending === null ? false : this.state.cancelling;
    this.set({ pending, stream, confirm, cancelling });
  }

  private noteChanged(note: LocalNote): void {
    this.noteSeen = true;
    this.set({ note, stream: afterNoteChanged(this.state.stream, note) });
    if (this.state.status === 'ready') this.followRun();
  }

  private streamEvent(message: NotesStreamMessage): void {
    const stream = applyNotesEvent(this.state.stream, message);
    if (stream !== this.state.stream) this.set({ stream });
  }

  /** Reads the run behind the notes on show whenever another run wrote them. */
  private followRun(): void {
    const runId = this.state.note?.lastRunId ?? null;
    const { lastRun } = this.state;
    if (runId === null) {
      if (lastRun.status !== 'none') this.set({ lastRun: { status: 'none' } });
      return;
    }
    if (lastRun.status !== 'none' && lastRun.runId === runId) return;
    this.readRun(runId);
  }

  private readRun(runId: string): void {
    const run = this.run;
    this.set({ lastRun: { status: 'loading', runId } });
    const current = (): boolean => {
      const { lastRun } = this.state;
      return run === this.run && lastRun.status === 'loading' && lastRun.runId === runId;
    };
    this.api.getNotesRun({ meetingId: this.meetingId, runId }).then(
      (answer) => {
        if (current()) this.set({ lastRun: { status: 'ready', runId, run: answer } });
      },
      (error: unknown) => {
        if (current())
          this.set({ lastRun: { status: 'failed', runId, error: describeError(error) } });
      },
    );
  }

  private set(change: Partial<AiNotesState>): void {
    const next = { ...this.state, ...change };
    // A generate that starts while the picker is open (Stop with auto-generate on, during the
    // call) closes it for good, here for every change. Trap: only hiding it while the generate is
    // pending brings it back, focused, once the run ends, and a stray Enter then starts a second
    // paid run over the notes just written, with no question asked.
    if (next.picker !== null && pickerMoot(next.pending, next.stream)) next.picker = null;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}
