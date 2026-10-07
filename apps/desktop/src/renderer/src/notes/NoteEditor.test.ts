import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { LocalNote, NoteDoc, NoteNode } from '../../../shared/notes';
import { docForSave, NoteEditor } from './NoteEditor';
import type { NoteDocumentHandle, NoteDocumentState } from './useNoteDocument';

const hooks = vi.hoisted(() => ({
  useNoteDocument: vi.fn<() => NoteDocumentHandle>(),
}));

// Node has no window.roger; the editor's states come from the note it is given.
vi.mock('./useNoteDocument', () => hooks);

function withState(state: Partial<NoteDocumentState>): void {
  hooks.useNoteDocument.mockReturnValue({
    // WHY the cast: these states draw no editor, and only "Try again" reads the document (reload);
    // a real NoteDocument needs main's channels, which Node does not have.
    document: { reload: vi.fn() } as unknown as NoteDocumentHandle['document'],
    state: {
      status: 'ready',
      note: null,
      error: null,
      docGeneration: 1,
      docProblem: null,
      ...state,
    },
  });
}

const render = (): string =>
  renderToStaticMarkup(
    createElement(NoteEditor, {
      meetingId: '3f6c2a90-1b7e-4c1d-9a55-2e8f0b6d4c11',
      kind: 'user',
      label: 'My notes',
    }),
  );

/** The note as main holds it; its doc is never drawn here (the tests that use it have a problem). */
function storedNote(overrides: Partial<LocalNote> = {}): LocalNote {
  return {
    meetingId: '3f6c2a90-1b7e-4c1d-9a55-2e8f0b6d4c11',
    kind: 'user',
    doc: { type: 'doc', content: [] },
    revisionId: null,
    dirty: false,
    baseVersion: 5,
    templateId: null,
    lastRunId: null,
    generatedVersion: null,
    conflictCopy: null,
    sync: 'synced',
    updatedAt: '2026-10-06T10:00:00.000Z',
    ...overrides,
  };
}

/** A doc whose one item sits `depth` bullet lists deep and holds a bold word. */
function deepDoc(depth: number): NoteDoc {
  let node: NoteNode = {
    type: 'bulletList',
    content: [
      {
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'deep', marks: [{ type: 'bold' }] }],
          },
        ],
      },
    ],
  };
  for (let level = 1; level < depth; level += 1) {
    node = {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [{ type: 'paragraph' }, node] }],
    };
  }
  return { type: 'doc', content: [node] };
}

describe('docForSave', () => {
  it("hands main the editor's doc as it is", () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
    expect(docForSave(doc)).toBe(doc);
  });

  it('refuses a doc main would refuse, with its reason, before it leaves the page', () => {
    expect(() => docForSave(deepDoc(14))).toThrow(/nested deeper than 32 levels/);
    expect(() => docForSave({ type: 'paragraph' })).toThrow(/not a TipTap doc/);
  });
});

describe('NoteEditor', () => {
  it('says nothing while main reads the notes: the read answers within a frame', () => {
    withState({ status: 'loading', docGeneration: 0 });
    const html = render();
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="My notes"');
    expect(html).not.toContain('Opening');
  });

  it('shows why the notes could not be read, with Try again', () => {
    withState({ status: 'failed', error: 'notes.sqlite is locked' });
    const html = render();
    // A problem line (an icon and words), not a tinted box.
    expect(html).toMatch(/class="problem note-editor-problem" role="alert"><svg/);
    expect(html).toContain('Could not open these notes: notes.sqlite is locked');
    expect(html).toContain('>Try again</button>');
    expect(html).not.toContain('class="error');
  });

  it('shows no editor for a doc it cannot hold, and says the notes are left as they are', () => {
    withState({
      docProblem: 'Invalid content for node listItem: <>',
      note: null,
    });
    const html = render();
    expect(html).toContain('Roger cannot show these notes, so it leaves them as they are');
    expect(html).toContain('Invalid content for node listItem');
    expect(html).not.toContain('contenteditable');
  });

  it("still offers Use mine when main kept the user's notes beside a doc it cannot hold", () => {
    // A 409 brought a server doc this build's schema refuses (written by a newer Roger); main
    // keeps the user's own notes, which the editor can show, as the conflict copy.
    withState({
      docProblem: 'Invalid content for node listItem: <>',
      note: storedNote({ sync: 'conflict', conflictCopy: deepDoc(1) }),
    });
    const html = render();
    expect(html).toContain('Roger cannot show that version');
    expect(html).toContain('>Use mine</button>');
    expect(html).toContain('>Keep the other version</button>');
    expect(html).toContain('Roger cannot show these notes, so it leaves them as they are');
    expect(html).not.toContain('contenteditable');
  });

  it('says nothing of a synced doc it cannot hold, and Saved on this Mac when offline', () => {
    withState({ docProblem: 'Invalid content for node listItem: <>', note: storedNote() });
    const synced = render();
    expect(synced).not.toContain('Synced');
    expect(synced).not.toContain('class="note-status"');
    expect(synced).not.toContain('note-conflict');

    withState({
      docProblem: 'Invalid content for node listItem: <>',
      note: storedNote({ sync: 'offline' }),
    });
    expect(render()).toContain('>Saved on this Mac<');
  });
});
