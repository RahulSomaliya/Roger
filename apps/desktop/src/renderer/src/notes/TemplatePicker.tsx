import { useId } from 'react';
import type { NoteTemplate } from '../../../shared/notes';
import type { Loadable } from './aiNotesActions';
import './aiNotes.css';

/**
 * The notes templates as a choice (M4 "When notes generate"): "Which kind of call was this?" when
 * Roger could not tell at Stop, and the pick behind Generate and Regenerate. One click picks: each
 * template is a button with what it is for. The suggestion (shared/suggestTemplate.ts, the rule
 * main uses at Stop) is marked, and takes the focus when the user opened the picker; the template
 * of the AI notes on show is marked "In use". Templates are API data (M4-T3), in the panel's order
 * (aiNotesActions.ts, `orderTemplates`).
 */

export interface TemplatePickerProps {
  question: string;
  /** What a pick does, under the question. */
  hint?: string;
  templates: Loadable<NoteTemplate[]>;
  /** Marked "Suggested". */
  suggested: string | null;
  /** Marked "In use": the template of the AI notes on show. */
  current?: string | null;
  /**
   * Moves the focus to the suggestion, else the first template: only when the user opened the
   * picker (the button that opened it is gone), never when it appears on its own.
   */
  takeFocus?: boolean;
  /** A pick is on its way. */
  disabled: boolean;
  onPick: (templateId: string) => void;
  /** Reads the template list again after it failed. */
  onReload: () => void;
  /** "Not now" or "Cancel". */
  dismiss?: { label: string; onDismiss: () => void };
}

export function TemplatePicker({
  question,
  hint,
  templates,
  suggested,
  current = null,
  takeFocus = false,
  disabled,
  onPick,
  onReload,
  dismiss,
}: TemplatePickerProps) {
  const questionId = useId();
  return (
    <div className="template-picker" role="group" aria-labelledby={questionId}>
      <p id={questionId} className="template-picker-question">
        {question}
      </p>
      {hint === undefined ? null : <p className="template-picker-hint">{hint}</p>}
      <TemplateOptions
        templates={templates}
        suggested={suggested}
        current={current}
        takeFocus={takeFocus}
        disabled={disabled}
        onPick={onPick}
        onReload={onReload}
      />
      {dismiss === undefined ? null : (
        <div className="template-picker-actions">
          <button
            type="button"
            className="btn"
            data-variant="secondary"
            data-size="sm"
            onClick={dismiss.onDismiss}
          >
            {dismiss.label}
          </button>
        </div>
      )}
    </div>
  );
}

type TemplateOptionsProps = Pick<
  TemplatePickerProps,
  'templates' | 'suggested' | 'disabled' | 'onPick' | 'onReload'
> & { current: string | null; takeFocus: boolean };

function TemplateOptions({
  templates,
  suggested,
  current,
  takeFocus,
  disabled,
  onPick,
  onReload,
}: TemplateOptionsProps) {
  switch (templates.status) {
    case 'loading':
      return (
        <p className="template-picker-hint" role="status">
          Loading the templates...
        </p>
      );
    case 'failed':
      return (
        <div className="error template-picker-error" role="alert">
          <span>Roger could not load the templates: {templates.error}</span>
          <button
            type="button"
            className="btn"
            data-variant="secondary"
            data-size="sm"
            onClick={onReload}
          >
            Try again
          </button>
        </div>
      );
    case 'ready': {
      if (templates.value.length === 0) {
        // The API validates its templates at startup, so an empty list is a broken API.
        return (
          <p className="error template-picker-error" role="alert">
            Roger has no templates to offer. Try again once its server is back to normal.
          </p>
        );
      }
      const focused = templates.value.some((template) => template.id === suggested)
        ? suggested
        : (templates.value[0]?.id ?? null);
      return (
        <ul className="template-picker-options">
          {templates.value.map((template) => {
            const isSuggested = template.id === suggested;
            const badge = isSuggested ? 'Suggested' : template.id === current ? 'In use' : null;
            return (
              <li key={template.id}>
                <button
                  type="button"
                  className={
                    isSuggested ? 'template-option template-option-suggested' : 'template-option'
                  }
                  disabled={disabled}
                  autoFocus={takeFocus && template.id === focused}
                  onClick={() => {
                    onPick(template.id);
                  }}
                >
                  <span className="template-option-name">{template.name}</span>
                  {badge === null ? null : <span className="template-option-badge">{badge}</span>}
                  <span className="template-option-description">{template.description}</span>
                </button>
              </li>
            );
          })}
        </ul>
      );
    }
  }
}
