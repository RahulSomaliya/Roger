import type { NoteSaveBase } from '../../shared/ipc/notes';
import type {
  GenerateReason,
  LocalNote,
  MeetingNotes,
  Note,
  NoteDoc,
  NoteKind,
  NoteSyncState,
} from '../../shared/notes';

/**
 * The sync states a row stores. `conflict` is not one of them: a note is in conflict while it
 * holds a conflict copy, whatever else happens to it, so the state is read from the copy.
 */
export type StoredNoteSyncState = Exclude<NoteSyncState, 'conflict'>;

/**
 * A meeting's pending generate as `pending_generate` holds it (M4 "Generate after Stop"). Where
 * it stands (`PendingGenerateStatus`) is worked out by NotesGenerator (M4-T23) from the meeting,
 * the notes and this row; only a failure Retry can fix is stored, so it survives a restart.
 */
export interface StoredPendingGenerate {
  meetingId: string;
  /**
   * Made before the first attempt. Every attempt re-sends it, so a retry after a crash or a
   * dropped stream attaches to or replays this run instead of paying for a second one. Only Retry
   * after a failed run takes a new one (the API would replay the stored failure to the old one).
   */
  runId: string;
  /**
   * Never null in a row written now. A row an earlier build left asking "Which kind of call was
   * this?" (redesign call 6 deleted the question) still reads null, and NotesGenerator drops it.
   * The column stays nullable: dropping that needs a migration for no gain.
   */
  templateId: string | null;
  reason: GenerateReason;
  /** UTC ISO 8601. */
  createdAt: string;
  /** The last attempt's failure that Retry can fix (`llm_provider_error`); null otherwise. */
  lastError: { code: string; message: string } | null;
}

/**
 * The Mac's copy of every meeting's notes (`notes.sqlite`), the pending generates and the
 * template picks. The editor saves here on every edit; NotesSync uploads from here. All methods are
 * synchronous, like TranscriptStore's: a save is on disk before `saveLocal` returns, so the page may
 * say "Saved on this Mac" as soon as `notes.save` answers.
 *
 * Every write that changes a note emits `onNoteChanged` with the note as stored, a save from the
 * page included (main forwards each one as `notes:changed`).
 */
export interface NotesStore {
  getNote(meetingId: string, kind: NoteKind): LocalNote | null;
  getNotes(meetingId: string): MeetingNotes;
  /**
   * Store the page's doc as a new local revision (a new `revisionId`), dirty. The sync state
   * becomes `saved_locally`, except that `waiting_for_meeting`, `offline`, `refused` and
   * `refused_access` stay: the save does not change why the note cannot upload. A conflict copy stays until it is resolved. Throws,
   * storing nothing, on a doc `noteDocProblem` refuses: the API would refuse it with a `422`, and
   * it would stay dirty and be re-sent forever.
   *
   * `base` is the note the edits build on (SaveNoteRequest.base). A save on a doc main has
   * replaced since (a `409`'s or a pull's server doc, a run's AI notes, "Use mine") would store
   * the edits over that doc, and the server's version would then be kept nowhere: it becomes the
   * conflict copy instead, and the doc stays; the answer then holds the other doc, not this
   * save's. It replaces a copy only of that editor's own earlier typing: a copy of other text (a
   * conflict from before, or a previous launch) is the only place that text lives, so such a save
   * is held on disk behind it instead, and becomes the copy once the user has picked for the one
   * before (`resolveConflict`); the note is written again, the same but for `updatedAt`, so the
   * page is told main's doc. Never thrown: the typing would then live only in an editor whose
   * later saves are refused the same way, and be lost at quit. Saves an editor sends before an
   * earlier one answered carry the same base, and are taken. Left out, the save builds on the doc
   * main holds.
   */
  saveLocal(meetingId: string, kind: NoteKind, doc: NoteDoc, base?: NoteSaveBase | null): LocalNote;
  /**
   * Take the server's note (a load, a `409`, a run's `done`), so notes.sqlite never holds an
   * older doc than Postgres:
   * - no local note: the server's is taken, clean.
   * - older than the version the local doc builds on (it raced a later `PUT`): nothing changes.
   * - the same version: the local doc stays, a dirty one still to upload; the server's template,
   *   run and generated version are taken.
   * - newer, local clean: the server's doc replaces it. An existing conflict copy stays.
   * - newer, local dirty: the server's doc replaces it and the local doc becomes the conflict copy
   *   (`conflict`), unless both docs say the same, which is the local save coming back.
   * - newer, local dirty and already in conflict: nothing changes until the conflict is resolved
   *   (a second copy has no slot, and either choice would lose text); the next upload's `409`
   *   then brings the server's doc in again.
   * Throws on a doc `noteDocProblem` refuses.
   */
  applyServerNote(meetingId: string, note: Note): LocalNote;
  /**
   * The API stored the `PUT` of `sentRevisionId` as `note`. The note builds on `note.version`
   * from now on; it turns clean only when no newer local save arrived while the `PUT` was out.
   */
  markSynced(meetingId: string, kind: NoteKind, sentRevisionId: string, note: Note): LocalNote;
  /** Null when there is no such note. */
  setSyncState(meetingId: string, kind: NoteKind, state: StoredNoteSyncState): LocalNote | null;
  /**
   * End a conflict. `mine`: the conflict copy becomes the doc again as a new local revision, to
   * upload over the server's ("Use mine"); edits made to the server's doc during the conflict are
   * dropped, by the user's choice. `theirs`: the copy is dropped. Then the oldest save held behind
   * the copy (`saveLocal`), if any, is the copy: still `conflict`, the user picks again. Held
   * typing that says what the doc then says needs no choice and goes. Throws when there is no
   * copy.
   */
  resolveConflict(meetingId: string, kind: NoteKind, keep: 'mine' | 'theirs'): LocalNote;
  /** Notes with edits the server has not stored, oldest save first, across meetings. */
  listDirtyNotes(): LocalNote[];
  /**
   * The meetings with a dirty note `waiting_for_meeting`, each once, oldest save first. NotesSync
   * asks on every uploader status event (every 2 s while the uploader runs), so this reads ids in
   * the database and never parses a doc, as `listDirtyNotes` does.
   */
  listWaitingMeetingIds(): string[];
  /**
   * Whether the meeting holds notes with text in them: the check TranscriptUploader and
   * CaptureService make before discarding a meeting nobody spoke in (M4-T22). A doc with no text
   * (the editor saves an empty paragraph on blur) does not count, or every empty meeting whose
   * notepad was opened would be kept and uploaded. Such a note outlives its discarded meeting
   * until NotesSync deletes it (`deleteNoteIfEmpty`). Text in a conflict copy, or in a save held
   * behind one (`saveLocal`), counts.
   */
  hasNotes(meetingId: string): boolean;
  /**
   * Delete the note if it holds no text by `hasNotes`'s rule (a conflict copy or a held save with
   * text counts), and say whether it did. NotesSync calls it for a meeting neither roger.sqlite
   * nor Postgres holds: one discarded as empty, whose notepad saved an empty paragraph on blur.
   * Nothing the user wrote is lost; kept, the note would wait for its meeting for good. Emits
   * nothing: no page shows a discarded meeting, and `notes:changed` carries a note.
   */
  deleteNoteIfEmpty(meetingId: string, kind: NoteKind): boolean;
  /**
   * Trap: NotesSync's own attempts write here too (`syncing` on a first attempt, then `synced`,
   * `offline` or `saved_locally`), so a listener that calls `NotesSync.flushMeeting` (NotesGenerator's
   * re-check, M4-T23) is fed by its own flush. Read the trap on flushMeeting before wiring one.
   */
  onNoteChanged(listener: (note: LocalNote) => void): () => void;

  getPendingGenerate(meetingId: string): StoredPendingGenerate | null;
  /** Oldest first. */
  listPendingGenerates(): StoredPendingGenerate[];
  /** Insert or replace the meeting's one pending generate. */
  putPendingGenerate(pending: StoredPendingGenerate): void;
  /**
   * Delete the meeting's pending generate if it is still this run's. False when it is gone or has
   * a newer run id: a late `done` of an old run must not end a Retry's generate.
   */
  deletePendingGenerate(meetingId: string, runId: string): boolean;

  /**
   * The template last picked for meetings with this title. `titleKey` is the title as
   * `shared/suggestTemplate.ts` normalises it (M4-T23), which also decides which titles are never
   * remembered ("Untitled meeting").
   */
  getTemplateChoice(titleKey: string): string | null;
  rememberTemplateChoice(titleKey: string, templateId: string): void;

  close(): void;
}
