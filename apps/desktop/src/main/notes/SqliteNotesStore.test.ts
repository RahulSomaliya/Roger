import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { noteSaveBase } from '../../shared/ipc/notes';
import type { LocalNote, Note, NoteDoc, NoteKind } from '../../shared/notes';
import type { StoredPendingGenerate } from './NotesStore';
import { SqliteNotesStore } from './SqliteNotesStore';

const MEETING = '0b8e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_MEETING = '5f4e3d2c-1b0a-4f9e-8d7c-6b5a4f3e2d1c';
const RUN = '7f3c9d1e-2a4b-4c6d-8e0f-1a2b3c4d5e6f';
const SEGMENT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const T0 = Date.parse('2026-10-06T10:00:00.000Z');

function paragraphs(...lines: string[]): NoteDoc {
  return {
    type: 'doc',
    content: lines.map((text) =>
      text === ''
        ? { type: 'paragraph' }
        : { type: 'paragraph', content: [{ type: 'text', text }] },
    ),
  };
}

function serverNote(
  kind: NoteKind,
  version: number,
  doc: NoteDoc,
  extra: Partial<Note> = {},
): Note {
  return {
    kind,
    doc,
    version,
    templateId: null,
    lastRunId: null,
    generatedVersion: null,
    updatedAt: '2026-10-06T09:00:00Z',
    ...extra,
  };
}

/** A store with a clock that moves 1 s per read and revision ids `rev-1`, `rev-2`, ... */
function openStore(path = ':memory:'): SqliteNotesStore {
  let tick = 0;
  let revision = 0;
  return new SqliteNotesStore(path, {
    clock: () => new Date(T0 + 1_000 * tick++),
    newRevisionId: () => `rev-${++revision}`,
  });
}

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'roger-notes-')), 'notes.sqlite');
}

describe('SqliteNotesStore: saves', () => {
  it('a save is on disk before save() returns and survives reopening', () => {
    const path = tempPath();
    const store = openStore(path);

    const saved = store.saveLocal(MEETING, 'user', paragraphs('Ship beta Friday'));

    expect(saved).toEqual({
      meetingId: MEETING,
      kind: 'user',
      doc: paragraphs('Ship beta Friday'),
      revisionId: 'rev-1',
      dirty: true,
      baseVersion: 0,
      templateId: null,
      lastRunId: null,
      generatedVersion: null,
      conflictCopy: null,
      sync: 'saved_locally',
      updatedAt: '2026-10-06T10:00:00.000Z',
    } satisfies LocalNote);
    // Another connection sees the row while the store is still open: it was committed, not held
    // in a transaction or a buffer until close.
    const reader = new DatabaseSync(path);
    const row = reader
      .prepare('SELECT doc_json, revision_id, dirty FROM notes WHERE meeting_id = ? AND kind = ?')
      .get(MEETING, 'user');
    reader.close();
    expect(row).toEqual({
      doc_json: JSON.stringify(paragraphs('Ship beta Friday')),
      revision_id: 'rev-1',
      dirty: 1,
    });

    store.close();
    const reopened = openStore(path);
    expect(reopened.getNote(MEETING, 'user')).toEqual(saved);
    expect(reopened.listDirtyNotes()).toEqual([saved]);
    reopened.close();
  });

  it('a new save takes a new revision and keeps the version it builds on', () => {
    const store = openStore();
    store.applyServerNote(MEETING, serverNote('user', 3, paragraphs('A')));

    const first = store.saveLocal(MEETING, 'user', paragraphs('A', 'B'));
    const second = store.saveLocal(MEETING, 'user', paragraphs('A', 'B', 'C'));

    expect(first).toMatchObject({ revisionId: 'rev-1', baseVersion: 3, dirty: true });
    expect(second).toMatchObject({
      revisionId: 'rev-2',
      baseVersion: 3,
      dirty: true,
      doc: paragraphs('A', 'B', 'C'),
    });
    store.close();
  });

  it('a save keeps the reason a note cannot upload, and drops syncing and synced', () => {
    const store = openStore();
    store.saveLocal(MEETING, 'user', paragraphs('A'));

    store.setSyncState(MEETING, 'user', 'waiting_for_meeting');
    expect(store.saveLocal(MEETING, 'user', paragraphs('A', 'B')).sync).toBe('waiting_for_meeting');
    store.setSyncState(MEETING, 'user', 'offline');
    expect(store.saveLocal(MEETING, 'user', paragraphs('A', 'B')).sync).toBe('offline');
    store.setSyncState(MEETING, 'user', 'syncing');
    expect(store.saveLocal(MEETING, 'user', paragraphs('A', 'B')).sync).toBe('saved_locally');
    store.close();
  });

  it('refuses a doc the API would refuse, storing nothing', () => {
    const store = openStore();
    const badChip: NoteDoc = {
      type: 'doc',
      content: [{ type: 'citation', attrs: { segmentIds: [], startMs: 0, label: '00:00' } }],
    };

    expect(() => store.saveLocal(MEETING, 'ai', badChip)).toThrow(
      `note not saved for the ai notes of meeting ${MEETING}: a citation with bad attrs`,
    );
    expect(store.getNote(MEETING, 'ai')).toBeNull();
    store.close();
  });

  it('emits every change with the note as stored, and nothing when nothing changed', () => {
    const store = openStore();
    const seen: LocalNote[] = [];
    store.onNoteChanged((note) => seen.push(note));

    const saved = store.saveLocal(MEETING, 'user', paragraphs('A'));
    const syncing = store.setSyncState(MEETING, 'user', 'syncing');
    const synced = store.markSynced(
      MEETING,
      'user',
      'rev-1',
      serverNote('user', 1, paragraphs('A')),
    );
    store.applyServerNote(MEETING, serverNote('user', 1, paragraphs('A')));

    expect(seen).toEqual([saved, syncing, synced]);
    store.close();
  });
});

describe('SqliteNotesStore: server notes and conflicts', () => {
  it('load prefers a dirty local doc over the server copy', () => {
    const store = openStore();
    store.applyServerNote(MEETING, serverNote('user', 3, paragraphs('Server')));
    const dirty = store.saveLocal(MEETING, 'user', paragraphs('Server', 'typed offline'));

    // The load after a restart: the server still has version 3, which the local edit builds on.
    const loaded = store.applyServerNote(MEETING, serverNote('user', 3, paragraphs('Server')));
    expect(loaded).toEqual(dirty);
    expect(store.getNotes(MEETING)).toEqual({ meetingId: MEETING, user: dirty, ai: null });

    // An answer older than the local base (it raced a later PUT) changes nothing either.
    const stale = store.applyServerNote(MEETING, serverNote('user', 2, paragraphs('Older')));
    expect(stale).toEqual(dirty);
    store.close();
  });

  it('applyServerNote takes the server doc when clean and keeps a conflict copy when dirty', () => {
    const store = openStore();
    // No local copy: the server's note is taken as it is, clean.
    const first = store.applyServerNote(
      MEETING,
      serverNote('ai', 3, paragraphs('Generated'), {
        templateId: 'standup',
        lastRunId: RUN,
        generatedVersion: 3,
      }),
    );
    expect(first).toMatchObject({
      doc: paragraphs('Generated'),
      revisionId: null,
      dirty: false,
      baseVersion: 3,
      templateId: 'standup',
      lastRunId: RUN,
      generatedVersion: 3,
      conflictCopy: null,
      sync: 'synced',
    });

    // Clean and the server is newer: its doc replaces the local one.
    const clean = store.applyServerNote(MEETING, serverNote('ai', 4, paragraphs('Edited')));
    expect(clean).toMatchObject({ doc: paragraphs('Edited'), baseVersion: 4, sync: 'synced' });

    // Dirty and the server is newer: the server's doc is shown, the local one kept aside.
    store.saveLocal(MEETING, 'ai', paragraphs('Mine'));
    const conflict = store.applyServerNote(MEETING, serverNote('ai', 5, paragraphs('Theirs')));
    expect(conflict).toMatchObject({
      doc: paragraphs('Theirs'),
      revisionId: null,
      dirty: false,
      baseVersion: 5,
      conflictCopy: paragraphs('Mine'),
      sync: 'conflict',
    });
    expect(store.listDirtyNotes()).toEqual([]);
    store.close();
  });

  it('a newer server doc that says what the dirty local doc says is the local save coming back', () => {
    const store = openStore();
    store.applyServerNote(MEETING, serverNote('user', 1, paragraphs('A')));
    const saved = store.saveLocal(MEETING, 'user', {
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'B' }] }],
    });

    // Postgres `jsonb` reorders keys: the same doc comes back with its keys in another order.
    const same = store.applyServerNote(
      MEETING,
      serverNote('user', 2, {
        content: [{ content: [{ text: 'B', type: 'text' }], attrs: { level: 2 }, type: 'heading' }],
        type: 'doc',
      }),
    );

    expect(same).toMatchObject({
      revisionId: saved.revisionId,
      dirty: false,
      baseVersion: 2,
      conflictCopy: null,
      sync: 'synced',
    });
    store.close();
  });

  it('keeps a conflict copy until it is resolved', () => {
    const path = tempPath();
    const store = openStore(path);
    store.applyServerNote(MEETING, serverNote('user', 1, paragraphs('Base')));
    store.saveLocal(MEETING, 'user', paragraphs('Mine'));
    store.applyServerNote(MEETING, serverNote('user', 2, paragraphs('Theirs')));

    // A newer server doc while clean is taken; the copy stays.
    const newer = store.applyServerNote(MEETING, serverNote('user', 3, paragraphs('Theirs 2')));
    expect(newer).toMatchObject({ doc: paragraphs('Theirs 2'), conflictCopy: paragraphs('Mine') });
    // A save to the server's doc during the conflict: the copy stays, and so does the conflict.
    const edited = store.saveLocal(MEETING, 'user', paragraphs('Theirs 2', 'more'));
    expect(edited).toMatchObject({
      dirty: true,
      conflictCopy: paragraphs('Mine'),
      sync: 'conflict',
    });
    // Newer again while dirty and in conflict: nothing changes, no text is lost.
    expect(store.applyServerNote(MEETING, serverNote('user', 4, paragraphs('Theirs 3')))).toEqual(
      edited,
    );
    store.close();

    const reopened = openStore(path);
    expect(reopened.getNote(MEETING, 'user')).toEqual(edited);
    reopened.close();
  });

  it('resolving takes the copy back as a new revision, or drops it', () => {
    const store = openStore();
    for (const kind of ['user', 'ai'] as const) {
      store.applyServerNote(MEETING, serverNote(kind, 1, paragraphs('Base')));
      store.saveLocal(MEETING, kind, paragraphs('Mine'));
      store.applyServerNote(MEETING, serverNote(kind, 2, paragraphs('Theirs')));
    }

    const mine = store.resolveConflict(MEETING, 'user', 'mine');
    expect(mine).toMatchObject({
      doc: paragraphs('Mine'),
      conflictCopy: null,
      dirty: true,
      baseVersion: 2,
      sync: 'saved_locally',
    });
    expect(mine.revisionId).toMatch(/^rev-/);

    const theirs = store.resolveConflict(MEETING, 'ai', 'theirs');
    expect(theirs).toMatchObject({
      doc: paragraphs('Theirs'),
      conflictCopy: null,
      dirty: false,
      sync: 'synced',
    });

    expect(() => store.resolveConflict(MEETING, 'ai', 'mine')).toThrow(
      `no conflict to resolve on the ai notes of meeting ${MEETING}`,
    );
    expect(() => store.resolveConflict(OTHER_MEETING, 'user', 'theirs')).toThrow(
      `no conflict to resolve on the user notes of meeting ${OTHER_MEETING}`,
    );
    store.close();
  });

  it('markSynced clears dirty only for the revision it sent', () => {
    const store = openStore();
    store.saveLocal(MEETING, 'user', paragraphs('A'));
    store.saveLocal(MEETING, 'user', paragraphs('A', 'B'));

    // The PUT of rev-1 came back after rev-2 was saved: rev-2 still has to go, on version 1.
    const behind = store.markSynced(
      MEETING,
      'user',
      'rev-1',
      serverNote('user', 1, paragraphs('A')),
    );
    expect(behind).toMatchObject({
      revisionId: 'rev-2',
      doc: paragraphs('A', 'B'),
      dirty: true,
      baseVersion: 1,
      sync: 'saved_locally',
    });

    const done = store.markSynced(
      MEETING,
      'user',
      'rev-2',
      serverNote('user', 2, paragraphs('A', 'B')),
    );
    expect(done).toMatchObject({
      revisionId: 'rev-2',
      dirty: false,
      baseVersion: 2,
      sync: 'synced',
    });
    store.close();
  });
});

describe('SqliteNotesStore: the base a save builds on', () => {
  it("a save built on a doc main has replaced since becomes the conflict copy; the doc stays the server's", () => {
    const path = tempPath();
    const store = openStore(path);
    // The editor loaded version 2; a 409 (or a pull) then took version 3 from the server.
    const loaded = store.applyServerNote(MEETING, serverNote('user', 2, paragraphs('Agenda')));
    const theirs = store.applyServerNote(
      MEETING,
      serverNote('user', 3, paragraphs('Agenda', 'Their line')),
    );

    // Typing the editor sent before it had shown version 3: built on version 2.
    const kept = store.saveLocal(
      MEETING,
      'user',
      paragraphs('Agenda', 'My line'),
      noteSaveBase(loaded),
    );

    expect(kept).toEqual({
      ...theirs,
      conflictCopy: paragraphs('Agenda', 'My line'),
      sync: 'conflict',
      updatedAt: kept.updatedAt,
    } satisfies LocalNote);
    expect(kept.updatedAt > theirs.updatedAt).toBe(true);
    // Nothing to upload: the server holds the doc, and the typing waits for "Use mine".
    expect(store.listDirtyNotes()).toEqual([]);
    store.close();
    const reopened = openStore(path);
    expect(reopened.getNote(MEETING, 'user')).toEqual(kept);
    reopened.close();
  });

  it('a stale save replaces an older conflict copy: it holds the newer typing', () => {
    const store = openStore();
    const loaded = store.applyServerNote(MEETING, serverNote('user', 2, paragraphs('Agenda')));
    store.applyServerNote(MEETING, serverNote('user', 3, paragraphs('Theirs')));
    const base = noteSaveBase(loaded);
    store.saveLocal(MEETING, 'user', paragraphs('Agenda', 'my'), base);

    const newer = store.saveLocal(MEETING, 'user', paragraphs('Agenda', 'my line'), base);

    expect(newer).toMatchObject({
      doc: paragraphs('Theirs'),
      conflictCopy: paragraphs('Agenda', 'my line'),
      dirty: false,
      sync: 'conflict',
    });
    store.close();
  });

  it('never replaces a conflict copy that holds other typing: the save is held, past a quit', () => {
    const path = tempPath();
    const before = openStore(path);
    before.applyServerNote(MEETING, serverNote('user', 1, paragraphs('Base')));
    before.saveLocal(MEETING, 'user', paragraphs('Mine, from last week'));
    before.applyServerNote(MEETING, serverNote('user', 2, paragraphs('Theirs')));
    before.close();
    // A later launch: the editor shows version 2 with the old copy aside, and a newer version
    // arrives while its typing on version 2 is on its way.
    const store = openStore(path);
    const loaded = store.getNote(MEETING, 'user');
    const newer = store.applyServerNote(MEETING, serverNote('user', 3, paragraphs('Theirs 2')));
    const listener = vi.fn();
    store.onNoteChanged(listener);

    const held = store.saveLocal(
      MEETING,
      'user',
      paragraphs('Theirs', 'typed'),
      noteSaveBase(loaded),
    );

    // The doc and the copy stay. The change tells the editor to show main's doc, which its
    // typing never saw: it then builds on that doc, not on the old one again.
    expect(held).toEqual({ ...newer, updatedAt: held.updatedAt } satisfies LocalNote);
    expect(listener).toHaveBeenCalledWith(held);
    // The same editor's later typing, on the same base, holds that typing and more.
    store.saveLocal(MEETING, 'user', paragraphs('Theirs', 'typed more'), noteSaveBase(loaded));
    // The quit closes notes.sqlite with the typing in it.
    store.close();
    const reopened = openStore(path);
    expect(reopened.getNote(MEETING, 'user')).toMatchObject({
      doc: paragraphs('Theirs 2'),
      conflictCopy: paragraphs('Mine, from last week'),
    });

    // Once the user picks for the copy, the held typing is the copy: nothing goes until picked.
    expect(reopened.resolveConflict(MEETING, 'user', 'theirs')).toMatchObject({
      doc: paragraphs('Theirs 2'),
      conflictCopy: paragraphs('Theirs', 'typed more'),
      dirty: false,
      sync: 'conflict',
    });
    expect(reopened.resolveConflict(MEETING, 'user', 'mine')).toMatchObject({
      doc: paragraphs('Theirs', 'typed more'),
      conflictCopy: null,
      dirty: true,
      sync: 'saved_locally',
    });
    expect(() => reopened.resolveConflict(MEETING, 'user', 'mine')).toThrow(
      `no conflict to resolve on the user notes of meeting ${MEETING}`,
    );
    reopened.close();
  });

  it('"Use mine" on the copy before held typing puts that copy back, then offers the typing', () => {
    const store = openStore();
    const loaded = store.applyServerNote(MEETING, serverNote('user', 1, paragraphs('Base')));
    store.saveLocal(MEETING, 'user', paragraphs('Base', 'mine'), noteSaveBase(loaded));
    // A 409's server doc: the typing is the copy. Another editor shows it, then a newer one comes.
    const shown = store.applyServerNote(MEETING, serverNote('user', 2, paragraphs('Theirs')));
    store.applyServerNote(MEETING, serverNote('user', 3, paragraphs('Theirs 2')));
    store.saveLocal(MEETING, 'user', paragraphs('Theirs', 'other'), noteSaveBase(shown));

    expect(store.resolveConflict(MEETING, 'user', 'mine')).toMatchObject({
      doc: paragraphs('Base', 'mine'),
      conflictCopy: paragraphs('Theirs', 'other'),
      dirty: true,
      sync: 'conflict',
    });
    store.close();
  });

  it('drops held typing that says what the doc says once the user picked', () => {
    const store = openStore();
    const loaded = store.applyServerNote(MEETING, serverNote('user', 1, paragraphs('Base')));
    store.saveLocal(MEETING, 'user', paragraphs('Base', 'mine'), noteSaveBase(loaded));
    const shown = store.applyServerNote(MEETING, serverNote('user', 2, paragraphs('Theirs')));
    store.applyServerNote(MEETING, serverNote('user', 3, paragraphs('Theirs 2')));
    store.saveLocal(MEETING, 'user', paragraphs('Theirs', 'other'), noteSaveBase(shown));
    // The same text then reaches the server from elsewhere.
    store.applyServerNote(MEETING, serverNote('user', 4, paragraphs('Theirs', 'other')));

    expect(store.resolveConflict(MEETING, 'user', 'theirs')).toMatchObject({
      doc: paragraphs('Theirs', 'other'),
      conflictCopy: null,
      sync: 'synced',
    });
    store.close();
  });

  it('a save built on the doc main holds is taken, conflict copy kept, as before', () => {
    const store = openStore();
    store.applyServerNote(MEETING, serverNote('user', 1, paragraphs('Base')));
    store.saveLocal(MEETING, 'user', paragraphs('Mine'));
    // The 409's server doc, which the editor then shows: its saves build on it.
    const theirs = store.applyServerNote(MEETING, serverNote('user', 2, paragraphs('Theirs')));

    const edited = store.saveLocal(
      MEETING,
      'user',
      paragraphs('Theirs', 'more'),
      noteSaveBase(theirs),
    );

    expect(edited).toMatchObject({
      doc: paragraphs('Theirs', 'more'),
      dirty: true,
      baseVersion: 2,
      conflictCopy: paragraphs('Mine'),
      sync: 'conflict',
    });
    store.close();
  });

  it('saves sent before an earlier one answered all build on the base they were typed on', () => {
    const store = openStore();
    const loaded = store.applyServerNote(MEETING, serverNote('user', 2, paragraphs('Agenda')));
    const base = noteSaveBase(loaded);

    // The editor sends a save every pause without waiting for answers, so each carries the doc
    // it last loaded, never the revision of a save main has not answered yet.
    store.saveLocal(MEETING, 'user', paragraphs('Agenda', 'a'), base);
    store.saveLocal(MEETING, 'user', paragraphs('Agenda', 'a b'), base);
    const third = store.saveLocal(MEETING, 'user', paragraphs('Agenda', 'a b c'), base);

    expect(third).toMatchObject({
      doc: paragraphs('Agenda', 'a b c'),
      revisionId: 'rev-3',
      dirty: true,
      conflictCopy: null,
      sync: 'saved_locally',
    });
    // Uploading changes nothing a save checks: the doc is still the one the chain wrote.
    store.markSynced(
      MEETING,
      'user',
      'rev-3',
      serverNote('user', 3, paragraphs('Agenda', 'a b c')),
    );
    expect(store.saveLocal(MEETING, 'user', paragraphs('Agenda', 'a b c d'), base)).toMatchObject({
      revisionId: 'rev-4',
      conflictCopy: null,
      sync: 'saved_locally',
    });
    store.close();
  });

  it('a first save with no note loaded is taken, and so are the saves after it', () => {
    const store = openStore();
    store.saveLocal(MEETING, 'ai', paragraphs('One'), null);
    expect(store.saveLocal(MEETING, 'ai', paragraphs('One', 'two'), null)).toMatchObject({
      doc: paragraphs('One', 'two'),
      conflictCopy: null,
    });
    // An editor opened later loads the latest save; its saves build on that revision.
    const reopenedEditor = noteSaveBase(store.getNote(MEETING, 'ai'));
    expect(
      store.saveLocal(MEETING, 'ai', paragraphs('One', 'two', 'three'), reopenedEditor),
    ).toMatchObject({ doc: paragraphs('One', 'two', 'three'), conflictCopy: null });
    store.close();
  });

  it('an editor that loaded no note meets AI notes a run wrote meanwhile as a conflict', () => {
    const store = openStore();
    // The run's `done` arrives while the editor still shows an empty AI notes doc.
    store.applyServerNote(MEETING, serverNote('ai', 1, paragraphs('Generated')));

    const kept = store.saveLocal(MEETING, 'ai', paragraphs('Typed into the empty doc'), null);

    expect(kept).toMatchObject({
      doc: paragraphs('Generated'),
      conflictCopy: paragraphs('Typed into the empty doc'),
      sync: 'conflict',
    });
    store.close();
  });

  it('a save built on a revision "Use mine" replaced is a conflict', () => {
    const store = openStore();
    store.applyServerNote(MEETING, serverNote('user', 1, paragraphs('Base')));
    const typed = store.saveLocal(MEETING, 'user', paragraphs('Mine'));
    store.applyServerNote(MEETING, serverNote('user', 2, paragraphs('Theirs')));
    // Another editor of the note picked "Use mine": the copy is the doc again, as a new revision.
    store.resolveConflict(MEETING, 'user', 'mine');

    const kept = store.saveLocal(MEETING, 'user', paragraphs('Mine', 'later'), noteSaveBase(typed));

    expect(kept).toMatchObject({
      doc: paragraphs('Mine'),
      conflictCopy: paragraphs('Mine', 'later'),
      sync: 'conflict',
    });
    store.close();
  });

  it('typing that says what the replacing doc says is no conflict', () => {
    const store = openStore();
    const loaded = store.applyServerNote(MEETING, serverNote('user', 2, paragraphs('A')));
    const theirs = store.applyServerNote(MEETING, serverNote('user', 3, paragraphs('A', 'B')));
    const listener = vi.fn();
    store.onNoteChanged(listener);
    const base = noteSaveBase(loaded);

    expect(store.saveLocal(MEETING, 'user', paragraphs('A', 'B'), base)).toEqual(theirs);
    expect(listener).not.toHaveBeenCalled();
    // The editor's next saves still carry its old base: they build on this same text.
    expect(store.saveLocal(MEETING, 'user', paragraphs('A', 'B', 'C'), base)).toMatchObject({
      doc: paragraphs('A', 'B', 'C'),
      conflictCopy: null,
    });
    store.close();
  });

  it('a newer server version of the same text keeps a save on the older version current', () => {
    const store = openStore();
    const loaded = store.applyServerNote(MEETING, serverNote('user', 2, paragraphs('Same')));
    // Saved elsewhere with no change of text: version 3 says what version 2 said.
    store.applyServerNote(MEETING, serverNote('user', 3, paragraphs('Same')));

    expect(
      store.saveLocal(MEETING, 'user', paragraphs('Same', 'more'), noteSaveBase(loaded)),
    ).toMatchObject({ doc: paragraphs('Same', 'more'), baseVersion: 3, conflictCopy: null });
    store.close();
  });

  it('a save on a note main deleted as empty is taken', () => {
    const store = openStore();
    const empty = store.saveLocal(MEETING, 'user', paragraphs(''), null);
    expect(store.deleteNoteIfEmpty(MEETING, 'user')).toBe(true);

    expect(
      store.saveLocal(MEETING, 'user', paragraphs('Late typing'), noteSaveBase(empty)),
    ).toMatchObject({ doc: paragraphs('Late typing'), conflictCopy: null, dirty: true });
    store.close();
  });
});

describe('SqliteNotesStore: hasNotes', () => {
  it('counts notes with text, never an empty doc', () => {
    const store = openStore();
    store.saveLocal(MEETING, 'user', paragraphs('', '   '));
    expect(store.hasNotes(MEETING)).toBe(false);

    store.saveLocal(MEETING, 'user', paragraphs('', 'Ask about pricing'));
    expect(store.hasNotes(MEETING)).toBe(true);
    expect(store.hasNotes(OTHER_MEETING)).toBe(false);

    // Typed, then deleted again.
    store.saveLocal(MEETING, 'user', paragraphs(''));
    expect(store.hasNotes(MEETING)).toBe(false);

    // A chip alone is notes too.
    store.applyServerNote(
      OTHER_MEETING,
      serverNote('ai', 1, {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'citation',
                attrs: { segmentIds: [SEGMENT], startMs: 0, label: '00:00', support: 'ok' },
              },
            ],
          },
        ],
      }),
    );
    expect(store.hasNotes(OTHER_MEETING)).toBe(true);
    store.close();
  });

  it('a notes.sqlite made before held saves gains their table, its notes kept', () => {
    const path = tempPath();
    const first = openStore(path);
    first.saveLocal(MEETING, 'user', paragraphs('Before'));
    first.close();
    // Wound back to schema 1, as an earlier build left it.
    const raw = new DatabaseSync(path);
    raw.exec('DROP TABLE held_saves; PRAGMA user_version = 1');
    raw.close();

    const store = openStore(path);
    expect(store.getNote(MEETING, 'user')?.doc).toEqual(paragraphs('Before'));
    expect(store.hasNotes(MEETING)).toBe(true);
    expect(store.hasNotes(OTHER_MEETING)).toBe(false);
    store.close();
  });

  it('counts held typing, which also keeps its note from being deleted as empty', () => {
    const store = openStore();
    store.saveLocal(MEETING, 'user', paragraphs(''), null);
    // The server's doc replaced the cleared one, which is the copy now: neither holds text.
    store.applyServerNote(MEETING, serverNote('user', 1, paragraphs('', '')));
    expect(store.hasNotes(MEETING)).toBe(false);

    // Typing from an editor on a doc main has replaced, while the copy holds other typing.
    store.saveLocal(MEETING, 'user', paragraphs('Typed'), {
      revisionId: 'rev-elsewhere',
      version: 0,
    });

    expect(store.hasNotes(MEETING)).toBe(true);
    expect(store.deleteNoteIfEmpty(MEETING, 'user')).toBe(false);
    store.close();
  });

  it('counts the text a conflict copy holds', () => {
    const store = openStore();
    store.applyServerNote(MEETING, serverNote('user', 1, paragraphs('')));
    store.saveLocal(MEETING, 'user', paragraphs('Kept aside'));
    store.applyServerNote(MEETING, serverNote('user', 2, paragraphs('')));

    expect(store.getNote(MEETING, 'user')?.sync).toBe('conflict');
    expect(store.hasNotes(MEETING)).toBe(true);
    store.close();
  });

  it('deletes a note only when it holds no text, and emits nothing', () => {
    const store = openStore();
    // The blur's empty paragraph, in a meeting that was then discarded as empty.
    store.saveLocal(MEETING, 'user', paragraphs('', '   '));
    store.saveLocal(MEETING, 'ai', paragraphs('Kept'));
    const changed = vi.fn();
    store.onNoteChanged(changed);

    expect(store.deleteNoteIfEmpty(MEETING, 'ai')).toBe(false);
    expect(store.deleteNoteIfEmpty(MEETING, 'user')).toBe(true);
    expect(store.getNote(MEETING, 'user')).toBeNull();
    expect(store.getNote(MEETING, 'ai')?.doc).toEqual(paragraphs('Kept'));
    expect(store.deleteNoteIfEmpty(MEETING, 'user')).toBe(false);
    expect(changed).not.toHaveBeenCalled();

    // An empty doc whose conflict copy holds text is notes.
    store.applyServerNote(OTHER_MEETING, serverNote('user', 1, paragraphs('')));
    store.saveLocal(OTHER_MEETING, 'user', paragraphs('Kept aside'));
    store.applyServerNote(OTHER_MEETING, serverNote('user', 2, paragraphs('')));
    expect(store.deleteNoteIfEmpty(OTHER_MEETING, 'user')).toBe(false);
    store.close();
  });
});

describe('SqliteNotesStore: waiting notes', () => {
  it('lists each meeting whose dirty notes wait for it once, oldest save first', () => {
    const store = openStore();
    const third = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a';
    store.saveLocal(OTHER_MEETING, 'user', paragraphs('Agenda'));
    store.setSyncState(OTHER_MEETING, 'user', 'waiting_for_meeting');
    store.saveLocal(MEETING, 'user', paragraphs('Pricing'));
    store.setSyncState(MEETING, 'user', 'waiting_for_meeting');
    store.saveLocal(MEETING, 'ai', paragraphs('Generated'));
    store.setSyncState(MEETING, 'ai', 'waiting_for_meeting');
    // Dirty for another reason: not waiting.
    store.saveLocal(third, 'user', paragraphs('Offline'));
    store.setSyncState(third, 'user', 'offline');

    expect(store.listWaitingMeetingIds()).toEqual([OTHER_MEETING, MEETING]);
    store.close();
  });
});

describe('SqliteNotesStore: pending generates and template picks', () => {
  const failed: StoredPendingGenerate = {
    meetingId: MEETING,
    runId: RUN,
    templateId: 'standup',
    reason: 'after_stop',
    createdAt: '2026-10-06T10:00:00.000Z',
    lastError: { code: 'llm_provider_error', message: 'The notes model is unavailable.' },
  };
  const asking: StoredPendingGenerate = {
    meetingId: OTHER_MEETING,
    runId: '8a9b0c1d-2e3f-4a5b-8c6d-7e8f9a0b1c2d',
    templateId: null,
    reason: 'button',
    createdAt: '2026-10-06T10:05:00.000Z',
    lastError: null,
  };

  it('pending_generate survives reopening', () => {
    const path = tempPath();
    const store = openStore(path);
    store.putPendingGenerate(asking);
    store.putPendingGenerate(failed);
    store.close();

    const reopened = openStore(path);
    expect(reopened.listPendingGenerates()).toEqual([failed, asking]);
    expect(reopened.getPendingGenerate(MEETING)).toEqual(failed);
    expect(reopened.getPendingGenerate('1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a')).toBeNull();
    reopened.close();
  });

  it('holds one pending generate per meeting, and deletes it only for its own run', () => {
    const store = openStore();
    store.putPendingGenerate(failed);
    const retry = { ...failed, runId: '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e', lastError: null };
    store.putPendingGenerate(retry);

    expect(store.listPendingGenerates()).toEqual([retry]);
    // The old run's late `done` does not end the Retry's generate.
    expect(store.deletePendingGenerate(MEETING, RUN)).toBe(false);
    expect(store.getPendingGenerate(MEETING)).toEqual(retry);
    expect(store.deletePendingGenerate(MEETING, retry.runId)).toBe(true);
    expect(store.getPendingGenerate(MEETING)).toBeNull();
    store.close();
  });

  it('remembers the last template picked for a title', () => {
    const path = tempPath();
    const store = openStore(path);
    expect(store.getTemplateChoice('sync with acme')).toBeNull();

    store.rememberTemplateChoice('sync with acme', 'general');
    store.rememberTemplateChoice('sync with acme', 'client_call');
    store.close();

    const reopened = openStore(path);
    expect(reopened.getTemplateChoice('sync with acme')).toBe('client_call');
    expect(() => {
      reopened.rememberTemplateChoice('  ', 'general');
    }).toThrow('cannot remember a template for a blank title');
    reopened.close();
  });
});
