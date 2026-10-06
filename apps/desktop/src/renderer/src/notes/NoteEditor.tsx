import { EditorContent, type EditorEvents, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { isNoteDoc, type NoteDoc, noteDocProblem, type NoteKind } from '../../../shared/notes';
import { CitationChip } from './CitationChip';
import { noteExtensions } from './citationNode';
import { ConflictBanner } from './ConflictBanner';
import { DebouncedSaver, notesFlushResponder, type SaverState } from './debouncedSaver';
import { describeSaveStatus } from './saveStatus';
import { type NoteDocument, type NoteDocumentState, useNoteDocument } from './useNoteDocument';
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
            className="note-button"
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
    // next save would store the doc without it.
    return (
      <section className="note-editor" aria-label={label}>
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
        citationView: ReactNodeViewRenderer(CitationChip),
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

    let shown = setup.generation;
    const showNewDoc = (): void => {
      const { docGeneration, note, docProblem } = document.getState();
      if (docGeneration === shown || note === null) return;
      shown = docGeneration;
      // The editor never drops its own unsaved typing for a doc from elsewhere: it saves it, and
      // main's store decides what is current (its conflict rule keeps the other doc as a copy
      // when it can). Loading the other doc here would lose up to 400 ms of typing.
      if (saver.unsaved) {
        void saver.flush();
        return;
      }
      // NoteEditor shows the problem in place of this editor, which is about to unmount.
      if (docProblem !== null) return;
      // Out of the undo history: Cmd-Z must not take the editor back to a doc main replaced, and
      // then save that over it. No `update` either: loading is not an edit to save.
      editor
        .chain()
        .setMeta('addToHistory', false)
        .setContent(note.doc, { emitUpdate: false, errorOnInvalidContent: true })
        .run();
    };
    const stopFollowing = document.subscribe(showNewDoc);
    // A doc may have arrived between the first render and this effect.
    showNewDoc();
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

  const status = describeSaveStatus(saverState, state.note?.sync ?? null);
  const conflict = state.note !== null && state.note.conflictCopy !== null;
  return (
    <section className="note-editor" aria-label={label}>
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
      {conflict ? <ConflictBanner onResolve={(keep) => document.resolveConflict(keep)} /> : null}
      <EditorContent editor={editor} className="note-editor-body" />
    </section>
  );
}
