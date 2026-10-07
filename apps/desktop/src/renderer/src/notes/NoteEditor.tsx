import { EditorContent, type EditorEvents, useEditor } from '@tiptap/react';
import { useEffect, useState } from 'react';
import {
  isNoteDoc,
  type LocalNote,
  type NoteDoc,
  noteDocProblem,
  type NoteKind,
} from '../../../shared/notes';
import { citationChipView } from './CitationChip';
import { noteExtensions } from './citationNode';
import { ConflictBanner } from './ConflictBanner';
import { DebouncedSaver, notesFlushResponder, type SaverState } from './debouncedSaver';
import { describeSaveStatus } from './saveStatus';
import {
  followNoteDocument,
  type NoteDocument,
  type NoteDocumentState,
  useNoteDocument,
} from './useNoteDocument';
import './notes.css';

/**
 * One notes doc of a meeting in a TipTap editor: "My notes" during and after the call, and the AI
 * notes once written (M4-T18 makes them read-only while a run writes them). Saved to the Mac as
 * it is typed (debouncedSaver.ts), followed as main changes it (useNoteDocument.ts), with one save
 * state on show (saveStatus.ts) and the conflict banner when main kept two versions. Its citation
 * chips need the meeting page's CitationNavigatorProvider above it.
 */

export interface NoteEditorProps {
  meetingId: string;
  kind: NoteKind;
  /** The editor's accessible name: the tab it sits under, such as "My notes". */
  label: string;
  /** Shown while the note is empty. */
  placeholder?: string;
  /** Nobody can type, as while a run writes the AI notes. Chips still open the transcript. */
  readOnly?: boolean;
}

/**
 * The editor's JSON as the doc main stores, or the reason main would refuse it (too deep, too
 * large), thrown so the saver shows it as a refused save before anything leaves the page.
 */
export function docForSave(json: unknown): NoteDoc {
  if (isNoteDoc(json)) return json;
  throw new Error(noteDocProblem(json) ?? 'not a notes doc');
}

export function NoteEditor({
  meetingId,
  kind,
  label,
  placeholder,
  readOnly = false,
}: NoteEditorProps) {
  const { document, state } = useNoteDocument(meetingId, kind);
  if (state.status === 'loading') {
    return (
      <section className="note-editor" aria-label={label} aria-busy="true">
        <p className="note-editor-message">Opening notes...</p>
      </section>
    );
  }
  if (state.status === 'failed') {
    return (
      <section className="note-editor" aria-label={label}>
        <div className="error note-editor-error" role="alert">
          Could not open these notes: {state.error}{' '}
          <button
            type="button"
            className="btn"
            data-variant="secondary"
            data-size="sm"
            onClick={() => {
              document.reload();
            }}
          >
            Try again
          </button>
        </div>
      </section>
    );
  }
  if (state.docProblem !== null) {
    // No editor at all: one that showed this doc would drop what its schema cannot hold, and the
    // next save would store the doc without it. The save state and the conflict choice stay: a
    // 409 can bring a doc this build cannot show (a newer Roger wrote it) while main keeps the
    // user's own notes as the copy, and "Use mine" is the only way back to them.
    return (
      <section className="note-editor" aria-label={label}>
        <NoteStateBar
          document={document}
          note={state.note}
          saverState={NO_EDITOR}
          docShown={false}
        />
        <p className="error note-editor-error" role="alert">
          Roger cannot show these notes, so it leaves them as they are: {state.docProblem}
        </p>
      </section>
    );
  }
  return (
    <LoadedNoteEditor
      key={`${meetingId}/${kind}`}
      document={document}
      state={state}
      label={label}
      placeholder={placeholder}
      readOnly={readOnly}
    />
  );
}

interface LoadedNoteEditorProps {
  document: NoteDocument;
  state: NoteDocumentState;
  label: string;
  placeholder: string | undefined;
  readOnly: boolean;
}

function LoadedNoteEditor({
  document,
  state,
  label,
  placeholder,
  readOnly,
}: LoadedNoteEditorProps) {
  // Made once, with the doc this first render shows. useEditor compares its options by identity
  // on every render and pushes changed ones into the editor, so a new extension list or `content`
  // each render would churn it. Later docs arrive through setContent below, never as options.
  const [setup] = useState(() => ({
    generation: state.docGeneration,
    options: {
      extensions: noteExtensions({
        placeholder,
        citationView: citationChipView(),
      }),
      content: state.note?.doc ?? null,
      editable: !readOnly,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: {
          class: 'note-editor-content',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': label,
        },
      },
    },
  }));
  const editor = useEditor(setup.options);
  const [saverState, setSaverState] = useState<SaverState>({ phase: 'saved' });

  useEffect(() => {
    const saver = new DebouncedSaver({
      read: () => docForSave(editor.getJSON()),
      write: (doc) => document.save(doc),
      page: window,
      responder: notesFlushResponder(),
      onState: setSaverState,
    });
    const onUpdate = ({ transaction }: EditorEvents['update']): void => {
      // Typing only: setEditable emits `update` too, with no change to the doc.
      if (transaction.docChanged) saver.edited();
    };
    const onBlur = (): void => {
      saver.blurred();
    };
    editor.on('update', onUpdate);
    editor.on('blur', onBlur);
    // A doc given as `content` meets no transaction, so StarterKit's trailing paragraph (added
    // after a doc that ends in a list) waits for the first one, the focus of the first click. A
    // click on an atom (a horizontal rule) resolves its selection before that focus and then
    // throws "Selection passed to setSelection must point at the current document". One empty
    // transaction now lets the paragraph land at load: no `update` (the doc as main has it did not
    // change), and out of the undo history. CitationChip.tsx keeps chip clicks from ProseMirror.
    editor.chain().setMeta('addToHistory', false).run();

    const stopFollowing = followNoteDocument(document, saver, setup.generation, (doc) => {
      // Out of the undo history: Cmd-Z must not take the editor back to a doc main replaced, and
      // then save that over it. No `update` either: loading is not an edit to save.
      editor
        .chain()
        .setMeta('addToHistory', false)
        .setContent(doc, { emitUpdate: false, errorOnInvalidContent: true })
        .run();
    });
    return () => {
      stopFollowing();
      editor.off('update', onUpdate);
      editor.off('blur', onBlur);
      void saver.dispose();
    };
  }, [editor, document, setup]);

  useEffect(() => {
    // `false`: no `update` event, which would read as an edit.
    editor.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  return (
    <section className="note-editor" aria-label={label}>
      <NoteStateBar document={document} note={state.note} saverState={saverState} docShown />
      <EditorContent editor={editor} className="note-editor-body" />
    </section>
  );
}

/** With no editor open there is nothing of the user's to save: the state is main's alone. */
const NO_EDITOR: SaverState = { phase: 'saved' };

interface NoteStateBarProps {
  document: NoteDocument;
  note: LocalNote | null;
  saverState: SaverState;
  /** Whether the editor shows `note.doc`; false when it cannot (`docProblem`). */
  docShown: boolean;
}

/**
 * Above the doc: its one save state, a refused save's reason, and the choice between two versions
 * while main keeps a conflict copy.
 */
function NoteStateBar({ document, note, saverState, docShown }: NoteStateBarProps) {
  const status = describeSaveStatus(saverState, note?.sync ?? null);
  return (
    <>
      <div className="note-editor-bar">
        {status === null ? null : (
          <p className={`note-status note-status-${status.tone}`} title={status.detail}>
            {status.label}
          </p>
        )}
      </div>
      {status?.tone === 'bad' ? (
        <p className="error note-editor-error" role="alert">
          {status.detail}
        </p>
      ) : null}
      {note !== null && note.conflictCopy !== null ? (
        <ConflictBanner
          otherVersion={docShown ? 'shown' : 'unshowable'}
          onResolve={(keep) => document.resolveConflict(keep)}
        />
      ) : null}
    </>
  );
}
