import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
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

  it('counts the text a conflict copy holds', () => {
    const store = openStore();
    store.applyServerNote(MEETING, serverNote('user', 1, paragraphs('')));
    store.saveLocal(MEETING, 'user', paragraphs('Kept aside'));
    store.applyServerNote(MEETING, serverNote('user', 2, paragraphs('')));

    expect(store.getNote(MEETING, 'user')?.sync).toBe('conflict');
    expect(store.hasNotes(MEETING)).toBe(true);
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
