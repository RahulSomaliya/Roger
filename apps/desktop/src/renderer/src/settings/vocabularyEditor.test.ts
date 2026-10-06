import { describe, expect, it, vi } from 'vitest';
import type { VocabularyApi } from '../../../shared/ipc/vocabulary';
import { VOCABULARY_LIMITS } from '../../../shared/vocabulary';
import {
  canSave,
  isChanged,
  listSize,
  textAfterPaste,
  VocabularyEditor,
  type VocabularyEditorState,
} from './vocabularyEditor';

/** A promise the test settles by hand, to hold the API's answer mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** As main's errors reach the page: wrapped by Electron (app/describeError.ts strips it). */
const ipcError = (channel: string, message: string): Error =>
  new Error(`Error invoking remote method '${channel}': ApiError: ${message}`);

const OFFLINE = 'GET /v1/vocabulary failed: connect ECONNREFUSED 127.0.0.1:8000';

function setUp() {
  const reads: ReturnType<typeof deferred<string[]>>[] = [];
  const saves: ReturnType<typeof deferred<string[]>>[] = [];
  const api = {
    getVocabulary: vi.fn<VocabularyApi['getVocabulary']>(() => {
      const read = deferred<string[]>();
      reads.push(read);
      return read.promise;
    }),
    setVocabulary: vi.fn<VocabularyApi['setVocabulary']>(() => {
      const save = deferred<string[]>();
      saves.push(save);
      return save.promise;
    }),
  };
  const editor = new VocabularyEditor(api);
  const seen: VocabularyEditorState[] = [];
  editor.subscribe(() => seen.push(editor.getSnapshot()));
  return { api, editor, reads, saves, seen };
}

/** An editor that has read `terms`. */
async function loaded(terms: string[] = ['Linkt', 'Roger']) {
  const context = setUp();
  const load = context.editor.load();
  context.reads[0]!.resolve(terms);
  await load;
  return context;
}

function editing(editor: VocabularyEditor) {
  const state = editor.getSnapshot();
  if (state.phase !== 'editing') throw new Error(`expected editing, got ${state.phase}`);
  return state;
}

describe('loading the list', () => {
  it('shows the stored list once main answers, unchanged and with nothing to save', async () => {
    const { editor, reads, seen } = setUp();
    expect(editor.getSnapshot()).toEqual({ phase: 'loading' });
    const load = editor.load();
    reads[0]!.resolve(['Linkt', 'Roger']);
    await load;

    const state = editing(editor);
    expect(state).toEqual({
      phase: 'editing',
      saved: ['Linkt', 'Roger'],
      draft: ['Linkt', 'Roger'],
      saving: false,
      saveError: null,
      justSaved: false,
    });
    expect(isChanged(state)).toBe(false);
    expect(canSave(state)).toBe(false);
    expect(seen.at(-1)).toBe(state);
  });

  it("shows why the read failed in main's words, without Electron's wrapper", async () => {
    const { editor, reads } = setUp();
    const load = editor.load();
    reads[0]!.reject(ipcError('vocabulary:get', OFFLINE));
    await load;
    expect(editor.getSnapshot()).toEqual({ phase: 'load-failed', error: OFFLINE });
  });

  it('reads again on retry, and the list shows once the API answers', async () => {
    const { editor, reads } = setUp();
    const first = editor.load();
    reads[0]!.reject(ipcError('vocabulary:get', OFFLINE));
    await first;
    const retry = editor.load();
    expect(editor.getSnapshot()).toEqual({ phase: 'loading' });
    reads[1]!.resolve(['Linkt']);
    await retry;
    expect(editing(editor).saved).toEqual(['Linkt']);
  });

  it('keeps only the latest read: an earlier answer that comes late is dropped', async () => {
    const { editor, reads } = setUp();
    const first = editor.load();
    const second = editor.load();
    reads[1]!.resolve(['Newer']);
    await second;
    reads[0]!.resolve(['Older']);
    await first;
    expect(editing(editor).saved).toEqual(['Newer']);
  });
});

describe('saving is refused unless the list was read', () => {
  // The whole point of the load state: PUT replaces the whole list, so an editor that never read
  // it would save an empty or partial list over the real one (M3 plan, "A rejected jargon list").
  it('sends nothing after a failed read, even when asked to, and offers no edits', async () => {
    const { api, editor, reads } = setUp();
    const load = editor.load();
    reads[0]!.reject(ipcError('vocabulary:get', OFFLINE));
    await load;

    expect(editor.add('Linkt')).toEqual({ rest: 'Linkt', problem: null });
    await editor.save();

    expect(api.setVocabulary).not.toHaveBeenCalled();
    expect(editor.getSnapshot()).toEqual({ phase: 'load-failed', error: OFFLINE });
    expect(canSave(editor.getSnapshot())).toBe(false);
  });

  it('sends nothing while the read is still out', async () => {
    const { api, editor } = setUp();
    void editor.load();
    editor.add('Linkt');
    await editor.save();
    expect(api.setVocabulary).not.toHaveBeenCalled();
    expect(editor.getSnapshot()).toEqual({ phase: 'loading' });
  });

  it('sends nothing when the draft equals the stored list', async () => {
    const { api, editor } = await loaded();
    await editor.save();
    expect(api.setVocabulary).not.toHaveBeenCalled();
  });
});

describe('adding terms', () => {
  it('trims each term and adds it at the end', async () => {
    const { editor } = await loaded();
    expect(editor.add('  AssemblyAI  ')).toEqual({ rest: '', problem: null });
    const state = editing(editor);
    expect(state.draft).toEqual(['Linkt', 'Roger', 'AssemblyAI']);
    expect(state.saved).toEqual(['Linkt', 'Roger']);
    expect(isChanged(state)).toBe(true);
    expect(canSave(state)).toBe(true);
  });

  it('adds several at once, split at commas, line breaks and tabs', async () => {
    const { editor } = await loaded([]);
    const pasted = ['Linkt, Roger', 'AssemblyAI', 'Deepgram\tGranola', '', ' , '].join('\n');
    expect(editor.add(pasted)).toEqual({ rest: '', problem: null });
    expect(editing(editor).draft).toEqual(['Linkt', 'Roger', 'AssemblyAI', 'Deepgram', 'Granola']);
  });

  it('does nothing for blank text', async () => {
    const { editor, seen } = await loaded();
    const before = seen.length;
    expect(editor.add('   ')).toEqual({ rest: '', problem: null });
    expect(seen).toHaveLength(before);
  });

  it('skips a term already on the list in another case, naming the spelling kept', async () => {
    const { editor } = await loaded();
    expect(editor.add('LINKT, Granola, granola')).toEqual({
      rest: '',
      problem: '"Linkt" is already on the list.',
    });
    expect(editing(editor).draft).toEqual(['Linkt', 'Roger', 'Granola']);
  });

  it('keeps a term that is too long in the box to shorten, and adds the rest', async () => {
    const { editor } = await loaded([]);
    const long = 'Linkt Holdings International Limited Liability Corp';
    expect(long).toHaveLength(51);
    expect(editor.add(`Roger, ${long}`)).toEqual({
      rest: long,
      problem: '"Linkt Holdings International…" is 51 characters long. A term can have at most 50.',
    });
    expect(editing(editor).draft).toEqual(['Roger']);
  });

  it('names why the term left in the box was refused, not a repeat skipped before it', async () => {
    const { editor } = await loaded(['Linkt', 'Roger']);
    const long = 'Linkt Holdings International Limited Liability Corp';
    expect(editor.add(`Roger, ${long}`)).toEqual({
      rest: long,
      problem: '"Linkt Holdings International…" is 51 characters long. A term can have at most 50.',
    });

    const full = Array.from({ length: VOCABULARY_LIMITS.maxTerms - 1 }, (_, i) => `t${i}`);
    const { editor: fullEditor } = await loaded(['Linkt', ...full]);
    expect(fullEditor.add('Linkt, Roger')).toEqual({
      rest: 'Roger',
      problem: 'The list is full: it can hold 100 terms. Remove one to add another.',
    });
  });

  it('refuses a term with a control character in it', async () => {
    const { editor } = await loaded([]);
    const term = `Ro${String.fromCharCode(0x7f)}ger`;
    expect(editor.add(term)).toEqual({
      rest: term,
      problem: `"${term}" has a control character in it.`,
    });
    expect(editing(editor).draft).toEqual([]);
  });

  it('stops at 100 terms, and keeps what did not fit in the box', async () => {
    const full = Array.from({ length: VOCABULARY_LIMITS.maxTerms - 1 }, (_, i) => `t${i}`);
    const { editor } = await loaded(full);
    expect(editor.add('Linkt, Roger')).toEqual({
      rest: 'Roger',
      problem: 'The list is full: it can hold 100 terms. Remove one to add another.',
    });
    expect(editing(editor).draft).toHaveLength(100);
  });

  it('stops at 800 characters in all', async () => {
    // 15 terms of 50 characters (750), then 46 more: 796, so a 5-letter term no longer fits.
    const terms = Array.from({ length: 15 }, (_, i) => `${i}`.padEnd(50, 'x'));
    const { editor } = await loaded(terms);
    const fits = 'a'.repeat(46);
    expect(editor.add(`${fits}, Roger, Linkt`)).toEqual({
      rest: 'Roger, Linkt',
      problem: '"Roger" would bring the list to 801 characters. It can hold 800 in all.',
    });
    expect(listSize(editing(editor).draft)).toEqual({ terms: 16, characters: 796 });
  });
});

describe('textAfterPaste', () => {
  /** The box as a paste event's target has it: its text and the selected part of it. */
  const box = (value: string, selectionStart: number, selectionEnd = selectionStart) => ({
    value,
    selectionStart,
    selectionEnd,
  });

  it('leaves a paste with no line break or tab to the box itself', () => {
    expect(textAfterPaste(box('Glo', 0, 3), 'Globex')).toBeNull();
    expect(textAfterPaste(box('', 0), 'Linkt, Roger')).toBeNull();
  });

  it('puts a pasted column over the selection: text selected to replace is never added', async () => {
    const { editor } = await loaded();
    const text = textAfterPaste(box('Glo', 0, 3), 'Initech\nGlobex');
    expect(text).toBe('Initech\nGlobex');
    expect(editor.add(text ?? '')).toEqual({ rest: '', problem: null });
    expect(editing(editor).draft).toEqual(['Linkt', 'Roger', 'Initech', 'Globex']);

    // A refused name kept in the box, selected whole and pasted over, is gone with its reason.
    const long = 'Linkt Holdings International Limited Liability Corp';
    expect(textAfterPaste(box(long, 0, long.length), 'Hooli\r\nUmbrella')).toBe(
      'Hooli\r\nUmbrella',
    );
  });

  it('puts it at the caret, as the box would, splitting only where the paste breaks', () => {
    expect(textAfterPaste(box('Linkt, ', 7), 'Initech\nGlobex')).toBe('Linkt, Initech\nGlobex');
    expect(textAfterPaste(box('Linkt, Roger', 7, 12), 'Initech\tGlobex')).toBe(
      'Linkt, Initech\tGlobex',
    );
    expect(textAfterPaste(box('Linkt', 0), 'Initech\n')).toBe('Initech\nLinkt');
  });

  it('adds at the end when the box reports no selection', () => {
    const noSelection = { value: 'Linkt, ', selectionStart: null, selectionEnd: null };
    expect(textAfterPaste(noSelection, 'Initech\nGlobex')).toBe('Linkt, Initech\nGlobex');
  });
});

describe('removing and discarding', () => {
  it('removes one term from the draft', async () => {
    const { editor } = await loaded(['Linkt', 'Roger', 'Granola']);
    editor.remove('Roger');
    expect(editing(editor).draft).toEqual(['Linkt', 'Granola']);
  });

  it('puts the stored list back on discard', async () => {
    const { editor } = await loaded();
    editor.add('Granola');
    editor.remove('Linkt');
    editor.discard();
    const state = editing(editor);
    expect(state.draft).toEqual(state.saved);
    expect(isChanged(state)).toBe(false);
  });

  it('calls the same terms in another order no change: the API sorts them anyway', async () => {
    const { editor } = await loaded();
    editor.remove('Linkt');
    editor.add('Linkt');
    const state = editing(editor);
    expect(state.draft).toEqual(['Roger', 'Linkt']);
    expect(isChanged(state)).toBe(false);
  });

  it('calls a new spelling of a term a change', async () => {
    const { editor } = await loaded();
    editor.remove('Linkt');
    editor.add('LinkT');
    expect(isChanged(editing(editor))).toBe(true);
  });
});

describe('saving', () => {
  it('sends the whole draft and then shows the list as the API stored it', async () => {
    const { api, editor, saves } = await loaded();
    editor.add('granola, AssemblyAI');
    const save = editor.save();

    expect(api.setVocabulary).toHaveBeenCalledWith(['Linkt', 'Roger', 'granola', 'AssemblyAI']);
    expect(editing(editor)).toMatchObject({ saving: true, saveError: null });
    expect(canSave(editor.getSnapshot())).toBe(false);
    // No edits while the list is on its way: the answer replaces the draft.
    expect(editor.add('Deepgram')).toEqual({ rest: 'Deepgram', problem: null });
    editor.remove('Linkt');

    saves[0]!.resolve(['AssemblyAI', 'granola', 'Linkt', 'Roger']);
    await save;
    expect(editing(editor)).toEqual({
      phase: 'editing',
      saved: ['AssemblyAI', 'granola', 'Linkt', 'Roger'],
      draft: ['AssemblyAI', 'granola', 'Linkt', 'Roger'],
      saving: false,
      saveError: null,
      justSaved: true,
    });
  });

  it('says "saved" only until the next edit', async () => {
    const { editor, saves } = await loaded();
    editor.add('Granola');
    const save = editor.save();
    saves[0]!.resolve(['Granola', 'Linkt', 'Roger']);
    await save;
    editor.remove('Granola');
    expect(editing(editor).justSaved).toBe(false);
  });

  it('keeps the draft and shows why when the save fails, and saves on retry', async () => {
    const { api, editor, saves } = await loaded();
    editor.add('Granola');
    const first = editor.save();
    saves[0]!.reject(
      ipcError('vocabulary:set', 'PUT /v1/vocabulary failed: connect ECONNREFUSED 127.0.0.1:8000'),
    );
    await first;
    expect(editing(editor)).toMatchObject({
      draft: ['Linkt', 'Roger', 'Granola'],
      saved: ['Linkt', 'Roger'],
      saving: false,
      saveError: 'PUT /v1/vocabulary failed: connect ECONNREFUSED 127.0.0.1:8000',
    });
    expect(canSave(editor.getSnapshot())).toBe(true);

    const retry = editor.save();
    expect(editing(editor).saveError).toBeNull();
    saves[1]!.resolve(['Granola', 'Linkt', 'Roger']);
    await retry;
    expect(api.setVocabulary).toHaveBeenCalledTimes(2);
    expect(editing(editor)).toMatchObject({
      saved: ['Granola', 'Linkt', 'Roger'],
      justSaved: true,
    });
  });

  it('sends one save at a time', async () => {
    const { api, editor } = await loaded();
    editor.add('Granola');
    void editor.save();
    await editor.save();
    expect(api.setVocabulary).toHaveBeenCalledTimes(1);
  });
});

describe('listSize', () => {
  it('counts terms and characters as the API does: trimmed code points', () => {
    expect(listSize([])).toEqual({ terms: 0, characters: 0 });
    expect(listSize(['Linkt', `ab${String.fromCodePoint(0x1f600)}`])).toEqual({
      terms: 2,
      characters: 8,
    });
  });
});

describe('subscribe', () => {
  it('stops telling a listener once it unsubscribes', async () => {
    const { editor, reads } = setUp();
    const listener = vi.fn();
    const unsubscribe = editor.subscribe(listener);
    const load = editor.load();
    unsubscribe();
    reads[0]!.resolve([]);
    await load;
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
