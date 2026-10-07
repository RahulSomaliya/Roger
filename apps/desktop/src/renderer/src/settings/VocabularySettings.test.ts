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
    ...fields,
  };
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
  });

  it('shows why a read failed and offers only Try again: no box to add into', () => {
    const html = render({ phase: 'load-failed', error: OFFLINE });
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain(`Couldn’t load the jargon list: ${OFFLINE}`);
    expect(html).toContain('>Try again</button>');
    expect(html).not.toContain('<input');
  });

  it('lists each term with its own Remove button', () => {
    const html = render(editing());
    expect(html).toMatch(/<li[^>]*>.*Linkt.*aria-label="Remove Linkt".*<\/li>/);
    expect(html).toMatch(/aria-label="Remove Roger"/);
    expect(html).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Add terms<\/label>/);
  });

  it('has no Save, no Discard and no unsaved state: every change saves at once', () => {
    const html = render(editing({ draft: ['Linkt', 'Roger', 'Granola'] }));
    expect(html).not.toContain('Save');
    expect(html).not.toContain('Discard');
    expect(html).not.toContain('Unsaved');
    expect(html).not.toContain('Saved');
  });

  it('shows no empty-state panel for an empty list: the box says what goes there', () => {
    const html = render(editing({ saved: [], draft: [] }));
    expect(html).not.toContain('No terms yet');
    expect(html).not.toContain('<ul');
    expect(html).toMatch(/<input[^>]*placeholder="Add names/);
  });

  it('names the limits only near one', () => {
    const quiet = render(editing());
    expect(quiet).not.toContain(' of 100 terms');
    expect(quiet).not.toContain(' of 800 characters');
    const full = Array.from({ length: 85 }, (_, i) => `t${i}`);
    const near = render(editing({ saved: full, draft: full }));
    expect(near).toContain('85 of 100 terms · ');
    expect(near).toContain(' of 800 characters');
  });

  // A disabled box drops the caret: adding several terms in a row must keep typing.
  it('keeps the box and the Remove buttons usable while a save is out', () => {
    const html = render(editing({ draft: ['Linkt', 'Roger', 'Granola'], saving: true }));
    expect(html).not.toMatch(/<input[^>]*disabled/);
    expect(html).not.toMatch(/aria-label="Remove Linkt"[^>]*disabled/);
  });

  it('says Not saved with the reason, and offers Try again, when a save failed', () => {
    const html = render(
      editing({
        draft: ['Linkt', 'Roger', 'Granola'],
        saveError: 'PUT /v1/vocabulary failed: connect ECONNREFUSED 127.0.0.1:8000',
      }),
    );
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain(
      'Not saved: PUT /v1/vocabulary failed: connect ECONNREFUSED 127.0.0.1:8000',
    );
    expect(html).toContain('>Try again</button>');
    // The term stays on the page, so the person sees what was not saved.
    expect(html).toContain('Granola');
  });

  it('has no problem line while nothing is wrong', () => {
    expect(render(editing())).not.toContain('role="alert"');
  });
});
