import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VocabularyEditing, VocabularyEditorState } from './vocabularyEditor';
import { VocabularySection, type VocabularyEditorActions } from './VocabularySettings';

const OFFLINE = 'GET /v1/vocabulary failed: connect ECONNREFUSED 127.0.0.1:8000';

function actions(): VocabularyEditorActions {
  return {
    load: vi.fn(() => Promise.resolve()),
    add: vi.fn(() => ({ rest: '', problem: null })),
    remove: vi.fn(),
    discard: vi.fn(),
    save: vi.fn(() => Promise.resolve()),
  };
}

/**
 * The section's markup for one state, without the empty comments React's server output puts
 * between adjacent text pieces (`2<!-- --> of <!-- -->100`), so text reads as the page shows it.
 */
function render(state: VocabularyEditorState): string {
  return renderToString(createElement(VocabularySection, { state, editor: actions() })).replaceAll(
    '<!-- -->',
    '',
  );
}

function editing(fields: Partial<VocabularyEditing> = {}): VocabularyEditing {
  return {
    phase: 'editing',
    saved: ['Linkt', 'Roger'],
    draft: ['Linkt', 'Roger'],
    saving: false,
    saveError: null,
    justSaved: false,
    ...fields,
  };
}

/** The Save button's tag, to read its state. */
function saveButton(html: string): string {
  const tag = /<button[^>]*vocabulary-save[^>]*>/.exec(html)?.[0];
  if (tag === undefined) throw new Error('no Save button');
  return tag;
}

describe('the jargon list section', () => {
  it('is a titled section in every state', () => {
    for (const state of [
      { phase: 'loading' } as const,
      { phase: 'load-failed', error: OFFLINE } as const,
      editing(),
    ]) {
      const html = render(state);
      expect(html).toMatch(/<section[^>]*aria-labelledby="([^"]+)"/);
      const id = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
      expect(html).toContain(`id="${id ?? ''}"`);
      expect(html).toContain('Jargon list</h2>');
    }
  });

  it('says it is loading, with nothing to edit or save yet', () => {
    const html = render({ phase: 'loading' });
    expect(html).toMatch(/role="status"[^>]*>Loading the jargon list…</);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('vocabulary-save');
  });

  it('shows why a read failed and offers only Try again: no box, no Save', () => {
    const html = render({ phase: 'load-failed', error: OFFLINE });
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain(`Couldn’t load the jargon list: ${OFFLINE}`);
    expect(html).toContain('>Try again</button>');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('vocabulary-save');
  });

  it('lists each term with its own Remove button, and the list size against the limits', () => {
    const html = render(editing());
    expect(html).toMatch(/<li[^>]*>.*Linkt.*aria-label="Remove Linkt".*<\/li>/);
    expect(html).toMatch(/aria-label="Remove Roger"/);
    expect(html).toContain('2 of 100 terms · 10 of 800 characters');
    expect(html).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Add terms<\/label>/);
  });

  it('says so when the list is empty', () => {
    const html = render(editing({ saved: [], draft: [] }));
    expect(html).toContain('No terms yet.');
    expect(html).not.toContain('<ul');
  });

  it('offers Save only for a changed list, with Discard beside it', () => {
    expect(saveButton(render(editing()))).toContain('disabled');
    const changed = render(editing({ draft: ['Linkt', 'Roger', 'Granola'] }));
    expect(saveButton(changed)).not.toContain('disabled');
    expect(changed).toContain('Unsaved changes');
    expect(changed).toContain('>Discard changes</button>');
  });

  it('locks the box and the list while a save is out', () => {
    const html = render(editing({ draft: ['Linkt', 'Roger', 'Granola'], saving: true }));
    expect(saveButton(html)).toContain('disabled');
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).toMatch(
      /aria-label="Remove Linkt"[^>]*disabled|disabled[^>]*aria-label="Remove Linkt"/,
    );
    expect(html).toContain('Saving…');
  });

  it('shows why a save failed and keeps the changes to save again', () => {
    const html = render(
      editing({
        draft: ['Linkt', 'Roger', 'Granola'],
        saveError: 'PUT /v1/vocabulary failed: connect ECONNREFUSED 127.0.0.1:8000',
      }),
    );
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain(
      'Couldn’t save the jargon list: PUT /v1/vocabulary failed: connect ECONNREFUSED 127.0.0.1:8000',
    );
    expect(saveButton(html)).not.toContain('disabled');
  });

  it('confirms a save until the next edit', () => {
    const html = render(editing({ justSaved: true }));
    expect(html).toContain('Saved. New recordings use this list.');
  });
});
