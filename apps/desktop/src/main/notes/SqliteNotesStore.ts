import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { type NoteSaveBase, saveBaseKey } from '../../shared/ipc/notes';
import {
  CITATION_NODE_TYPE,
  isNoteKind,
  noteDocProblem,
  type GenerateReason,
  type LocalNote,
  type MeetingNotes,
  type Note,
  type NoteDoc,
  type NoteKind,
  type NoteNode,
} from '../../shared/notes';
import { Emitter } from '../util/emitter';
import type { NotesStore, StoredNoteSyncState, StoredPendingGenerate } from './NotesStore';

/**
 * `notes.sqlite`: M4's own file, apart from `roger.sqlite`, with its own `user_version`, so notes
 * take no number from the shared migration list that M2 and M5 extend (M4 "Desktop store").
 *
 * - `notes`: one row per meeting and kind (`user`, `ai`): the doc the editor shows, the server
 *   version it builds on, the local revision that wrote it and whether the server has it yet
 *   (`dirty`), the conflict copy, the stored sync state, and `has_text` for `hasNotes`.
 * - `pending_generate`: at most one per meeting; the run id is made before the first attempt.
 * - `template_choices`: the template last picked per normalised meeting title.
 *
 * No `workspace_id` column: one user per Mac, like M2's local tables (M4 known gaps, M6).
 * Instants are stored as `YYYY-MM-DDTHH:MM:SS.sssZ`, so they sort as text.
 *
 * Ordered, forward-only migrations tracked with `PRAGMA user_version`. Add an entry for every
 * schema change; never edit an applied one.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE notes (
    meeting_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'ai')),
    doc_json TEXT NOT NULL,
    revision_id TEXT,
    dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
    base_version INTEGER NOT NULL CHECK (base_version >= 0),
    template_id TEXT,
    last_run_id TEXT,
    generated_version INTEGER,
    conflict_json TEXT,
    sync_state TEXT NOT NULL CHECK (sync_state IN
      ('saved_locally', 'waiting_for_meeting', 'syncing', 'synced', 'offline')),
    has_text INTEGER NOT NULL CHECK (has_text IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (meeting_id, kind),
    -- A PUT carries the revision that wrote the doc; a dirty doc without one could never upload.
    CHECK (dirty = 0 OR revision_id IS NOT NULL)
  );
  CREATE INDEX notes_dirty ON notes (updated_at) WHERE dirty = 1;
  CREATE TABLE pending_generate (
    meeting_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    template_id TEXT,
    reason TEXT NOT NULL CHECK (reason IN ('after_stop', 'button')),
    created_at TEXT NOT NULL,
    last_error_code TEXT,
    last_error TEXT,
    CHECK ((last_error_code IS NULL) = (last_error IS NULL))
  );
  CREATE TABLE template_choices (
    title_key TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    chosen_at TEXT NOT NULL
  );
  `,
];

const STORED_SYNC_STATES: ReadonlySet<string> = new Set<StoredNoteSyncState>([
  'saved_locally',
  'waiting_for_meeting',
  'syncing',
  'synced',
  'offline',
]);

/** A `notes` row: a LocalNote whose sync state is the stored one, not yet read from the copy. */
interface StoredNote extends Omit<LocalNote, 'sync'> {
  sync: StoredNoteSyncState;
}

interface NotesStoreEvents extends Record<string, unknown> {
  changed: LocalNote;
}

export interface SqliteNotesStoreOptions {
  clock?: () => Date;
  /** Makes each local save's `revisionId`. UUIDv4 by default. */
  newRevisionId?: () => string;
}

type Row = Record<string, SQLOutputValue>;

export class SqliteNotesStore implements NotesStore {
  private readonly database: DatabaseSync;
  private readonly events = new Emitter<NotesStoreEvents>();
  private readonly clock: () => Date;
  private readonly newRevisionId: () => string;
  /**
   * Per note (`noteKey`), the base of the page saves that wrote its doc since main last wrote one
   * of its own (a server doc, "Use mine"). An editor sends a save at every pause without waiting
   * for answers, so its saves all carry the doc it last loaded, not the save before: each is taken
   * although the doc is by then that save's. In memory only, like `copyBases`: a base lives as
   * long as the page holding it, and no page outlives this process.
   */
  private readonly saveBases = new Map<string, string>();
  /**
   * Per note, the base of the editor whose typing the conflict copy holds: a later stale save on
   * that base holds the same typing and more, and may replace it. Unknown (another editor's, a
   * previous launch's), the copy is the only place some text lives, and is never replaced.
   */
  private readonly copyBases = new Map<string, string>();

  /** `path` may be `:memory:` for tests. */
  constructor(path: string, options: SqliteNotesStoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.newRevisionId = options.newRevisionId ?? randomUUID;
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA journal_mode = WAL');
    // As roger.sqlite: a committed save survives the app crashing; it is in the WAL file.
    this.database.exec('PRAGMA synchronous = NORMAL');
    // The owner reads this file with `sqlite3` while Roger runs; a reader must not fail a save.
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  // notes ----------------------------------------------------------------------------------------

  getNote(meetingId: string, kind: NoteKind): LocalNote | null {
    const stored = this.readNote(meetingId, kind);
    return stored === null ? null : toLocalNote(stored);
  }

  getNotes(meetingId: string): MeetingNotes {
    return {
      meetingId,
      user: this.getNote(meetingId, 'user'),
      ai: this.getNote(meetingId, 'ai'),
    };
  }

  saveLocal(
    meetingId: string,
    kind: NoteKind,
    doc: NoteDoc,
    base?: NoteSaveBase | null,
  ): LocalNote {
    const problem = noteDocProblem(doc);
    if (problem !== null) {
      throw new Error(`note not saved for the ${kind} notes of meeting ${meetingId}: ${problem}`);
    }
    const local = this.readNote(meetingId, kind);
    const key = noteKey(meetingId, kind);
    const baseKey = base === undefined ? docKey(local) : saveBaseKey(base);
    if (local !== null && baseKey !== docKey(local) && baseKey !== this.saveBases.get(key)) {
      return this.keepStaleSave(local, doc, baseKey);
    }
    this.saveBases.set(key, baseKey);
    // The save does not change why the note cannot upload; it does make a `synced` or `syncing`
    // note one with edits the server has not seen.
    const keepsSync = local?.sync === 'waiting_for_meeting' || local?.sync === 'offline';
    return this.write({
      meetingId,
      kind,
      doc,
      revisionId: this.newRevisionId(),
      dirty: true,
      baseVersion: local?.baseVersion ?? 0,
      templateId: local?.templateId ?? null,
      lastRunId: local?.lastRunId ?? null,
      generatedVersion: local?.generatedVersion ?? null,
      conflictCopy: local?.conflictCopy ?? null,
      sync: keepsSync ? local.sync : 'saved_locally',
      updatedAt: this.now(),
    });
  }

  applyServerNote(meetingId: string, note: Note): LocalNote {
    const problem = noteDocProblem(note.doc);
    if (problem !== null) {
      throw new Error(
        `server note not taken for the ${note.kind} notes of meeting ${meetingId}: ${problem}`,
      );
    }
    const server = {
      templateId: note.templateId,
      lastRunId: note.lastRunId,
      generatedVersion: note.generatedVersion,
    };
    const local = this.readNote(meetingId, note.kind);
    if (local === null) {
      return this.write({
        meetingId,
        kind: note.kind,
        doc: note.doc,
        revisionId: null,
        dirty: false,
        baseVersion: note.version,
        ...server,
        conflictCopy: null,
        sync: 'synced',
        updatedAt: this.now(),
      });
    }
    // An answer older than what the local doc builds on raced a later PUT: it says nothing new.
    if (note.version < local.baseVersion) return toLocalNote(local);
    if (note.version === local.baseVersion) {
      // The doc the local one builds on: a dirty doc is still to upload, and stays.
      return this.update(local, { ...server, sync: local.dirty ? local.sync : 'synced' });
    }
    // Newer from here on.
    if (local.dirty && local.conflictCopy !== null) {
      // Edits to the server's doc made during a conflict, and the copy: two local docs and one
      // slot. Taking the server's doc would lose one of them, so nothing changes until the user
      // resolves; NotesSync does not upload a note in conflict, and the upload after the choice
      // meets a `409` that brings this doc in again, as an ordinary conflict.
      return toLocalNote(local);
    }
    if (sameJson(note.doc, local.doc)) {
      // The local save coming back (a GET that crossed its PUT), or the same text from elsewhere.
      // Not a conflict, and not a new doc for the editor: the revision stays.
      return this.update(local, {
        ...server,
        baseVersion: note.version,
        dirty: false,
        sync: 'synced',
      });
    }
    if (local.dirty) {
      // The page saves that wrote it: an editor still on their base holds this typing and more.
      const key = noteKey(meetingId, note.kind);
      this.copyBases.set(key, this.saveBases.get(key) ?? docKey(local));
    }
    return this.update(local, {
      ...server,
      doc: note.doc,
      revisionId: null,
      dirty: false,
      baseVersion: note.version,
      // A dirty local doc is never overwritten: it becomes the conflict copy. A clean one keeps
      // an existing copy until the user resolves it.
      conflictCopy: local.dirty ? local.doc : local.conflictCopy,
      sync: 'synced',
      updatedAt: this.now(),
    });
  }

  markSynced(meetingId: string, kind: NoteKind, sentRevisionId: string, note: Note): LocalNote {
    const local = this.readNote(meetingId, kind);
    if (local === null) {
      throw new Error(`no ${kind} notes of meeting ${meetingId} to mark synced`);
    }
    // A save that arrived while the PUT was out is still to go, on the version the PUT made.
    const stillDirty = local.revisionId !== sentRevisionId && local.dirty;
    return this.update(local, {
      templateId: note.templateId,
      lastRunId: note.lastRunId,
      generatedVersion: note.generatedVersion,
      baseVersion: Math.max(local.baseVersion, note.version),
      dirty: stillDirty,
      sync: stillDirty ? 'saved_locally' : 'synced',
    });
  }

  setSyncState(meetingId: string, kind: NoteKind, state: StoredNoteSyncState): LocalNote | null {
    const local = this.readNote(meetingId, kind);
    return local === null ? null : this.update(local, { sync: state });
  }

  resolveConflict(meetingId: string, kind: NoteKind, keep: 'mine' | 'theirs'): LocalNote {
    const local = this.readNote(meetingId, kind);
    if (local?.conflictCopy == null) {
      throw new Error(`no conflict to resolve on the ${kind} notes of meeting ${meetingId}`);
    }
    this.copyBases.delete(noteKey(meetingId, kind));
    if (keep === 'theirs') return this.update(local, { conflictCopy: null });
    return this.update(local, {
      doc: local.conflictCopy,
      conflictCopy: null,
      revisionId: this.newRevisionId(),
      dirty: true,
      sync: 'saved_locally',
      updatedAt: this.now(),
    });
  }

  listDirtyNotes(): LocalNote[] {
    return this.database
      .prepare('SELECT * FROM notes WHERE dirty = 1 ORDER BY updated_at, meeting_id, kind')
      .all()
      .map((row) => toLocalNote(rowToNote(row)));
  }

  listWaitingMeetingIds(): string[] {
    // Not SELECT DISTINCT: SQLite then walks the primary key, every row and doc in the file, on a
    // query that runs every 2 s. This one scans only the dirty rows (the notes_dirty partial
    // index), and a meeting has two at most, so the repeats go here.
    const rows = this.database
      .prepare(
        `SELECT meeting_id FROM notes WHERE dirty = 1 AND sync_state = 'waiting_for_meeting'
         ORDER BY updated_at`,
      )
      .all();
    return Array.from(new Set(rows.map((row) => text(row, 'meeting_id'))));
  }

  hasNotes(meetingId: string): boolean {
    const row = this.database
      .prepare('SELECT 1 AS found FROM notes WHERE meeting_id = ? AND has_text = 1 LIMIT 1')
      .get(meetingId);
    return row !== undefined;
  }

  deleteNoteIfEmpty(meetingId: string, kind: NoteKind): boolean {
    const result = this.database
      .prepare('DELETE FROM notes WHERE meeting_id = ? AND kind = ? AND has_text = 0')
      .run(meetingId, kind);
    const deleted = Number(result.changes) > 0;
    if (deleted) {
      this.saveBases.delete(noteKey(meetingId, kind));
      this.copyBases.delete(noteKey(meetingId, kind));
    }
    return deleted;
  }

  onNoteChanged(listener: (note: LocalNote) => void): () => void {
    return this.events.on('changed', listener);
  }

  // pending_generate -----------------------------------------------------------------------------

  getPendingGenerate(meetingId: string): StoredPendingGenerate | null {
    const row = this.database
      .prepare('SELECT * FROM pending_generate WHERE meeting_id = ?')
      .get(meetingId);
    return row === undefined ? null : rowToPendingGenerate(row);
  }

  listPendingGenerates(): StoredPendingGenerate[] {
    return this.database
      .prepare('SELECT * FROM pending_generate ORDER BY created_at, meeting_id')
      .all()
      .map(rowToPendingGenerate);
  }

  putPendingGenerate(pending: StoredPendingGenerate): void {
    this.database
      .prepare(
        `INSERT INTO pending_generate
           (meeting_id, run_id, template_id, reason, created_at, last_error_code, last_error)
         VALUES (:meetingId, :runId, :templateId, :reason, :createdAt, :code, :message)
         ON CONFLICT (meeting_id) DO UPDATE SET
           run_id = excluded.run_id, template_id = excluded.template_id,
           reason = excluded.reason, created_at = excluded.created_at,
           last_error_code = excluded.last_error_code, last_error = excluded.last_error`,
      )
      .run({
        meetingId: pending.meetingId,
        runId: pending.runId,
        templateId: pending.templateId,
        reason: pending.reason,
        createdAt: pending.createdAt,
        code: pending.lastError?.code ?? null,
        message: pending.lastError?.message ?? null,
      });
  }

  deletePendingGenerate(meetingId: string, runId: string): boolean {
    const result = this.database
      .prepare('DELETE FROM pending_generate WHERE meeting_id = ? AND run_id = ?')
      .run(meetingId, runId);
    return Number(result.changes) > 0;
  }

  // template_choices -----------------------------------------------------------------------------

  getTemplateChoice(titleKey: string): string | null {
    const row = this.database
      .prepare('SELECT template_id FROM template_choices WHERE title_key = ?')
      .get(titleKey);
    return row === undefined ? null : text(row, 'template_id');
  }

  rememberTemplateChoice(titleKey: string, templateId: string): void {
    if (titleKey.trim() === '') throw new Error('cannot remember a template for a blank title');
    if (templateId.trim() === '') throw new Error('cannot remember a blank template id');
    this.database
      .prepare(
        `INSERT INTO template_choices (title_key, template_id, chosen_at) VALUES (?, ?, ?)
         ON CONFLICT (title_key) DO UPDATE SET
           template_id = excluded.template_id, chosen_at = excluded.chosen_at`,
      )
      .run(titleKey, templateId, this.now());
  }

  close(): void {
    this.database.close();
  }

  // internals ------------------------------------------------------------------------------------

  private readNote(meetingId: string, kind: NoteKind): StoredNote | null {
    const row = this.database
      .prepare('SELECT * FROM notes WHERE meeting_id = ? AND kind = ?')
      .get(meetingId, kind);
    return row === undefined ? null : rowToNote(row);
  }

  /** Write `patch` over the stored note; nothing is written or emitted when nothing changes. */
  private update(local: StoredNote, patch: Partial<StoredNote>): LocalNote {
    const next = { ...local, ...patch };
    if (sameJson(next, local)) return toLocalNote(local);
    this.followSaveBase(local, next);
    return this.write(next);
  }

  /**
   * After main writes a note itself: a new doc (a server doc, "Use mine") ends the page saves'
   * base, so a save typed before it is stale (saveLocal). The same doc under a new name, a newer
   * server version that says the same, keeps saves on the old name current.
   */
  private followSaveBase(before: StoredNote, after: StoredNote): void {
    const was = docKey(before);
    if (docKey(after) === was) return;
    const key = noteKey(before.meetingId, before.kind);
    if (!sameJson(before.doc, after.doc)) this.saveBases.delete(key);
    else if (!this.saveBases.has(key)) this.saveBases.set(key, was);
  }

  /**
   * A page save built on a doc main has replaced since (saveLocal): stored over that doc, it
   * would leave the replacing version nowhere, so it becomes the conflict copy and the doc stays.
   * The page tells it from a save that was taken by the doc in the answer.
   */
  private keepStaleSave(local: StoredNote, doc: NoteDoc, baseKey: string): LocalNote {
    const key = noteKey(local.meetingId, local.kind);
    if (sameJson(doc, local.doc)) {
      // Typing that says what main holds: nothing to keep apart, and the editor's next saves, on
      // the same base, build on this doc.
      this.saveBases.set(key, baseKey);
      return toLocalNote(local);
    }
    const copy = local.conflictCopy;
    if (copy !== null && !sameJson(doc, copy) && this.copyBases.get(key) !== baseKey) {
      // Two local docs and one slot, as in applyServerNote: either choice would lose text, so the
      // save is refused and its typing stays in the editor until the user picks a version.
      throw new Error(
        `note not saved for the ${local.kind} notes of meeting ${local.meetingId}: they changed ` +
          'elsewhere while a copy of yours is kept aside; choose a version first',
      );
    }
    this.copyBases.set(key, baseKey);
    return this.update(local, { conflictCopy: doc, updatedAt: this.now() });
  }

  /** Upsert the whole row, then answer and emit the note as stored (as a later read returns it). */
  private write(note: StoredNote): LocalNote {
    this.database
      .prepare(
        `INSERT INTO notes (meeting_id, kind, doc_json, revision_id, dirty, base_version,
           template_id, last_run_id, generated_version, conflict_json, sync_state, has_text,
           updated_at)
         VALUES (:meetingId, :kind, :doc, :revisionId, :dirty, :baseVersion, :templateId,
           :lastRunId, :generatedVersion, :conflict, :sync, :hasText, :updatedAt)
         ON CONFLICT (meeting_id, kind) DO UPDATE SET
           doc_json = excluded.doc_json, revision_id = excluded.revision_id,
           dirty = excluded.dirty, base_version = excluded.base_version,
           template_id = excluded.template_id, last_run_id = excluded.last_run_id,
           generated_version = excluded.generated_version, conflict_json = excluded.conflict_json,
           sync_state = excluded.sync_state, has_text = excluded.has_text,
           updated_at = excluded.updated_at`,
      )
      .run({
        meetingId: note.meetingId,
        kind: note.kind,
        doc: JSON.stringify(note.doc),
        revisionId: note.revisionId,
        dirty: note.dirty ? 1 : 0,
        baseVersion: note.baseVersion,
        templateId: note.templateId,
        lastRunId: note.lastRunId,
        generatedVersion: note.generatedVersion,
        conflict: note.conflictCopy === null ? null : JSON.stringify(note.conflictCopy),
        sync: note.sync,
        hasText: docHasText(note.doc) || docHasText(note.conflictCopy) ? 1 : 0,
        updatedAt: note.updatedAt,
      });
    const stored = this.readNote(note.meetingId, note.kind);
    if (stored === null) {
      throw new Error(`the ${note.kind} notes of meeting ${note.meetingId} were not stored`);
    }
    const local = toLocalNote(stored);
    this.events.emit('changed', local);
    return local;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private migrate(): void {
    const current = Number(this.database.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.exec(MIGRATIONS[version] ?? '');
        this.database.exec(`PRAGMA user_version = ${version + 1}`);
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }
  }
}

function noteKey(meetingId: string, kind: NoteKind): string {
  return `${meetingId}/${kind}`;
}

/** The key of the doc the note holds, as a save's base names it (saveBaseKey). */
function docKey(note: StoredNote | null): string {
  return saveBaseKey(
    note === null ? null : { revisionId: note.revisionId, version: note.baseVersion },
  );
}

/** A note is in conflict while it holds a conflict copy, whatever its stored state says. */
function toLocalNote(stored: StoredNote): LocalNote {
  return { ...stored, sync: stored.conflictCopy === null ? stored.sync : 'conflict' };
}

/**
 * Whether a doc holds text a person wrote or a chip: an empty paragraph, or spaces, are no
 * notes. Iterative, so a deep doc cannot overflow the stack.
 */
function docHasText(doc: NoteDoc | null): boolean {
  const stack: NoteNode[] = [];
  const pushAll = (nodes: NoteNode[] | undefined): void => {
    for (const node of nodes ?? []) stack.push(node);
  };
  pushAll(doc?.content);
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === CITATION_NODE_TYPE) return true;
    if (node.text !== undefined && node.text.trim() !== '') return true;
    pushAll(node.content);
  }
  return false;
}

/**
 * Whether two JSON values say the same, ignoring the order of object keys: Postgres `jsonb`
 * stores keys in its own order, so a doc comes back from the API with its keys moved.
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    );
  }
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  const otherKeys = Object.keys(b).filter((key) => b[key] !== undefined);
  return keys.length === otherKeys.length && keys.every((key) => sameJson(a[key], b[key]));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function rowToNote(row: Row): StoredNote {
  const kind = text(row, 'kind');
  if (!isNoteKind(kind)) throw new Error(`corrupt notes row: kind is ${kind}`);
  const sync = text(row, 'sync_state');
  if (!STORED_SYNC_STATES.has(sync)) throw new Error(`corrupt notes row: sync_state is ${sync}`);
  const conflict = optionalText(row, 'conflict_json');
  return {
    meetingId: text(row, 'meeting_id'),
    kind,
    // Written by `write` from a doc noteDocProblem accepted; the casts restore that type.
    doc: JSON.parse(text(row, 'doc_json')) as NoteDoc,
    revisionId: optionalText(row, 'revision_id'),
    dirty: integer(row, 'dirty') === 1,
    baseVersion: integer(row, 'base_version'),
    templateId: optionalText(row, 'template_id'),
    lastRunId: optionalText(row, 'last_run_id'),
    generatedVersion: optionalInteger(row, 'generated_version'),
    conflictCopy: conflict === null ? null : (JSON.parse(conflict) as NoteDoc),
    // Checked against STORED_SYNC_STATES above.
    sync: sync as StoredNoteSyncState,
    updatedAt: text(row, 'updated_at'),
  };
}

function rowToPendingGenerate(row: Row): StoredPendingGenerate {
  const reason = text(row, 'reason');
  if (reason !== 'after_stop' && reason !== 'button') {
    throw new Error(`corrupt pending_generate row: reason is ${reason}`);
  }
  const code = optionalText(row, 'last_error_code');
  const message = optionalText(row, 'last_error');
  return {
    meetingId: text(row, 'meeting_id'),
    runId: text(row, 'run_id'),
    templateId: optionalText(row, 'template_id'),
    reason: reason satisfies GenerateReason,
    createdAt: text(row, 'created_at'),
    lastError: code === null || message === null ? null : { code, message },
  };
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`corrupt notes row: ${key} is ${typeof value}`);
  return value;
}

function optionalText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`corrupt notes row: ${key} is ${typeof value}`);
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`corrupt notes row: ${key} is ${typeof value}`);
  }
  return value;
}

function optionalInteger(row: Row, key: string): number | null {
  return row[key] === null || row[key] === undefined ? null : integer(row, key);
}
