import { describe, expect, it } from 'vitest';
import type { NotesApi, SaveNoteRequest } from '../../../shared/ipc/notes';
import type { LocalNote, MeetingNotes, NoteDoc, NoteKind } from '../../../shared/notes';
import { NoteDocument, type NoteDocumentState } from './useNoteDocument';

const MEETING = '3f6c2a90-1b7e-4c1d-9a55-2e8f0b6d4c11';
const OTHER_MEETING = '8d1e5b22-7c3a-4f60-8e19-5a2b9c0d7e33';

const docSaying = (text: string): NoteDoc => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function note(overrides: Partial<LocalNote> = {}): LocalNote {
  return {
    meetingId: MEETING,
    kind: 'user',
    doc: docSaying('from main'),
    revisionId: null,
    dirty: false,
    baseVersion: 3,
    templateId: null,
    lastRunId: null,
    generatedVersion: null,
    conflictCopy: null,
    sync: 'synced',
    updatedAt: '2026-10-06T10:00:00.000Z',
    ...overrides,
  };
}

type Api = Pick<NotesApi, 'getNotes' | 'saveNote' | 'onNoteChanged' | 'resolveNoteConflict'>;

/**
 * main's notes channels. Loads and saves answer when the test says, so it can choose whether a
 * save's change event arrives before or after the save answers (main sends both, in either order).
 */
function fakeMain() {
  const listeners = new Set<(note: LocalNote) => void>();
  const loads: { resolve: (notes: MeetingNotes) => void; reject: (error: Error) => void }[] = [];
  const saves: {
    request: SaveNoteRequest;
    resolve: (note: LocalNote) => void;
    reject: (error: Error) => void;
  }[] = [];
  const resolves: { keep: string }[] = [];
  const api: Api = {
    getNotes: () =>
      new Promise((resolve, reject) => {
        loads.push({ resolve, reject });
      }),
    saveNote: (request) =>
      new Promise((resolve, reject) => {
        saves.push({ request, resolve, reject });
      }),
    resolveNoteConflict: ({ keep }) => {
      resolves.push({ keep });
      return Promise.resolve(note());
    },
    onNoteChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    api,
    loads,
    saves,
    resolves,
    listeners,
    emit: (changed: LocalNote) => {
      for (const listener of listeners) listener(changed);
    },
    answerLoad: async (notes: Partial<Record<NoteKind, LocalNote | null>>) => {
      loads.shift()?.resolve({ meetingId: MEETING, user: null, ai: null, ...notes });
      await settle();
    },
  };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}

function open(kind: NoteKind = 'user') {
  const main = fakeMain();
  const document = new NoteDocument(main.api, MEETING, kind);
  const seen: NoteDocumentState[] = [];
  document.subscribe(() => seen.push(document.getState()));
  const stop = document.start();
  return { main, document, seen, stop };
}

describe('NoteDocument', () => {
  it("loads the meeting's note of its kind", async () => {
    const { main, document } = open('ai');
    expect(document.getState()).toEqual(
      expect.objectContaining({ status: 'loading', note: null, docGeneration: 0 }),
    );
    const ai = note({ kind: 'ai', doc: docSaying('AI notes') });
    await main.answerLoad({ user: note(), ai });
    expect(document.getState()).toEqual({
      status: 'ready',
      note: ai,
      error: null,
      docGeneration: 1,
      docProblem: null,
    });
  });

  it('is ready with no note when the meeting has none of its kind yet', async () => {
    const { main, document } = open();
    await main.answerLoad({});
    expect(document.getState()).toEqual(
      expect.objectContaining({ status: 'ready', note: null, docGeneration: 1 }),
    );
  });

  it('shows why the notes could not be read, and reads again on Try again', async () => {
    const { main, document } = open();
    main.loads
      .shift()
      ?.reject(
        new Error("Error invoking remote method 'notes:get': Error: notes.sqlite is locked"),
      );
    await settle();
    expect(document.getState()).toEqual(
      expect.objectContaining({ status: 'failed', error: 'notes.sqlite is locked' }),
    );
    document.reload();
    expect(document.getState().status).toBe('loading');
    await main.answerLoad({ user: note() });
    expect(document.getState()).toEqual(
      expect.objectContaining({ status: 'ready', error: null, note: note() }),
    );
  });

  it('saves the doc as this meeting and kind', async () => {
    const { main, document } = open('ai');
    await main.answerLoad({});
    void document.save(docSaying('edited'));
    expect(main.saves.map(({ request }) => request)).toEqual([
      { meetingId: MEETING, kind: 'ai', doc: docSaying('edited') },
    ]);
  });

  it("rejects a refused save with main's reason, for the status line", async () => {
    const { main, document } = open();
    await main.answerLoad({});
    const saving = document.save(docSaying('x'));
    main.saves.shift()?.reject(new Error('note not saved: nested deeper than 32 levels'));
    await expect(saving).rejects.toThrow('nested deeper than 32 levels');
  });

  it('an own save coming back never reloads the editor, whichever answer arrives first', async () => {
    const { main, document } = open();
    await main.answerLoad({ user: note() });
    const loaded = document.getState().docGeneration;

    // The change event before the save answers (the preview's fake), then after (main may too).
    const first = document.save(docSaying('one'));
    const firstNote = note({ doc: docSaying('one'), revisionId: 'rev-1', sync: 'saved_locally' });
    main.emit(firstNote);
    main.saves.shift()?.resolve(firstNote);
    await first;
    await settle();
    const second = document.save(docSaying('one two'));
    const secondNote = note({ doc: docSaying('one two'), revisionId: 'rev-2' });
    main.saves.shift()?.resolve(secondNote);
    await second;
    main.emit({ ...secondNote, sync: 'saved_locally' });
    await settle();

    expect(document.getState().docGeneration).toBe(loaded);
    expect(document.getState().note).toEqual({ ...secondNote, sync: 'saved_locally' });
  });

  it("never loads an older own save's doc over newer typing", async () => {
    const { main, document } = open();
    await main.answerLoad({});
    const generation = document.getState().docGeneration;
    const first = document.save(docSaying('one'));
    const second = document.save(docSaying('one two'));
    // The first save's change arrives before either save answers: its revision is not known yet,
    // and its doc is older than the editor's. Loaded, it would wipe "two" from the editor.
    main.emit(note({ doc: docSaying('one'), revisionId: 'rev-1', sync: 'saved_locally' }));
    expect(document.getState().docGeneration).toBe(generation);
    main.saves.shift()?.resolve(note({ doc: docSaying('one'), revisionId: 'rev-1' }));
    main.saves.shift()?.resolve(note({ doc: docSaying('one two'), revisionId: 'rev-2' }));
    await Promise.all([first, second]);
    expect(document.getState().docGeneration).toBe(generation);
  });

  it('follows the sync state of its own saves without reloading', async () => {
    const { main, document } = open();
    await main.answerLoad({});
    const saving = document.save(docSaying('typed'));
    const saved = note({ doc: docSaying('typed'), revisionId: 'rev-1', sync: 'saved_locally' });
    main.saves.shift()?.resolve(saved);
    await saving;
    const generation = document.getState().docGeneration;
    for (const sync of ['syncing', 'offline', 'synced'] as const) {
      main.emit({ ...saved, sync });
      expect(document.getState().note?.sync).toBe(sync);
    }
    expect(document.getState().docGeneration).toBe(generation);
  });

  it('reloads the editor for a doc from elsewhere: a conflict, Use mine, a run', async () => {
    const { main, document } = open();
    await main.answerLoad({ user: note({ doc: docSaying('mine'), revisionId: 'rev-1' }) });
    const generation = document.getState().docGeneration;
    // A 409: main takes the server's doc and keeps the local one as the conflict copy.
    const conflict = note({
      doc: docSaying('theirs'),
      conflictCopy: docSaying('mine'),
      sync: 'conflict',
    });
    main.emit(conflict);
    expect(document.getState()).toEqual(
      expect.objectContaining({ note: conflict, docGeneration: generation + 1 }),
    );
    // "Use mine": the copy is the doc again, under a revision this editor never made.
    main.emit(note({ doc: docSaying('mine'), revisionId: 'rev-9', sync: 'saved_locally' }));
    expect(document.getState().docGeneration).toBe(generation + 2);
  });

  it('does not reload the editor for a change that leaves the doc as shown', async () => {
    const { main, document } = open();
    await main.answerLoad({ user: note({ sync: 'conflict', conflictCopy: docSaying('mine') }) });
    const generation = document.getState().docGeneration;
    // "Keep this version": the copy goes, the doc stays.
    main.emit(note({ sync: 'synced' }));
    expect(document.getState()).toEqual(
      expect.objectContaining({ note: note({ sync: 'synced' }), docGeneration: generation }),
    );
  });

  it('says why the editor cannot show a doc main holds, once per doc to show', async () => {
    const { main, document } = open();
    // StarterKit's list item starts with a paragraph: shown, the editor would drop this one.
    const unshowable: NoteDoc = {
      type: 'doc',
      content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [] }] }],
    };
    await main.answerLoad({ user: note({ doc: unshowable }) });
    expect(document.getState().status).toBe('ready');
    expect(document.getState().docProblem).toMatch(/listItem/);
    main.emit(note({ doc: docSaying('fixed elsewhere'), revisionId: 'rev-7' }));
    expect(document.getState().docProblem).toBeNull();
  });

  it('ignores changes to other meetings and to the other kind', async () => {
    const { main, document } = open('user');
    await main.answerLoad({ user: note() });
    const before = document.getState();
    main.emit(note({ meetingId: OTHER_MEETING, doc: docSaying('elsewhere') }));
    main.emit(note({ kind: 'ai', doc: docSaying('AI') }));
    expect(document.getState()).toBe(before);
  });

  it('keeps a change that arrives before the load answers over the older load', async () => {
    const { main, document } = open();
    const newer = note({ doc: docSaying('newer'), revisionId: null, baseVersion: 4 });
    main.emit(newer);
    await main.answerLoad({ user: note({ doc: docSaying('older') }) });
    expect(document.getState()).toEqual(expect.objectContaining({ status: 'ready', note: newer }));
  });

  it('resolves a conflict for this meeting and kind', async () => {
    const { main, document } = open('ai');
    await main.answerLoad({});
    await document.resolveConflict('mine');
    expect(main.resolves).toEqual([{ keep: 'mine' }]);
  });

  it('stops listening when stopped, and drops a load that answers after', async () => {
    const { main, document, stop, seen } = open();
    stop();
    expect(main.listeners.size).toBe(0);
    await main.answerLoad({ user: note() });
    expect(document.getState().status).toBe('loading');
    expect(seen).toEqual([]);
  });

  it('starts again after a stop, as StrictMode runs every effect twice', async () => {
    const { main, document, stop } = open();
    stop();
    document.start();
    // The first start's load answers late and is dropped; the second's counts.
    await main.answerLoad({ user: note({ doc: docSaying('stale') }) });
    expect(document.getState().status).toBe('loading');
    await main.answerLoad({ user: note() });
    expect(document.getState()).toEqual(expect.objectContaining({ status: 'ready', note: note() }));
    expect(main.listeners.size).toBe(1);
  });
});
