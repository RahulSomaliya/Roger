import type {
  LlmRun,
  LocalNote,
  MeetingNotes,
  NoteDoc,
  NoteKind,
  NotesStreamEvent,
  NoteTemplate,
  PendingGenerateState,
} from '../notes';
import type { Unsubscribe } from './unsubscribe';

/**
 * Notes' channels: the user's and the AI notes of a meeting, their generation and the quit flush.
 * Main registers them in src/main/notes/notes-ipc.ts (M4-T16), which validates every payload
 * before use (notes-ipc-validation.ts, with the guards in src/shared/notes.ts).
 */
export const notesChannels = {
  /** renderer → main, invoke */
  NotesGet: 'notes:get',
  NotesSave: 'notes:save',
  NotesResolveConflict: 'notes:resolve-conflict',
  NotesListTemplates: 'notes:list-templates',
  NotesGenerate: 'notes:generate',
  NotesCancelGenerate: 'notes:cancel-generate',
  NotesGetPendingGenerate: 'notes:get-pending-generate',
  NotesGetRun: 'notes:get-run',
  /** renderer → main, fire and forget */
  NotesFlushAck: 'notes:flush-ack',
  /** main → renderer events */
  NotesChanged: 'notes:changed',
  NotesEvent: 'notes:event',
  NotesPendingGenerateChanged: 'notes:pending-generate-changed',
  NotesFlushRequest: 'notes:flush-request',
} as const;

export interface SaveNoteRequest {
  meetingId: string;
  kind: NoteKind;
  doc: NoteDoc;
  /**
   * The note the edits build on. Main keeps a save on a doc it has replaced since (a 409's server
   * doc, a run's AI notes, "Use mine") as the conflict copy and leaves the doc as it is, so typing
   * sent as such a doc arrives never overwrites it (NotesStore.saveLocal).
   */
  base: NoteSaveBase | null;
}

/**
 * The stored note a save's edits build on: the note whose doc the editor last put on screen (on
 * open, or a doc from elsewhere it then showed), never a save of its own, whose answer may still
 * be on its way. Null when main held no note of that kind then.
 */
export interface NoteSaveBase {
  /** The note's `revisionId`: the local save that wrote its doc, null for a server doc. */
  revisionId: string | null;
  /** The note's `baseVersion`: with no revision, the server version the doc came as. */
  version: number;
}

/** The base of the saves an editor makes after it took `note` from main (null: none). */
export function noteSaveBase(note: LocalNote | null): NoteSaveBase | null {
  return note === null ? null : { revisionId: note.revisionId, version: note.baseVersion };
}

/**
 * Names the doc a base stands for: two bases with the same key build on the same doc. A local
 * revision names its doc whatever the version (an upload moves the version, not the doc); a
 * server doc is named by its version.
 */
export function saveBaseKey(base: NoteSaveBase | null): string {
  if (base === null) return 'none';
  return base.revisionId === null ? `version ${base.version}` : `revision ${base.revisionId}`;
}

export interface ResolveNoteConflictRequest {
  meetingId: string;
  kind: NoteKind;
  /** `mine`: "Use mine", the conflict copy becomes the doc again. `theirs`: drop the copy. */
  keep: 'mine' | 'theirs';
}

export interface GenerateNotesRequest {
  meetingId: string;
  templateId: string;
}

export interface NotesRunRequest {
  meetingId: string;
  runId: string;
}

/** One event of a meeting's notes run, as main forwards it from the API's stream. */
export interface NotesStreamMessage {
  meetingId: string;
  runId: string;
  event: NotesStreamEvent;
}

/** A meeting's pending generate changed; null once it is gone (done, cancelled, or an error). */
export interface PendingGenerateChange {
  meetingId: string;
  pending: PendingGenerateState | null;
}

/** Main's request to save every open editor now (quit), and the page's answer with the same id. */
export interface NotesFlush {
  requestId: string;
}

/** Notes' part of `window.roger`. */
export interface NotesApi {
  /** Both notes of the meeting as notes.sqlite holds them; main fetches the server's after. */
  getNotes(meetingId: string): Promise<MeetingNotes>;
  /**
   * Writes the doc to notes.sqlite before it answers, as a new local revision (`revisionId`).
   * NotesSync uploads it later. Rejects a doc `noteDocProblem` refuses. A save on a stale `base`
   * is kept as the conflict copy instead: the answer then holds main's doc, not this one, and
   * its `revisionId` is not this save's.
   */
  saveNote(request: SaveNoteRequest): Promise<LocalNote>;
  /** Ends a `conflict`: rejects when the note has no conflict copy. */
  resolveNoteConflict(request: ResolveNoteConflictRequest): Promise<LocalNote>;
  listNoteTemplates(): Promise<NoteTemplate[]>;
  /**
   * The Generate button, Retry, or the answer to "Which kind of call was this?". A pending
   * generate that has not failed (waiting for a template, lines or notes) takes this template and
   * keeps its run id and reason: an attempt may already have reached the API, and a new id would
   * start a second paid run. A failed one, or none, gets a new run id with reason `button`: the
   * API replays a finished run's result to a re-sent id, the same failure again. Rejects while a
   * run is streaming.
   */
  generateNotes(request: GenerateNotesRequest): Promise<PendingGenerateState>;
  /** Stops the meeting's run (its stream ends with a `cancelled` error) or drops a waiting one. */
  cancelNotesGenerate(meetingId: string): Promise<void>;
  getPendingGenerate(meetingId: string): Promise<PendingGenerateState | null>;
  /** One run: its "Removed lines", and the doc "Restore previous notes" puts back. */
  getNotesRun(request: NotesRunRequest): Promise<LlmRun>;
  /** Answers a flush request once, after every open editor's save has landed. */
  ackNotesFlush(ack: NotesFlush): void;
  /**
   * Every change to a stored note: a save from this page included (its `revisionId` tells it
   * apart), a sync state, a server doc taken on load, on a conflict, or at a run's `done`.
   */
  onNoteChanged(listener: (note: LocalNote) => void): Unsubscribe;
  onNotesEvent(listener: (message: NotesStreamMessage) => void): Unsubscribe;
  onPendingGenerateChanged(listener: (change: PendingGenerateChange) => void): Unsubscribe;
  /**
   * Main is about to quit: save every open editor, then `ackNotesFlush`. Main waits 1 s per
   * window, because React does not unmount on Cmd-Q and a save left to unmount is lost.
   */
  onNotesFlushRequest(listener: (request: NotesFlush) => void): Unsubscribe;
}
