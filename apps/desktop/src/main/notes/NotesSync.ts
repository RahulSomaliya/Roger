import type { NoteSaveBase } from '../../shared/ipc/notes';
import type { LocalNote, MeetingNotes, NoteDoc, NoteKind } from '../../shared/notes';
import { ApiError } from '../api/http';
import type { NotesSyncApi, ServerNotes } from '../api/notesClient';
import { errorMessage, type Logger } from '../logger';
import type { RemoteState } from '../store/TranscriptStore';
import type { NotesStore } from './NotesStore';

/** An upload waits this long after the last save, so a stretch of typing is one `PUT`. */
export const NOTES_SYNC_DEBOUNCE_MS = 1_500;
/** The first retry after the API failed; each further failure doubles it, up to the cap. */
export const NOTES_SYNC_FIRST_RETRY_MS = 2_000;
export const NOTES_SYNC_MAX_BACKOFF_MS = 30_000;
/**
 * flushMeeting sends a note at most this many times in a row: a save that lands while a `PUT` is
 * out leaves the note behind again, and the user may still be typing after Stop.
 */
const FLUSH_ATTEMPTS = 3;

const NOTE_KINDS: readonly NoteKind[] = ['user', 'ai'];

/** Where a meeting stands in roger.sqlite, as the uploader keeps it. */
export interface MeetingUploadState {
  /** Null when roger.sqlite does not know the meeting. */
  remoteState(meetingId: string): RemoteState | null;
  /** Called on every uploader status event: a pending meeting may have been created. */
  onChange(listener: () => void): () => void;
}

/**
 * Whether a meeting's notes are all in Postgres, and the versions there: a notes run names both
 * (`user_notes_version`, `ai_base_version`; 0 where a doc does not exist). Otherwise why not, as
 * the AI notes panel says it (`PendingGenerateStatus`, `waiting_for_notes`).
 */
export type FlushMeetingResult =
  | { ok: true; userNotesVersion: number; aiBaseVersion: number }
  | { ok: false; cause: 'meeting' | 'offline' | 'conflict' };

export interface NotesSyncOptions {
  store: NotesStore;
  api: NotesSyncApi;
  meetings: MeetingUploadState;
  /**
   * The uploader's own repair for a meeting Postgres lost (`TranscriptUploader.markMeetingMissing`,
   * M4-T22): back to pending, its lines sent again. Called on a `404`.
   */
  onMeetingMissing: (meetingId: string) => void;
  logger: Logger;
  debounceMs?: number;
  firstRetryMs?: number;
  maxBackoffMs?: number;
  clock?: () => Date;
}

/**
 * What one attempt at a note did:
 * - `clean`: nothing to send. `synced`: sent and now clean. `behind`: sent, but a newer save
 *   arrived meanwhile and is still to go.
 * - `meeting`: the meeting is not in Postgres (pending, or a `404`). `conflict`: the note holds a
 *   conflict copy. `offline`: the API did not answer, or failed (5xx).
 * - `refused`: the API answered with something a retry may fix but this code cannot read as one of
 *   the above (a `401`, a `422`, a `409` the server's copy did not explain).
 * - `backing_off`: the API was away at the note's last attempt and the backoff has not ended; no
 *   request was made.
 * - `stopped`: the sync stopped (quit), before the attempt or while its request was out; the store
 *   may be closed.
 */
type SyncOutcome =
  | 'clean'
  | 'synced'
  | 'behind'
  | 'meeting'
  | 'conflict'
  | 'offline'
  | 'refused'
  | 'backing_off'
  | 'stopped';

/**
 * Uploads the notes in notes.sqlite to Postgres (M4 "Notes on the Mac"). It runs for the life of
 * the app. A save uploads 1.5 s after the last one; a failure backs off from 2 s to 30 s; dirty
 * notes from a previous run upload at start. Every `PUT` carries the version the doc builds on
 * and the revision that wrote it, so a re-send is answered with the stored note (house rule 7)
 * and a stale one is a `409`, after which the server's doc is taken and the local one kept as a
 * conflict copy (`NotesStore.applyServerNote`). A note in conflict does not upload until the user
 * picks.
 *
 * Trap: NotesSync never creates a meeting. Only TranscriptUploader creates meetings in Postgres
 * (its pending rule creates a meeting once it holds a line, or once it has ended with notes; see
 * TranscriptUploader.ts and the delete sites in CaptureService.ts, which check `hasNotes`). Creating
 * one here on a `404` would put a meeting in Postgres the uploader never ends, stuck "recording",
 * or one with no line while it is still being recorded, which MCP then serves as the latest
 * meeting. So a note waits while its meeting is pending, and a `404` asks the uploader to take the
 * meeting back (`onMeetingMissing`) and waits for it. A note with no text whose meeting answers
 * `404` and is gone from roger.sqlite too is deleted instead: its meeting was discarded as empty.
 *
 * Attempts at one note run one at a time (`serialised`): a pass, flushMeeting and a load's
 * `applyServerNote` never cross on the same note, so a load that reads the version an upload just
 * made waits for that upload's answer instead of seeing a conflict with the user's own text.
 */
export class NotesSync {
  private readonly debounceMs: number;
  private readonly firstRetryMs: number;
  private readonly maxBackoffMs: number;
  private readonly clock: () => Date;
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * Meetings that answered `404` and that the uploader did not take back to pending. Their notes,
   * which hold text (an empty one is deleted), wait until the meeting turns up pending: without
   * this, every uploader status event would send them again, every 2 s, for good.
   */
  private readonly stranded = new Set<string>();
  private running = false;
  private stopped = false;
  /**
   * A pass is running. Passes never overlap: a second one queues behind the first one's hung `PUT`
   * (`serialised`) and sends the moment it fails, inside the backoff, so while requests fail
   * slowly the `PUT`s go back to back and the backoff climbs twice as fast.
   */
  private passing = false;
  /** A pass came due while one was running; it runs when that one ends. */
  private passDue = false;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  /**
   * While backing off (ms since the epoch): the retry pass runs then, and no attempt at a note the
   * API was away for goes out before it, a flushMeeting's included.
   */
  private retryAtMs = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: NotesSyncOptions) {
    this.debounceMs = options.debounceMs ?? NOTES_SYNC_DEBOUNCE_MS;
    this.firstRetryMs = options.firstRetryMs ?? NOTES_SYNC_FIRST_RETRY_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? NOTES_SYNC_MAX_BACKOFF_MS;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Start uploading, beginning with the dirty notes a previous run left. */
  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.unsubscribe = this.options.meetings.onChange(() => {
      this.meetingsChanged();
    });
    this.soon();
  }

  /**
   * Stop every timer. An answer still on its way is dropped, and an attempt still queued (a pass's
   * next note, a flushMeeting behind a `PUT`) does not run, so nothing touches notes.sqlite after
   * the quit hook closed it; those notes stay dirty and upload at the next launch.
   */
  stop(): void {
    this.running = false;
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * The page's save (`notes.save`): on disk before it returns, uploaded 1.5 s after the last. A
   * save on a doc main has replaced since (`base`, NotesStore.saveLocal) is kept as the conflict
   * copy instead, which does not upload until the user picks.
   */
  save(meetingId: string, kind: NoteKind, doc: NoteDoc, base?: NoteSaveBase | null): LocalNote {
    const note = this.options.store.saveLocal(meetingId, kind, doc, base);
    this.afterSave();
    return note;
  }

  /** "Use mine" uploads the copy over the server's doc; "theirs" drops it. */
  resolveConflict(meetingId: string, kind: NoteKind, keep: 'mine' | 'theirs'): LocalNote {
    const note = this.options.store.resolveConflict(meetingId, kind, keep);
    if (note.dirty) this.afterSave();
    return note;
  }

  /**
   * Take the server's notes of a meeting into notes.sqlite (on load), and answer both as
   * notes.sqlite then holds them. A meeting Postgres does not hold yet has no notes there, so the
   * local copy is all there is. Rejects with the ApiError when the API is away.
   */
  async pullMeeting(meetingId: string): Promise<MeetingNotes> {
    const { store, api, meetings, logger } = this.options;
    if (meetings.remoteState(meetingId) === 'pending') return store.getNotes(meetingId);
    let server: ServerNotes;
    try {
      server = await api.getNotes(meetingId);
    } catch (error) {
      if (!(error instanceof ApiError && error.isNotFound)) throw error;
      logger.debug('notes not loaded: the meeting is not in Postgres', { meetingId });
      return store.getNotes(meetingId);
    }
    for (const kind of NOTE_KINDS) {
      const note = server[kind];
      if (note === null) continue;
      await this.serialised(meetingId, kind, () => {
        if (!this.stopped) store.applyServerNote(meetingId, note);
      });
    }
    if (this.stopped) throw new Error(`notes of meeting ${meetingId} not loaded: sync stopped`);
    return store.getNotes(meetingId);
  }

  /**
   * Upload the meeting's dirty notes now, before a notes run (M4 "Generate inputs"), and answer
   * the versions Postgres then holds. A conflict holds the run back even when nothing is dirty:
   * the user picks first. When the user is still typing, the newest save may not be in it; the
   * versions name what the server holds, and a run sent with a version since replaced is a `409`.
   * It keeps the backoff as a pass does: a failed attempt starts it, and while it runs a note the
   * API was away for answers `offline` at once, with no request.
   *
   * Trap: each attempt writes the note's sync state (`syncing`, then `synced`, `offline` or
   * `saved_locally`), and each write emits `NotesStore.onNoteChanged`. A caller that flushes on
   * that event (NotesGenerator's re-check, M4-T23) is fed by its own flush: a failed attempt
   * emits twice, so two more flushes, each emitting twice in turn. What ends that loop is the
   * backoff check in `sendNote` (`backing_off`): the next flush asks nothing and writes nothing.
   * Without it the caller sends `PUT`s back to back while the API is away, its queue doubling
   * every round. Keep the check, and still never re-run a flush for the events it caused.
   */
  async flushMeeting(meetingId: string): Promise<FlushMeetingResult> {
    for (const kind of NOTE_KINDS) {
      for (let attempt = 0; attempt < FLUSH_ATTEMPTS; attempt += 1) {
        const outcome = await this.serialised(meetingId, kind, () =>
          this.syncNote(meetingId, kind),
        );
        if (outcome === 'offline' || outcome === 'refused') this.backOff();
        const cause = flushCause(outcome);
        if (cause !== null) return { ok: false, cause };
        if (outcome !== 'behind') break;
      }
    }
    const notes = this.options.store.getNotes(meetingId);
    return {
      ok: true,
      userNotesVersion: notes.user?.baseVersion ?? 0,
      aiBaseVersion: notes.ai?.baseVersion ?? 0,
    };
  }

  // scheduling -----------------------------------------------------------------------------------

  /** 1.5 s after the last save, or when the backoff ends, whichever is later. */
  private afterSave(): void {
    if (!this.running) return;
    this.scheduleAt(Math.max(this.nowMs() + this.debounceMs, this.retryAtMs));
  }

  /** A pass as soon as the backoff allows, unless one is already due. */
  private soon(): void {
    if (!this.running || this.timer !== null) return;
    this.scheduleAt(Math.max(this.nowMs(), this.retryAtMs));
  }

  private scheduleAt(atMs: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        // Never rejects: pass() logs a failure and schedules the retry.
        void this.pass();
      },
      Math.max(0, atMs - this.nowMs()),
    );
  }

  /**
   * Runs inside the uploader's status emit: a throw here would fail the uploader's tick, so it is
   * logged instead, and the next status event or save tries again.
   */
  private meetingsChanged(): void {
    try {
      // Ids only, read in the database: this runs every 2 s. A pass only when a waiting meeting
      // may take its notes now; one still pending or stranded would make a pass that does nothing.
      // Checked here, on the event, not in the pass that follows: waitsForMeeting un-strands a
      // meeting it sees pending, and by the pass the uploader may have created it again, so a
      // stranded meeting never seen pending would wait for good.
      const ready = this.options.store
        .listWaitingMeetingIds()
        .some((meetingId) => !this.waitsForMeeting(meetingId));
      if (ready) this.soon();
    } catch (error) {
      this.options.logger.error('notes sync could not check waiting notes', {
        error: errorMessage(error),
      });
    }
  }

  /** One attempt at every dirty note, one pass at a time. Never rejects. */
  private async pass(): Promise<void> {
    if (!this.running) return;
    if (this.passing) {
      this.passDue = true;
      return;
    }
    this.passing = true;
    let failed = false;
    try {
      for (const note of this.options.store.listDirtyNotes()) {
        const outcome = await this.serialised(note.meetingId, note.kind, () =>
          this.syncNote(note.meetingId, note.kind),
        );
        // `backing_off`: a flushMeeting failed while this pass ran; the note goes at the retry.
        if (outcome === 'offline' || outcome === 'refused' || outcome === 'backing_off') {
          failed = true;
        }
      }
    } catch (error) {
      failed = true;
      this.options.logger.error('notes sync failed', { error: errorMessage(error) });
    } finally {
      this.passing = false;
    }
    const due = this.passDue;
    this.passDue = false;
    // Stopped (quit) while a request was out: no retry, and the store may be closed.
    if (this.stopped) return;
    if (!failed) {
      this.failures = 0;
      this.retryAtMs = 0;
      if (due) this.soon();
      return;
    }
    // A failure drops a pass that came due: the retry is a pass over every dirty note.
    this.backOff();
  }

  /**
   * After a failed attempt: the next waits 2 s, doubling to 30 s, and a pass runs then. The wait
   * doubles once per window, not once per failed attempt, so a flushMeeting and the pass that both
   * fail inside one window count once.
   */
  private backOff(): void {
    const nowMs = this.nowMs();
    if (nowMs >= this.retryAtMs) {
      this.failures += 1;
      const delayMs = Math.min(this.maxBackoffMs, this.firstRetryMs * 2 ** (this.failures - 1));
      this.retryAtMs = nowMs + delayMs;
      this.options.logger.warn('notes upload failed, backing off', {
        failures: this.failures,
        delayMs,
      });
    }
    // Before start() (a flush at launch), start() schedules the pass, at the end of the wait.
    if (this.running) this.scheduleAt(this.retryAtMs);
  }

  // one note -------------------------------------------------------------------------------------

  /** Run `work` after every earlier attempt at the same note has finished. */
  private serialised<T>(meetingId: string, kind: NoteKind, work: () => T | Promise<T>): Promise<T> {
    const key = `${meetingId}/${kind}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(work);
    // The queue's tail never rejects; the caller of `next` handles its failure.
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return next;
  }

  /** One attempt at one note. Only call it through `serialised`. */
  private async syncNote(meetingId: string, kind: NoteKind): Promise<SyncOutcome> {
    // Queued behind a request that was out at stop(): the quit hook may have closed the store.
    // A function of its own: in one body, TypeScript would hold `this.stopped` false across the
    // awaits in sendNote, and the lint would call the checks after them unnecessary. They are
    // not: stop() runs while a request is out.
    if (this.stopped) return 'stopped';
    return this.sendNote(meetingId, kind);
  }

  private async sendNote(meetingId: string, kind: NoteKind): Promise<SyncOutcome> {
    const { store, api } = this.options;
    const note = store.getNote(meetingId, kind);
    if (note === null) return 'clean';
    if (note.conflictCopy !== null) return 'conflict';
    if (!note.dirty) return 'clean';
    if (this.waitsForMeeting(meetingId)) {
      store.setSyncState(meetingId, kind, 'waiting_for_meeting');
      return 'meeting';
    }
    // Asked nothing, and written nothing: see the trap on flushMeeting before changing this.
    if (note.sync === 'offline' && this.nowMs() < this.retryAtMs) return 'backing_off';
    const revisionId = note.revisionId;
    if (revisionId === null) {
      // notes.sqlite's CHECK refuses a dirty row without a revision; reaching here is a bug.
      throw new Error(`the dirty ${kind} notes of meeting ${meetingId} carry no revision`);
    }
    store.setSyncState(meetingId, kind, 'syncing');
    try {
      const stored = await api.putNote(meetingId, kind, {
        doc: note.doc,
        baseVersion: note.baseVersion,
        revisionId,
      });
      if (this.stopped) return 'stopped';
      return store.markSynced(meetingId, kind, revisionId, stored).dirty ? 'behind' : 'synced';
    } catch (error) {
      if (this.stopped) return 'stopped';
      if (error instanceof ApiError && error.status === 409) {
        return await this.takeServerNote(meetingId, kind);
      }
      return this.requestFailed(meetingId, kind, error);
    }
  }

  /**
   * After a `409`: the server holds a version the local doc does not build on. Its doc is taken,
   * and a dirty local doc becomes the conflict copy.
   */
  private async takeServerNote(meetingId: string, kind: NoteKind): Promise<SyncOutcome> {
    const { store, api, logger } = this.options;
    let server: ServerNotes;
    try {
      server = await api.getNotes(meetingId);
    } catch (error) {
      if (this.stopped) return 'stopped';
      return this.requestFailed(meetingId, kind, error);
    }
    if (this.stopped) return 'stopped';
    const serverNote = server[kind];
    if (serverNote !== null) {
      const note = store.applyServerNote(meetingId, serverNote);
      if (note.conflictCopy !== null) {
        logger.info('notes conflict: the server holds a newer version', {
          meetingId,
          kind,
          version: serverNote.version,
        });
        return 'conflict';
      }
      if (!note.dirty) return 'synced';
    }
    // Still dirty on the version the server holds: the 409 was about something else, such as an
    // AI notes PUT while a notes run writes them. Retried with the backoff.
    logger.warn('notes upload refused with a conflict the server copy does not explain', {
      meetingId,
      kind,
      serverVersion: serverNote?.version ?? null,
    });
    store.setSyncState(meetingId, kind, 'saved_locally');
    return 'refused';
  }

  private requestFailed(meetingId: string, kind: NoteKind, error: unknown): SyncOutcome {
    const { store, meetings, logger } = this.options;
    // Not an answer from the API: a bug or a store failure, for the caller to report.
    if (!(error instanceof ApiError)) throw error;
    if (error.isNotFound) {
      // Never create it here (see the class comment): the uploader takes it back and creates it.
      this.options.onMeetingMissing(meetingId);
      const state = meetings.remoteState(meetingId);
      // Neither roger.sqlite nor Postgres holds the meeting: CaptureService or the uploader
      // discarded it as empty (hasNotes ignores the empty paragraph a blur saves). Nothing the
      // user wrote is lost; kept, the note would wait for good and go again at every launch.
      if (state === null && store.deleteNoteIfEmpty(meetingId, kind)) {
        logger.info('empty notes of a discarded meeting deleted', { meetingId, kind });
        return 'clean';
      }
      store.setSyncState(meetingId, kind, 'waiting_for_meeting');
      if (state !== 'pending') {
        this.stranded.add(meetingId);
        logger.warn('notes wait for a meeting the uploader did not take back', {
          meetingId,
          kind,
        });
      }
      return 'meeting';
    }
    if (error.status === 0 || error.status >= 500) {
      store.setSyncState(meetingId, kind, 'offline');
      // The pass logs the backoff once; this line names the note.
      logger.debug('notes upload failed: API away', { meetingId, kind, code: error.code });
      return 'offline';
    }
    logger.error('notes upload refused', {
      meetingId,
      kind,
      status: error.status,
      code: error.code,
      error: error.message,
    });
    store.setSyncState(meetingId, kind, 'saved_locally');
    return 'refused';
  }

  private waitsForMeeting(meetingId: string): boolean {
    const state = this.options.meetings.remoteState(meetingId);
    if (this.stranded.has(meetingId)) {
      if (state !== 'pending') return true;
      // The uploader holds it now: the pending rule below takes over.
      this.stranded.delete(meetingId);
    }
    return state === 'pending';
  }

  private nowMs(): number {
    return this.clock().getTime();
  }
}

function flushCause(outcome: SyncOutcome): 'meeting' | 'offline' | 'conflict' | null {
  switch (outcome) {
    case 'clean':
    case 'synced':
    case 'behind':
      return null;
    case 'meeting':
    case 'conflict':
      return outcome;
    case 'offline':
    case 'refused':
    case 'backing_off':
    case 'stopped':
      return 'offline';
  }
}
