import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from '../components/ui/icons';
import {
  sizeNote,
  textAfterPaste,
  type VocabularyEditing,
  VocabularyEditor,
  type VocabularyEditorState,
} from './vocabularyEditor';
import { SettingsProblem } from './SettingsProblem';
import './settings.css';
import './vocabulary.css';

/** What the section calls on the editor; VocabularyEditor is one, a test passes spies. */
export type VocabularyEditorActions = Pick<VocabularyEditor, 'load' | 'add' | 'remove' | 'save'>;

/**
 * Settings: the workspace jargon list, the names speech-to-text should spell right. M3-T9 mounts
 * it in the shell's `settings` slot. The list lives in the Roger API; this reads it when it opens
 * and saves it whole after every add and remove (vocabularyEditor.ts, which refuses a save before
 * a read).
 */
export function VocabularySettings() {
  // One editor per mount: leaving Settings drops it with any save still out, and coming back reads
  // at once. Main answers that read only after the save (main/vocabulary/vocabularyIpc.ts), or the
  // page would show the list from before it as saved and the next edit would undo the change.
  const [editor] = useState(() => new VocabularyEditor(window.roger));
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  useEffect(() => {
    // load() never rejects: a failure becomes the load-failed state. React's StrictMode runs this
    // twice; the editor keeps only the later read's answer.
    void editor.load();
  }, [editor]);
  return <VocabularySection state={state} editor={editor} />;
}

interface VocabularySectionProps {
  state: VocabularyEditorState;
  editor: VocabularyEditorActions;
}

/** The section for one editor state. */
export function VocabularySection({ state, editor }: VocabularySectionProps) {
  const headingId = useId();
  return (
    <section className="settings-section vocabulary" aria-labelledby={headingId}>
      <h2 id={headingId} className="settings-section-title">
        Jargon list
      </h2>
      <p className="settings-help">
        Names transcripts should spell right: your company, clients and products. Everyone in your
        workspace shares this list.
      </p>
      <VocabularyBody state={state} editor={editor} />
    </section>
  );
}

function VocabularyBody({ state, editor }: VocabularySectionProps) {
  switch (state.phase) {
    case 'loading':
      return (
        <p className="settings-help" role="status">
          Loading the jargon list…
        </p>
      );
    case 'load-failed':
      // No box here: saving replaces the whole list, so one never read is never saved.
      return (
        <SettingsProblem
          role="alert"
          action={
            <button
              type="button"
              className="btn"
              data-variant="secondary"
              data-size="sm"
              onClick={() => {
                void editor.load();
              }}
            >
              Try again
            </button>
          }
        >
          Couldn’t load the jargon list: {state.error}. Your saved terms are safe: Roger edits the
          list only after it has read it.
        </SettingsProblem>
      );
    case 'editing':
      return <VocabularyForm state={state} editor={editor} />;
  }
}

interface VocabularyFormProps {
  state: VocabularyEditing;
  editor: VocabularyEditorActions;
}

function VocabularyForm({ state, editor }: VocabularyFormProps) {
  const inputId = useId();
  const problemId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const note = sizeNote(state.draft);

  const add = (value: string): void => {
    const result = editor.add(value);
    setText(result.rest);
    setProblem(result.problem);
  };

  return (
    <div className="vocabulary-editor">
      <form
        className="vocabulary-add"
        onSubmit={(event) => {
          event.preventDefault();
          add(text);
        }}
      >
        <label htmlFor={inputId} className="visually-hidden">
          Add terms
        </label>
        {/* Never disabled while a save is out: a disabled box loses the caret, and adding several
            terms in a row would stop after the first. The editor queues the edits. */}
        <input
          ref={input}
          id={inputId}
          className="settings-input vocabulary-input"
          type="text"
          value={text}
          placeholder="Add names, like Linkt, Roger"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={problem !== null}
          aria-describedby={problem === null ? undefined : problemId}
          onChange={(event) => {
            setText(event.target.value);
            setProblem(null);
          }}
          onPaste={(event) => {
            // A pasted column of names is split here: the box would drop its line breaks. At the
            // caret and over the selection, never appended to the whole text (textAfterPaste).
            const after = textAfterPaste(event.currentTarget, event.clipboardData.getData('text'));
            if (after === null) return;
            event.preventDefault();
            add(after);
          }}
        />
        <button
          type="submit"
          className="btn"
          data-variant="secondary"
          data-size="md"
          disabled={text.trim() === ''}
        >
          Add
        </button>
      </form>
      {problem === null ? null : (
        <SettingsProblem id={problemId} role="alert">
          {problem}
        </SettingsProblem>
      )}

      {state.draft.length === 0 ? null : (
        <ul className="vocabulary-terms" aria-label="Terms">
          {state.draft.map((term) => (
            <li key={term} className="vocabulary-term">
              <span className="vocabulary-term-text">{term}</span>
              <button
                type="button"
                className="vocabulary-remove"
                aria-label={`Remove ${term}`}
                title={`Remove ${term}`}
                onClick={() => {
                  editor.remove(term);
                  // The button goes with its term; keep the keyboard in the editor.
                  input.current?.focus();
                }}
              >
                <Icon name="x" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {note === null ? null : <p className="settings-help vocabulary-size">{note}</p>}

      {state.saveError === null ? null : (
        <SettingsProblem
          role="alert"
          action={
            <button
              type="button"
              className="btn"
              data-variant="secondary"
              data-size="sm"
              onClick={() => {
                void editor.save();
              }}
            >
              Try again
            </button>
          }
        >
          Not saved: {state.saveError}
        </SettingsProblem>
      )}
    </div>
  );
}
