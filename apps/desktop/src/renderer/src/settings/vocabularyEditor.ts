import type { VocabularyApi } from '../../../shared/ipc/vocabulary';
import type { Unsubscribe } from '../../../shared/ipc/unsubscribe';
import {
  sameTerm,
  termLength,
  termProblem,
  trimTerm,
  VOCABULARY_LIMITS,
} from '../../../shared/vocabulary';
import { describeError } from '../app/describeError';

/**
 * The jargon list editor's state, without React: VocabularySettings.tsx renders it and calls the
 * methods; the tests drive it under Node with a fake API.
 *
 * Trap: saving is a whole-list replace (`PUT /v1/vocabulary`), so an editor that saves a list it
 * never read wipes the real one. Save is refused, with no request, until a read has answered: while
 * it is out, and after it failed (`load-failed` offers only "Try again"). Keep that refusal in
 * `save()` itself, not only in the page's disabled button (M3 plan, "A rejected jargon list").
 */
export type VocabularyEditorState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'load-failed'; readonly error: string }
  | VocabularyEditing;

export interface VocabularyEditing {
  readonly phase: 'editing';
  /** The list as the API last stored it, in its order. */
  readonly saved: readonly string[];
  /** The list as the person has it now; Save sends it whole. */
  readonly draft: readonly string[];
  /** A save is out; nothing can be edited until it answers, because its answer is the new list. */
  readonly saving: boolean;
  /** Why the last save failed; cleared by the next save or edit. The draft is kept. */
  readonly saveError: string | null;
  /** The last save went through, and nothing changed since. */
  readonly justSaved: boolean;
}

/** What `add` did with the typed text. */
export interface AddResult {
  /** The terms not added that the person can fix (too long, no room), for the box to keep. */
  readonly rest: string;
  /**
   * Why the first term in `rest` was not added; with `rest` empty, why a repeat was skipped; null
   * when everything was added. The box's term comes first: the page shows only this line beside
   * the box, and a skipped repeat is on the list already.
   */
  readonly problem: string | null;
}

/** Where typed or pasted text splits into terms. A term never holds one of these. */
const SEPARATORS = /[,\n\r\t]/;

/** The separators a one-line text box drops from pasted text. */
const PASTED_BREAKS = /[\n\r\t]/;

/** A text box's text and selection, as a paste event's target (an input) has them. */
export interface TextBox {
  readonly value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

/**
 * The box's text once `pasted` is in it, for `add` to split, or null when the paste holds no line
 * break or tab and the box can take it itself. A one-line box drops pasted line breaks ("Linkt",
 * "Roger" on two lines arrive as "LinktRoger"), so the page splits a pasted column itself.
 *
 * Trap: the paste goes where the box would put it, at the caret and over the selection. Appending
 * it to the whole text instead adds what the person selected in order to replace it (a half-typed
 * "Glo", a refused name) as a term, and Save sends it to speech-to-text with every recording.
 */
export function textAfterPaste(box: TextBox, pasted: string): string | null {
  if (!PASTED_BREAKS.test(pasted)) return null;
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? start;
  return box.value.slice(0, start) + pasted + box.value.slice(end);
}

/** How much of a term a message quotes before it cuts it short. */
const QUOTED_CHARS = 28;

export class VocabularyEditor {
  private state: VocabularyEditorState = { phase: 'loading' };
  private readonly listeners = new Set<() => void>();
  /** Counts reads, so an answer to an earlier read, or a save made before it, is dropped. */
  private reads = 0;

  constructor(private readonly api: Pick<VocabularyApi, 'getVocabulary' | 'setVocabulary'>) {}

  readonly getSnapshot = (): VocabularyEditorState => this.state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Reads the stored list; any draft is dropped. Called when the page opens and from "Try again".
   * Never rejects: a failure becomes `load-failed` with main's message.
   */
  async load(): Promise<void> {
    const read = ++this.reads;
    this.set({ phase: 'loading' });
    try {
      const terms = await this.api.getVocabulary();
      if (read !== this.reads) return;
      this.set({
        phase: 'editing',
        saved: terms,
        draft: terms,
        saving: false,
        saveError: null,
        justSaved: false,
      });
    } catch (error) {
      if (read !== this.reads) return;
      this.set({ phase: 'load-failed', error: describeError(error) });
    }
  }

  /**
   * Adds the terms in `text`, split at commas, line breaks and tabs, each trimmed, in order. A term
   * the API would refuse, or one past a list limit, is left out with the reason; a repeat of a
   * term on the list (ignoring case, as the API counts) is skipped. Does nothing unless the list
   * was read and no save is out.
   */
  add(text: string): AddResult {
    const state = this.state;
    if (state.phase !== 'editing' || state.saving) return { rest: text, problem: null };
    const draft = [...state.draft];
    const kept: string[] = [];
    // Two messages, not the first refusal: a repeat skipped before a kept term would otherwise
    // leave that term in the box with no reason, under a message naming a term shown nowhere.
    let keptProblem: string | null = null;
    let skippedProblem: string | null = null;
    for (const term of text.split(SEPARATORS).map(cleanTerm)) {
      if (term === '') continue;
      const refusal = refuse(term, draft);
      if (refusal === null) {
        draft.push(term);
      } else if (refusal.keep) {
        kept.push(term);
        keptProblem ??= refusal.message;
      } else {
        skippedProblem ??= refusal.message;
      }
    }
    if (draft.length > state.draft.length) this.edit(state, draft);
    return { rest: kept.join(', '), problem: keptProblem ?? skippedProblem };
  }

  /** Takes one term off the draft. Does nothing while a save is out. */
  remove(term: string): void {
    const state = this.state;
    if (state.phase !== 'editing' || state.saving) return;
    this.edit(
      state,
      state.draft.filter((other) => other !== term),
    );
  }

  /** Puts the stored list back. */
  discard(): void {
    const state = this.state;
    if (state.phase !== 'editing' || state.saving) return;
    this.edit(state, state.saved);
  }

  /**
   * Sends the draft whole and shows the list as the API stored it. Refused, with no request, unless
   * canSave: before the list was read, after its read failed, while a save is out, or with nothing
   * changed. Never rejects: a failure keeps the draft and sets `saveError`.
   */
  async save(): Promise<void> {
    const state = this.state;
    if (!canSave(state)) return;
    const read = this.reads;
    this.set({ ...state, saving: true, saveError: null, justSaved: false });
    try {
      const stored = await this.api.setVocabulary(state.draft);
      if (read !== this.reads) return;
      this.set({
        phase: 'editing',
        saved: stored,
        draft: stored,
        saving: false,
        saveError: null,
        justSaved: true,
      });
    } catch (error) {
      if (read !== this.reads) return;
      this.set({ ...state, saving: false, saveError: describeError(error), justSaved: false });
    }
  }

  private edit(state: VocabularyEditing, draft: readonly string[]): void {
    this.set({ ...state, draft, saveError: null, justSaved: false });
  }

  private set(state: VocabularyEditorState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

/** True when Save would send something: the list was read, no save is out, and it changed. */
export function canSave(state: VocabularyEditorState): state is VocabularyEditing {
  return state.phase === 'editing' && !state.saving && isChanged(state);
}

/**
 * True when saving would change what the API stores. Order is no change (the API sorts the list
 * itself), a new spelling of a term is (the API keeps the spelling sent).
 */
export function isChanged(state: VocabularyEditing): boolean {
  if (state.draft.length !== state.saved.length) return true;
  const saved = [...state.saved].sort();
  return [...state.draft].sort().some((term, index) => term !== saved[index]);
}

/** The list's size as the API measures it against VOCABULARY_LIMITS. */
export function listSize(terms: readonly string[]): { terms: number; characters: number } {
  return {
    terms: terms.length,
    characters: terms.reduce((sum, term) => sum + termLength(trimTerm(term)), 0),
  };
}

/**
 * A typed or pasted piece as a term: trimmed as the API trims it (trimTerm), and first of a byte
 * order mark, which the API would keep inside the term and send to speech-to-text. Trap: trimTerm
 * alone keeps a pasted mark; trim() alone keeps U+0085, so a piece of only that would join the
 * draft as a term the API calls blank, and main would refuse the whole list at Save.
 */
function cleanTerm(piece: string): string {
  return trimTerm(piece.trim());
}

/** Why `term` cannot join `draft`, and whether the box should keep it to fix; null when it can. */
function refuse(term: string, draft: readonly string[]): { message: string; keep: boolean } | null {
  const { maxTerms, maxTermChars, maxTotalChars } = VOCABULARY_LIMITS;
  const problem = termProblem(term);
  if (problem?.kind === 'too-long') {
    return {
      message: `${quote(term)} is ${problem.length} characters long. A term can have at most ${maxTermChars}.`,
      keep: true,
    };
  }
  if (problem?.kind === 'control-character') {
    return { message: `${quote(term)} has a control character in it.`, keep: true };
  }
  const existing = draft.find((other) => sameTerm(other, term));
  if (existing !== undefined) {
    return { message: `${quote(existing)} is already on the list.`, keep: false };
  }
  if (draft.length >= maxTerms) {
    return {
      message: `The list is full: it can hold ${maxTerms} terms. Remove one to add another.`,
      keep: true,
    };
  }
  const total = listSize([...draft, term]).characters;
  if (total > maxTotalChars) {
    return {
      message: `${quote(term)} would bring the list to ${total} characters. It can hold ${maxTotalChars} in all.`,
      keep: true,
    };
  }
  return null;
}

/** A term in double quotes for a message, cut short past QUOTED_CHARS code points. */
function quote(term: string): string {
  const chars = Array.from(term);
  if (chars.length <= QUOTED_CHARS) return `"${term}"`;
  return `"${chars.slice(0, QUOTED_CHARS).join('').trimEnd()}…"`;
}
