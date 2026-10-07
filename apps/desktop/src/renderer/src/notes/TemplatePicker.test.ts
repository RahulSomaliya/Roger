import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { NoteTemplate } from '../../../shared/notes';
import type { Loadable } from './aiNotesActions';
import { TemplatePicker, type TemplatePickerProps } from './TemplatePicker';

const TEMPLATES: NoteTemplate[] = [
  { id: 'general', name: 'General', description: 'Any call.', sections: [] },
  { id: 'one_on_one', name: '1:1', description: 'Updates and feedback.', sections: [] },
  { id: 'client_call', name: 'Client call', description: 'Their goals.', sections: [] },
  { id: 'standup', name: 'Standup', description: 'Done, next, blockers.', sections: [] },
];

const ready: Loadable<NoteTemplate[]> = { status: 'ready', value: TEMPLATES };

function render(props: Partial<TemplatePickerProps> = {}): string {
  return renderToStaticMarkup(
    createElement(TemplatePicker, {
      question: 'Which kind of call was this?',
      templates: ready,
      suggested: null,
      disabled: false,
      onPick: () => undefined,
      onReload: () => undefined,
      ...props,
    }),
  ).replaceAll('<!-- -->', '');
}

describe('TemplatePicker', () => {
  it('asks the question and offers every template in order, each with what it is for', () => {
    const html = render({ hint: 'Roger writes the AI notes in its shape.' });
    expect(html).toMatch(/^<div class="template-picker" role="group" aria-labelledby="[^"]+">/);
    expect(html).toContain('>Which kind of call was this?</p>');
    expect(html).toContain('>Roger writes the AI notes in its shape.</p>');
    const names = [...html.matchAll(/class="template-option-name">([^<]+)</g)].map(
      (match) => match[1],
    );
    expect(names).toEqual(['General', '1:1', 'Client call', 'Standup']);
    expect(html).toContain('>Done, next, blockers.<');
    expect(html.match(/<button type="button" class="template-option"/g)).toHaveLength(4);
  });

  it('marks the suggested template and the one in use', () => {
    const html = render({ suggested: 'client_call', current: 'standup' });
    expect(html).toMatch(
      /<button type="button" class="template-option template-option-suggested"[^>]*><span class="template-option-name">Client call<\/span><span class="template-option-badge">Suggested<\/span>/,
    );
    expect(html).toMatch(
      /<span class="template-option-name">Standup<\/span><span class="template-option-badge">In use<\/span>/,
    );
    expect(html.match(/template-option-badge/g)).toHaveLength(2);
  });

  it('says it is loading, or why the templates could not load, with Try again', () => {
    expect(render({ templates: { status: 'loading' } })).toContain('Loading the templates...');
    const failed = render({ templates: { status: 'failed', error: 'Roger is offline' } });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Roger could not load the templates: Roger is offline');
    expect(failed).toContain('>Try again</button>');
    expect(failed).not.toContain('template-option');
    expect(render({ templates: { status: 'ready', value: [] } })).toContain(
      'Roger has no templates to offer',
    );
  });

  it('disables the templates while a pick is on its way, and offers a way out', () => {
    const html = render({
      disabled: true,
      dismiss: { label: 'Not now', onDismiss: () => undefined },
    });
    expect(
      html.match(/<button type="button" class="template-option"[^>]* disabled=""/g),
    ).toHaveLength(4);
    expect(html).toContain('<button type="button" class="note-button">Not now</button>');
  });
});
