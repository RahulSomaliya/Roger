import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { VOCABULARY_LIMITS } from '../../../shared/vocabulary';
import {
  canSave,
  isChanged,
  listSize,
  textAfterPaste,
  type VocabularyEditing,
  VocabularyEditor,
  type VocabularyEditorState,
} from './vocabularyEditor';
import './vocabulary.css';

/** What the section calls on the editor; VocabularyEditor is one, a test passes spies. */
export type VocabularyEditorActions = Pick<
  VocabularyEditor,
  'load' | 'add' | 'remove' | 'discard' | 'save'
>;

/**
 * Settings: the workspace jargon list, the names speech-to-text should spell right. M3-T9 mounts
 * it in the shell's `settings` slot. The list lives in the Roger API; this reads it when it opens
 * and saves it whole on Save (vocabularyEditor.ts, which refuses a save before a read).
 */
export function VocabularySettings() {
  // One editor per mount: leaving Settings drops it with any save still out, and coming back reads
  // at once. Main answers that read only after the save (main/vocabulary/vocabularyIpc.ts), or the
  // page would show the list from before it as saved and the next Save would undo the change.
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
    <section className="card vocabulary" aria-labelledby={headingId}>
      <h2 id={headingId} className="vocabulary-title">
        Jargon list
      </h2>
      <p className="vocabulary-intro">
        Names and words transcripts should spell right: your company, clients, products and people.
        Every recording in your workspace sends this list to speech-to-text when it starts.
      </p>
      <VocabularyBody state={state} editor={editor} />
    </section>
  );
}

function VocabularyBody({ state, editor }: VocabularySectionProps) {
  switch (state.phase) {
    case 'loading':
      return (
        <p className="vocabulary-status" role="status">
          Loading the jargon list…
        </p>
      );
    case 'load-failed':
      // No box and no Save here: saving replaces the whole list, so one never read is never saved.
      return (
        <div className="vocabulary-failed">
          <div className="error" role="alert">
            <p className="vocabulary-error-text">Couldn’t load the jargon list: {state.error}</p>
            <p className="vocabulary-error-text">
              Your saved terms are safe: Roger edits the list only after it has read it.
            </p>
          </div>
          <div className="vocabulary-actions">
            <button
              type="button"
              className="shell-button"
              onClick={() => {
                void editor.load();
              }}
            >
              Try again
            </button>
          </div>
        </div>
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
  const hintId = useId();
  const problemId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const { maxTerms, maxTermChars, maxTotalChars } = VOCABULARY_LIMITS;
  const size = listSize(state.draft);
  const changed = isChanged(state);

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
        <input
          ref={input}
          id={inputId}
          className="vocabulary-input"
          type="text"
          value={text}
          placeholder="Add a name, like Linkt"
          autoComplete="off"
          spellCheck={false}
          disabled={state.saving}
          aria-invalid={problem !== null}
          aria-describedby={problem === null ? hintId : `${problemId} ${hintId}`}
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
          className="shell-button"
          disabled={state.saving || text.trim() === ''}
        >
          Add
        </button>
      </form>
      <p id={hintId} className="vocabulary-hint">
        Separate several with commas. Up to {maxTerms} terms of {maxTermChars} characters,{' '}
        {maxTotalChars} characters in all.
      </p>
      {problem === null ? null : (
        <p id={problemId} className="vocabulary-problem" role="alert">
          {problem}
        </p>
      )}

      {state.draft.length === 0 ? (
        <p className="vocabulary-empty">No terms yet. Add the names Roger gets wrong.</p>
      ) : (
        <ul className="vocabulary-terms" aria-label="Terms">
          {state.draft.map((term) => (
            <li key={term} className="vocabulary-term">
              <span className="vocabulary-term-text">{term}</span>
              <button
                type="button"
                className="vocabulary-remove"
                aria-label={`Remove ${term}`}
                title={`Remove ${term}`}
                disabled={state.saving}
                onClick={() => {
                  editor.remove(term);
                  // The button goes with its term; keep the keyboard in the editor.
                  input.current?.focus();
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="vocabulary-size">
        {size.terms} of {maxTerms} terms · {size.characters} of {maxTotalChars} characters
      </p>

      {state.saveError === null ? null : (
        <div className="error" role="alert">
          <p className="vocabulary-error-text">Couldn’t save the jargon list: {state.saveError}</p>
          <p className="vocabulary-error-text">Your changes are still here. Save to try again.</p>
        </div>
      )}
      <div className="vocabulary-actions">
        <p className="vocabulary-save-status" role="status">
          {saveStatus(state, changed)}
        </p>
        <div className="vocabulary-buttons">
          {changed ? (
            <button
              type="button"
              className="shell-button"
              disabled={state.saving}
              onClick={() => {
                setProblem(null);
                editor.discard();
              }}
            >
              Discard changes
            </button>
          ) : null}
          <button
            type="button"
            className="button start vocabulary-save"
            disabled={!canSave(state)}
            onClick={() => {
              void editor.save();
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function saveStatus(state: VocabularyEditing, changed: boolean): string {
  if (state.saving) return 'Saving…';
  if (state.justSaved) return 'Saved. New recordings use this list.';
  return changed ? 'Unsaved changes' : '';
}
