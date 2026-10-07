import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noteSaveBase } from '../../shared/ipc/notes';
import type { Note, NoteDoc, NoteKind } from '../../shared/notes';
import { ApiError } from '../api/http';
import type { NotesSyncApi, PutNoteRequest, ServerNotes } from '../api/notesClient';
import { createLogger, type Logger } from '../logger';
import type { RemoteState } from '../store/TranscriptStore';
import { NotesSync, type MeetingUploadState } from './NotesSync';
import { SqliteNotesStore } from './SqliteNotesStore';

const MEETING = '0b8e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_MEETING = '5f4e3d2c-1b0a-4f9e-8d7c-6b5a4f3e2d1c';
const T0 = Date.parse('2026-10-06T10:00:00.000Z');

const silentLogger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

function paragraphs(...lines: string[]): NoteDoc {
  return {
    type: 'doc',
    content: lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
  };
}

function serverNote(kind: NoteKind, version: number, doc: NoteDoc): Note {
  return {
    kind,
    doc,
    version,
    templateId: null,
    lastRunId: null,
    generatedVersion: null,
    updatedAt: '2026-10-06T09:00:00Z',
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * The notes routes as the API answers them (docs/api-contract.md, Notes): a `PUT` on a stale base
 * version is a `409`, the same revision again is the stored note, a meeting Postgres does not hold
 * is a `404`. It has no way to create a meeting: only the uploader does that.
 */
class FakeNotesApi implements NotesSyncApi {
  readonly calls: string[] = [];
  down = false;
  /**
   * Every PUT answers this long after it went out: a slow network, or with `down`, a request that
   * hangs until http.ts's 10 s timeout fails it.
   */
  answerAfterMs = 0;
  readonly missing = new Set<string>();
  private readonly stored = new Map<string, { note: Note; revisionId: string | null }>();
  private gate: Promise<void> | null = null;

  seed(meetingId: string, note: Note): void {
    this.stored.set(`${meetingId}/${note.kind}`, { note, revisionId: null });
  }

  note(meetingId: string, kind: NoteKind): Note | null {
    return this.stored.get(`${meetingId}/${kind}`)?.note ?? null;
  }

  /**
   * Hold the answer to the next PUT until the returned deferred resolves. The server has stored
   * the doc by then: the answer is on its way, and a GET in the meantime reads the new version.
   */
  holdNextPut(): Deferred {
    const hold = deferred();
    this.gate = hold.promise;
    return hold;
  }

  puts(): string[] {
    return this.calls.filter((call) => call.startsWith('PUT'));
  }

  getNotes(meetingId: string): Promise<ServerNotes> {
    this.calls.push(`GET ${meetingId}`);
    this.refuse(meetingId, 'GET');
    return Promise.resolve({ user: this.note(meetingId, 'user'), ai: this.note(meetingId, 'ai') });
  }

  async putNote(meetingId: string, kind: NoteKind, request: PutNoteRequest): Promise<Note> {
    this.calls.push(
      `PUT ${meetingId}/${kind} base=${request.baseVersion} revision=${request.revisionId}`,
    );
    const gate = this.gate;
    this.gate = null;
    if (this.answerAfterMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.answerAfterMs));
    }
    const note = this.store(meetingId, kind, request);
    if (gate !== null) await gate;
    return note;
  }

  private store(meetingId: string, kind: NoteKind, request: PutNoteRequest): Note {
    this.refuse(meetingId, 'PUT');
    const key = `${meetingId}/${kind}`;
    const current = this.stored.get(key);
    if (current?.revisionId === request.revisionId) return current.note;
    const version = current?.note.version ?? 0;
    if (request.baseVersion !== version) {
      throw new ApiError(409, 'conflict', `Note version ${version} is stored`);
    }
    const note = serverNote(kind, version + 1, request.doc);
    this.stored.set(key, { note, revisionId: request.revisionId });
    return note;
  }

  private refuse(meetingId: string, method: string): void {
    if (this.down) {
      throw new ApiError(0, 'network_error', `${method} /v1/meetings/${meetingId}/notes failed`);
    }
    if (this.missing.has(meetingId)) {
      throw new ApiError(404, 'not_found', `Meeting ${meetingId} not found`);
    }
  }
}

interface Harness {
  store: SqliteNotesStore;
  api: FakeNotesApi;
  sync: NotesSync;
  /** Where each meeting stands in roger.sqlite. */
  meetings: Map<string, RemoteState>;
  /** An uploader status event. */
  uploaderStatus: () => void;
  onMeetingMissing: ReturnType<typeof vi.fn<(meetingId: string) => void>>;
}

function harness(
  options: {
    store?: SqliteNotesStore;
    onMeetingMissing?: (meetingId: string) => void;
    logger?: Logger;
  } = {},
): Harness {
  let revision = 0;
  const store =
    options.store ?? new SqliteNotesStore(':memory:', { newRevisionId: () => `rev-${++revision}` });
  const api = new FakeNotesApi();
  const meetings = new Map<string, RemoteState>([
    [MEETING, 'created'],
    [OTHER_MEETING, 'created'],
  ]);
  const listeners = new Set<() => void>();
  const uploadState: MeetingUploadState = {
    remoteState: (meetingId) => meetings.get(meetingId) ?? null,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const onMeetingMissing = vi.fn<(meetingId: string) => void>(options.onMeetingMissing);
  const sync = new NotesSync({
    store,
    api,
    meetings: uploadState,
    onMeetingMissing,
    logger: options.logger ?? silentLogger,
  });
  return {
    store,
    api,
    sync,
    meetings,
    uploaderStatus: () => {
      for (const listener of listeners) listener();
    },
    onMeetingMissing,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NotesSync: uploads', () => {
  it('coalesces rapid saves into one PUT', async () => {
    const { api, store, sync } = harness();
    sync.start();

    for (let index = 1; index <= 5; index += 1) {
      sync.save(MEETING, 'user', paragraphs(`line ${index}`));
      await vi.advanceTimersByTimeAsync(300);
    }
    // 1.5 s after the last save, not after the first.
    await vi.advanceTimersByTimeAsync(1_199);
    expect(api.puts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(api.puts()).toEqual([`PUT ${MEETING}/user base=0 revision=rev-5`]);
    expect(api.note(MEETING, 'user')?.doc).toEqual(paragraphs('line 5'));
    expect(store.getNote(MEETING, 'user')).toMatchObject({
      dirty: false,
      baseVersion: 1,
      revisionId: 'rev-5',
      sync: 'synced',
    });
    sync.stop();
  });

  it('clears dirty only when no newer local revision arrived', async () => {
    const { api, store, sync } = harness();
    sync.start();
    const hold = api.holdNextPut();

    sync.save(MEETING, 'user', paragraphs('A'));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(store.getNote(MEETING, 'user')?.sync).toBe('syncing');
    // Typed while the PUT of rev-1 is out.
    sync.save(MEETING, 'user', paragraphs('A', 'B'));
    hold.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getNote(MEETING, 'user')).toMatchObject({
      revisionId: 'rev-2',
      dirty: true,
      baseVersion: 1,
      sync: 'saved_locally',
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(api.puts()).toEqual([
      `PUT ${MEETING}/user base=0 revision=rev-1`,
      `PUT ${MEETING}/user base=1 revision=rev-2`,
    ]);
    expect(store.getNote(MEETING, 'user')).toMatchObject({ dirty: false, baseVersion: 2 });
    expect(api.note(MEETING, 'user')?.doc).toEqual(paragraphs('A', 'B'));
    sync.stop();
  });

  it('on 409 loads the server doc and keeps the local one as a conflict copy', async () => {
    const { api, store, sync } = harness();
    store.applyServerNote(MEETING, serverNote('user', 1, paragraphs('Base')));
    // Written elsewhere since: the server holds version 2.
    api.seed(MEETING, serverNote('user', 2, paragraphs('Theirs')));
    sync.start();

    sync.save(MEETING, 'user', paragraphs('Mine'));
    await vi.advanceTimersByTimeAsync(1_500);

    expect(api.calls).toEqual([`PUT ${MEETING}/user base=1 revision=rev-1`, `GET ${MEETING}`]);
    expect(store.getNote(MEETING, 'user')).toMatchObject({
      doc: paragraphs('Theirs'),
      conflictCopy: paragraphs('Mine'),
      dirty: false,
      baseVersion: 2,
      sync: 'conflict',
    });
    // Nothing goes up until the user picks, edits during the conflict included.
    sync.save(MEETING, 'user', paragraphs('Theirs', 'more'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.puts()).toHaveLength(1);

    // "Use mine" uploads the copy over the server's version.
    sync.resolveConflict(MEETING, 'user', 'mine');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(api.note(MEETING, 'user')).toMatchObject({ version: 3, doc: paragraphs('Mine') });
    expect(store.getNote(MEETING, 'user')).toMatchObject({ sync: 'synced', baseVersion: 3 });
    sync.stop();
  });

  it("keeps typing built on the doc a 409 replaced as the conflict copy, never over the server's", async () => {
    const { api, store, sync } = harness();
    const loaded = store.applyServerNote(MEETING, serverNote('user', 1, paragraphs('Base')));
    api.seed(MEETING, serverNote('user', 2, paragraphs('Theirs')));
    sync.start();
    sync.save(MEETING, 'user', paragraphs('Mine'), noteSaveBase(loaded));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(store.getNote(MEETING, 'user')?.sync).toBe('conflict');

    // The editor typed on before it showed the server's doc: its save still builds on version 1.
    const kept = sync.save(MEETING, 'user', paragraphs('Mine', 'more'), noteSaveBase(loaded));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(kept).toMatchObject({
      doc: paragraphs('Theirs'),
      conflictCopy: paragraphs('Mine', 'more'),
      sync: 'conflict',
    });
    expect(api.note(MEETING, 'user')).toMatchObject({ version: 2, doc: paragraphs('Theirs') });
    expect(api.puts()).toHaveLength(1);
    sync.stop();
  });

  it('backs off and stays dirty while the API is down', async () => {
    const { api, store, sync } = harness();
    sync.start();
    api.down = true;

    sync.save(MEETING, 'user', paragraphs('Typed offline'));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(api.puts()).toHaveLength(1);
    expect(store.getNote(MEETING, 'user')).toMatchObject({ dirty: true, sync: 'offline' });

    // Retries at 2 s, 4 s, 8 s, 16 s, then every 30 s.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(api.puts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.puts()).toHaveLength(2);
    // A save during the backoff does not bring the next attempt forward, and stays offline.
    expect(sync.save(MEETING, 'user', paragraphs('Typed offline', 'more')).sync).toBe('offline');
    await vi.advanceTimersByTimeAsync(3_999);
    expect(api.puts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.puts()).toHaveLength(3);
    for (const [waitMs, attempts] of [
      [8_000, 4],
      [16_000, 5],
      [30_000, 6],
      [30_000, 7],
    ] as const) {
      await vi.advanceTimersByTimeAsync(waitMs);
      expect(api.puts()).toHaveLength(attempts);
    }
    expect(store.getNote(MEETING, 'user')).toMatchObject({ dirty: true, sync: 'offline' });

    api.down = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.puts()).toHaveLength(8);
    expect(store.getNote(MEETING, 'user')).toMatchObject({ dirty: false, sync: 'synced' });
    expect(api.note(MEETING, 'user')?.doc).toEqual(paragraphs('Typed offline', 'more'));

    // Healthy again: the next save goes 1.5 s after it, not on the backoff.
    sync.save(MEETING, 'user', paragraphs('Back online'));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(api.puts()).toHaveLength(9);
    sync.stop();
  });

  it('never runs two passes at once, so a slow failure still backs off', async () => {
    const { api, sync } = harness();
    api.down = true;
    api.answerAfterMs = 10_000;
    sync.start();

    sync.save(MEETING, 'user', paragraphs('Typed on bad wifi'));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(api.puts()).toHaveLength(1);
    // Saved again while that PUT hangs: its pass comes due at 6.5 s, with the first still out.
    await vi.advanceTimersByTimeAsync(3_500);
    sync.save(MEETING, 'user', paragraphs('Typed on bad wifi', 'more'));

    // The first fails at 11.5 s. The next PUT waits the 2 s backoff, not going out at once.
    await vi.advanceTimersByTimeAsync(6_500);
    expect(api.puts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(api.puts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.puts()).toHaveLength(2);
    // That one fails at 23.5 s; the next waits 4 s.
    await vi.advanceTimersByTimeAsync(13_999);
    expect(api.puts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.puts()).toHaveLength(3);
    sync.stop();
  });

  it('a pass that comes due while one runs goes as soon as it ends', async () => {
    const { api, store, sync } = harness();
    api.answerAfterMs = 10_000;
    sync.start();

    sync.save(MEETING, 'user', paragraphs('First'));
    await vi.advanceTimersByTimeAsync(1_500);
    sync.save(OTHER_MEETING, 'user', paragraphs('Second'));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(api.puts()).toEqual([`PUT ${MEETING}/user base=0 revision=rev-1`]);

    // The first answers at 11.5 s, and the pass that came due at 3 s goes then (its 0 ms timer
    // waits 1 ms, as Node's does).
    await vi.advanceTimersByTimeAsync(8_501);
    expect(api.puts()).toEqual([
      `PUT ${MEETING}/user base=0 revision=rev-1`,
      `PUT ${OTHER_MEETING}/user base=0 revision=rev-2`,
    ]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.listDirtyNotes()).toEqual([]);
    sync.stop();
  });

  it('uploads dirty notes from a previous run on start', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'roger-notes-sync-')), 'notes.sqlite');
    const previous = new SqliteNotesStore(path, { newRevisionId: () => 'rev-before-quit' });
    previous.saveLocal(MEETING, 'user', paragraphs('Typed before quit'));
    previous.saveLocal(OTHER_MEETING, 'ai', paragraphs('Edited AI notes'));
    previous.close();

    const store = new SqliteNotesStore(path);
    const { api, sync } = harness({ store });
    sync.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.puts()).toEqual([
      `PUT ${MEETING}/user base=0 revision=rev-before-quit`,
      `PUT ${OTHER_MEETING}/ai base=0 revision=rev-before-quit`,
    ]);
    expect(store.listDirtyNotes()).toEqual([]);
    sync.stop();
    store.close();
  });

  it('after stop, nothing touches the closed store, though more notes were dirty', async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: 'warn',
      format: 'json',
      sink: (line) => lines.push(line),
    });
    const { api, store, sync } = harness({ logger });
    sync.start();
    sync.save(MEETING, 'user', paragraphs('First'));
    sync.save(OTHER_MEETING, 'user', paragraphs('Second'));
    const hold = api.holdNextPut();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(api.puts()).toHaveLength(1);
    // Queued behind the PUT that is out, on the same note.
    const flushed = sync.flushMeeting(MEETING);

    // The quit hook: stop the sync, then close notes.sqlite (M4-T16).
    sync.stop();
    store.close();
    hold.resolve();

    await expect(flushed).resolves.toEqual({ ok: false, cause: 'offline' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.puts()).toHaveLength(1);
    expect(lines).toEqual([]);
  });
});

describe('NotesSync: meetings not in Postgres', () => {
  it('waits while its meeting is pending and sends after the uploader creates it', async () => {
    const { api, store, sync, meetings, uploaderStatus } = harness();
    meetings.set(MEETING, 'pending');
    sync.start();

    sync.save(MEETING, 'user', paragraphs('Agenda'));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(store.getNote(MEETING, 'user')).toMatchObject({
      dirty: true,
      sync: 'waiting_for_meeting',
    });
    // A save keeps saying why it waits.
    expect(sync.save(MEETING, 'user', paragraphs('Agenda', 'pricing')).sync).toBe(
      'waiting_for_meeting',
    );
    await vi.advanceTimersByTimeAsync(1_500);
    // The uploader's status events, every 2 s, read no doc and start no pass while it is pending.
    const readDocs = vi.spyOn(store, 'listDirtyNotes');
    for (let tick = 0; tick < 30; tick += 1) {
      uploaderStatus();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(readDocs).not.toHaveBeenCalled();
    expect(api.calls).toEqual([]);

    meetings.set(MEETING, 'created');
    uploaderStatus();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.puts()).toEqual([`PUT ${MEETING}/user base=0 revision=rev-2`]);
    expect(store.getNote(MEETING, 'user')).toMatchObject({ dirty: false, sync: 'synced' });
    sync.stop();
  });

  it('on 404 stays dirty, shows waiting and asks the uploader to re-create the meeting, never creating it', async () => {
    let meetings: Map<string, RemoteState> | null = null;
    // The uploader's own repair (TranscriptUploader.markMeetingMissing): back to pending.
    const h = harness({ onMeetingMissing: (meetingId) => meetings?.set(meetingId, 'pending') });
    meetings = h.meetings;
    const { api, store, sync, uploaderStatus, onMeetingMissing } = h;
    // A reset dev database: roger.sqlite says created, Postgres does not hold the meeting.
    api.missing.add(MEETING);
    sync.start();

    sync.save(MEETING, 'user', paragraphs('Ask about pricing'));
    await vi.advanceTimersByTimeAsync(1_500);

    expect(onMeetingMissing).toHaveBeenCalledExactlyOnceWith(MEETING);
    expect(store.getNote(MEETING, 'user')).toMatchObject({
      dirty: true,
      sync: 'waiting_for_meeting',
    });
    uploaderStatus();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.puts()).toHaveLength(1);

    // The uploader re-creates it.
    api.missing.delete(MEETING);
    h.meetings.set(MEETING, 'created');
    uploaderStatus();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getNote(MEETING, 'user')).toMatchObject({ dirty: false, sync: 'synced' });
    // Only the notes routes were called: NotesSync has no way to create a meeting.
    expect(api.calls.every((call) => call.startsWith('PUT') || call.startsWith('GET'))).toBe(true);
    expect(api.puts()).toHaveLength(2);
    sync.stop();
  });

  it('a meeting the uploader did not take back waits without re-sending', async () => {
    // roger.sqlite does not know the meeting, so the uploader's repair changes nothing.
    const { api, store, sync, meetings, uploaderStatus, onMeetingMissing } = harness();
    meetings.delete(MEETING);
    api.missing.add(MEETING);
    sync.start();

    // Text the user wrote: never deleted, unlike an empty note (below).
    sync.save(MEETING, 'user', paragraphs('Orphaned'));
    await vi.advanceTimersByTimeAsync(1_500);
    const readDocs = vi.spyOn(store, 'listDirtyNotes');
    for (let tick = 0; tick < 10; tick += 1) {
      uploaderStatus();
      await vi.advanceTimersByTimeAsync(2_000);
    }

    expect(readDocs).not.toHaveBeenCalled();
    expect(onMeetingMissing).toHaveBeenCalledOnce();
    expect(api.puts()).toHaveLength(1);
    expect(store.getNote(MEETING, 'user')).toMatchObject({
      dirty: true,
      sync: 'waiting_for_meeting',
    });

    // Once the uploader holds it as pending, then creates it, the note follows.
    meetings.set(MEETING, 'pending');
    uploaderStatus();
    api.missing.delete(MEETING);
    meetings.set(MEETING, 'created');
    uploaderStatus();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getNote(MEETING, 'user')).toMatchObject({ dirty: false, sync: 'synced' });
    sync.stop();
  });

  it('deletes the empty notes of a meeting discarded as empty, after one 404', async () => {
    const { api, store, sync, meetings, uploaderStatus, onMeetingMissing } = harness();
    meetings.set(MEETING, 'pending');
    // Never created: Postgres hears of a meeting only once it has content.
    api.missing.add(MEETING);
    sync.start();
    // The notepad was focused, and its blur saved an empty paragraph.
    sync.save(MEETING, 'user', { type: 'doc', content: [{ type: 'paragraph' }] });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(store.getNote(MEETING, 'user')?.sync).toBe('waiting_for_meeting');

    // Stop: nobody spoke and hasNotes is false, so CaptureService discards the meeting (M4-T22).
    meetings.delete(MEETING);
    uploaderStatus();
    await vi.advanceTimersByTimeAsync(0);

    expect(api.puts()).toHaveLength(1);
    expect(onMeetingMissing).toHaveBeenCalledExactlyOnceWith(MEETING);
    expect(store.getNote(MEETING, 'user')).toBeNull();
    // Nothing waits any more: no request, at the next launch either.
    for (let tick = 0; tick < 10; tick += 1) {
      uploaderStatus();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(store.listDirtyNotes()).toEqual([]);
    expect(api.puts()).toHaveLength(1);
    sync.stop();
  });
});

describe('NotesSync: flushMeeting', () => {
  it('flushMeeting uploads dirty user and AI notes and returns both versions', async () => {
    const { api, store, sync } = harness();
    store.applyServerNote(MEETING, serverNote('ai', 2, paragraphs('Generated')));
    api.seed(MEETING, serverNote('ai', 2, paragraphs('Generated')));
    sync.save(MEETING, 'user', paragraphs('Typed in the last second'));
    sync.save(MEETING, 'ai', paragraphs('Generated', 'fixed'));

    // At once: no wait for the 1.5 s after the last save.
    await expect(sync.flushMeeting(MEETING)).resolves.toEqual({
      ok: true,
      userNotesVersion: 1,
      aiBaseVersion: 3,
    });
    expect(api.puts()).toEqual([
      `PUT ${MEETING}/user base=0 revision=rev-1`,
      `PUT ${MEETING}/ai base=2 revision=rev-2`,
    ]);
    expect(store.listDirtyNotes()).toEqual([]);

    // Clean notes need no request; a doc that does not exist is version 0.
    store.applyServerNote(OTHER_MEETING, serverNote('user', 4, paragraphs('Synced')));
    await expect(sync.flushMeeting(OTHER_MEETING)).resolves.toEqual({
      ok: true,
      userNotesVersion: 4,
      aiBaseVersion: 0,
    });
    expect(api.puts()).toHaveLength(2);
  });

  it('flushMeeting waits for a PUT already out, then sends what was typed after it', async () => {
    const { api, store, sync } = harness();
    sync.start();
    const hold = api.holdNextPut();
    sync.save(MEETING, 'user', paragraphs('A'));
    await vi.advanceTimersByTimeAsync(1_500);
    sync.save(MEETING, 'user', paragraphs('A', 'B'));

    const flushed = sync.flushMeeting(MEETING);
    hold.resolve();

    await expect(flushed).resolves.toEqual({ ok: true, userNotesVersion: 2, aiBaseVersion: 0 });
    expect(api.note(MEETING, 'user')?.doc).toEqual(paragraphs('A', 'B'));
    expect(store.getNote(MEETING, 'user')?.dirty).toBe(false);
    sync.stop();
  });

  it('flushMeeting sends again what was typed while its own PUT was out', async () => {
    const { api, store, sync } = harness();
    sync.save(MEETING, 'user', paragraphs('A'));
    const hold = api.holdNextPut();

    const flushed = sync.flushMeeting(MEETING);
    await vi.advanceTimersByTimeAsync(0);
    sync.save(MEETING, 'user', paragraphs('A', 'B'));
    hold.resolve();

    await expect(flushed).resolves.toEqual({ ok: true, userNotesVersion: 2, aiBaseVersion: 0 });
    expect(api.puts()).toEqual([
      `PUT ${MEETING}/user base=0 revision=rev-1`,
      `PUT ${MEETING}/user base=1 revision=rev-2`,
    ]);
    expect(store.getNote(MEETING, 'user')?.dirty).toBe(false);
  });

  it('flushMeeting says why the notes cannot upload', async () => {
    const { api, store, sync, meetings } = harness();

    meetings.set(MEETING, 'pending');
    sync.save(MEETING, 'user', paragraphs('Waiting'));
    await expect(sync.flushMeeting(MEETING)).resolves.toEqual({ ok: false, cause: 'meeting' });

    meetings.set(MEETING, 'created');
    api.down = true;
    await expect(sync.flushMeeting(MEETING)).resolves.toEqual({ ok: false, cause: 'offline' });
    expect(store.getNote(MEETING, 'user')?.sync).toBe('offline');
    // Until the backoff ends, a flush answers at once, with no request.
    api.down = false;
    await expect(sync.flushMeeting(MEETING)).resolves.toEqual({ ok: false, cause: 'offline' });
    expect(api.puts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);

    api.seed(MEETING, serverNote('user', 5, paragraphs('Theirs')));
    await expect(sync.flushMeeting(MEETING)).resolves.toEqual({ ok: false, cause: 'conflict' });
    // A conflict holds the run back even once nothing is dirty: the user picks first.
    expect(store.getNote(MEETING, 'user')?.dirty).toBe(false);
    await expect(sync.flushMeeting(MEETING)).resolves.toEqual({ ok: false, cause: 'conflict' });
  });

  it('flushing on every note change while the API is down sends one PUT per backoff window', async () => {
    const { api, store, sync } = harness();
    sync.start();
    api.down = true;
    sync.save(MEETING, 'user', paragraphs('Typed after Stop'));
    // A re-check that flushes on every change (NotesGenerator, M4-T23) is fed by its own flush:
    // each attempt writes syncing, then offline. Capped, so a loop ends the test.
    let flushes = 0;
    store.onNoteChanged(() => {
      if (flushes >= 50) return;
      flushes += 1;
      void sync.flushMeeting(MEETING);
    });

    await expect(sync.flushMeeting(MEETING)).resolves.toEqual({ ok: false, cause: 'offline' });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.puts()).toHaveLength(1);
    // The two flushes its own events started asked nothing: the backoff had begun.
    expect(flushes).toBe(2);

    // The pass waits for that backoff too, not the 1.5 s after the save, then 4 s after it fails.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(api.puts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.puts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(api.puts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.puts()).toHaveLength(3);
    expect(flushes).toBe(6);
    sync.stop();
  });
});

describe('NotesSync: pullMeeting', () => {
  it("takes the server's notes on load and keeps a dirty local doc", async () => {
    const { api, store, sync } = harness();
    store.applyServerNote(MEETING, serverNote('user', 1, paragraphs('Base')));
    sync.save(MEETING, 'user', paragraphs('Base', 'offline edit'));
    api.seed(MEETING, serverNote('user', 1, paragraphs('Base')));
    api.seed(MEETING, serverNote('ai', 3, paragraphs('Generated')));

    const notes = await sync.pullMeeting(MEETING);

    expect(notes.user).toMatchObject({ doc: paragraphs('Base', 'offline edit'), dirty: true });
    expect(notes.ai).toMatchObject({
      doc: paragraphs('Generated'),
      baseVersion: 3,
      sync: 'synced',
    });
  });

  it('keeps the local copy of a meeting Postgres does not hold yet', async () => {
    const { api, sync, meetings } = harness();
    sync.save(MEETING, 'user', paragraphs('Local only'));
    meetings.set(MEETING, 'pending');

    await expect(sync.pullMeeting(MEETING)).resolves.toMatchObject({
      user: { doc: paragraphs('Local only') },
      ai: null,
    });
    expect(api.calls).toEqual([]);

    meetings.set(MEETING, 'created');
    api.missing.add(MEETING);
    await expect(sync.pullMeeting(MEETING)).resolves.toMatchObject({
      user: { doc: paragraphs('Local only') },
    });

    api.missing.delete(MEETING);
    api.down = true;
    await expect(sync.pullMeeting(MEETING)).rejects.toMatchObject({ code: 'network_error' });
  });

  it('a load that crosses an upload is not a conflict', async () => {
    const { api, store, sync } = harness();
    sync.start();
    const hold = api.holdNextPut();
    sync.save(MEETING, 'user', paragraphs('A'));
    await vi.advanceTimersByTimeAsync(1_500);
    // Typed while the answer to the PUT of rev-1 is on its way; the load reads the version that
    // PUT made, before the answer arrives.
    sync.save(MEETING, 'user', paragraphs('A', 'B'));
    const pulled = sync.pullMeeting(MEETING);
    hold.resolve();

    await expect(pulled).resolves.toMatchObject({
      user: { doc: paragraphs('A', 'B'), conflictCopy: null, dirty: true, baseVersion: 1 },
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(store.getNote(MEETING, 'user')).toMatchObject({ sync: 'synced', baseVersion: 2 });
    sync.stop();
  });
});
