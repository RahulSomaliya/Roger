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
   * NotesSync uploads it later. Rejects a doc `noteDocProblem` refuses.
   */
  saveNote(request: SaveNoteRequest): Promise<LocalNote>;
  /** Ends a `conflict`: rejects when the note has no conflict copy. */
  resolveNoteConflict(request: ResolveNoteConflictRequest): Promise<LocalNote>;
  listNoteTemplates(): Promise<NoteTemplate[]>;
  /**
   * The Generate button, or the answer to "Which kind of call was this?": a pending generate
   * waiting for a template takes this one and keeps its run id; otherwise main writes a new one.
   * Rejects while a run is streaming.
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
