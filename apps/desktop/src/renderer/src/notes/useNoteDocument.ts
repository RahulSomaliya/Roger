import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { NotesApi, ResolveNoteConflictRequest } from '../../../shared/ipc/notes';
import type { Unsubscribe } from '../../../shared/ipc/unsubscribe';
import type { LocalNote, NoteDoc, NoteKind } from '../../../shared/notes';
import { describeError } from '../app/describeError';

/**
 * One note of a meeting (My notes or AI notes) as an open editor sees it: loaded from main's
 * notes.sqlite, saved back through main, and followed as main changes it (`notes:changed`).
 *
 * Main sends a change for every stored change, this editor's own saves included, and may send it
 * before or after the save's answer. A change carrying a revision this editor saved is that save
 * coming back: it moves the sync state, never the editor's content, which may already hold newer
 * typing. Any other doc (a conflict's server doc, "Use mine", a run's AI notes) is one the editor
 * must load, and bumps `docGeneration`. Changes that arrive while a save is on its way wait for
 * its answer, which names its revision.
 */

export interface NoteDocumentState {
  /** `loading` until main answers; `failed` when it could not read the note. */
  status: 'loading' | 'ready' | 'failed';
  /** The note as main last described it; null while none of this kind is stored. */
  note: LocalNote | null;
  /** Why the note could not be read, for the page. */
  error: string | null;
  /**
   * Bumped whenever the editor must show `note.doc`: the first load, then every doc that is not
   * the editor's own save coming back and not the doc it already shows.
   */
  docGeneration: number;
}

export type NoteDocumentApi = Pick<
  NotesApi,
  'getNotes' | 'saveNote' | 'onNoteChanged' | 'resolveNoteConflict'
>;

export class NoteDocument {
  private state: NoteDocumentState = {
    status: 'loading',
    note: null,
    error: null,
    docGeneration: 0,
  };
  private readonly listeners = new Set<() => void>();
  /** Revisions this editor saved: their changes are its own saves coming back. */
  private readonly ownRevisions = new Set<string>();
  private savesInFlight = 0;
  private held: LocalNote[] = [];
  /** The doc the editor shows as main knows it (JSON): last loaded into it or saved from it. */
  private shownDoc: string | null = null;
  /** Bumped by every start and stop, so an answer to an earlier start is dropped. */
  private run = 0;
  /** A change arrived since the load began: it is newer than what the load will answer. */
  private changedSinceLoad = false;
  private stopListening: Unsubscribe | null = null;

  constructor(
    private readonly api: NoteDocumentApi,
    readonly meetingId: string,
    readonly kind: NoteKind,
  ) {}

  readonly getState = (): NoteDocumentState => this.state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Follows main's changes and loads the note; returns the function that stops both. */
  start(): Unsubscribe {
    this.stopListening?.();
    this.run += 1;
    const run = this.run;
    this.stopListening = this.api.onNoteChanged((note) => {
      if (run === this.run) this.changed(note);
    });
    this.load(run);
    return () => {
      if (run !== this.run) return;
      this.run += 1;
      this.stopListening?.();
      this.stopListening = null;
    };
  }

  /** Try again after a failed read. */
  reload(): void {
    this.set({ ...this.state, status: 'loading', error: null });
    this.load(this.run);
  }

  /** The saver's write: resolves once the doc is in notes.sqlite, rejects with main's reason. */
  async save(doc: NoteDoc): Promise<void> {
    this.savesInFlight += 1;
    this.shownDoc = JSON.stringify(doc);
    try {
      const saved = await this.api.saveNote({ meetingId: this.meetingId, kind: this.kind, doc });
      if (saved.revisionId !== null) this.ownRevisions.add(saved.revisionId);
    } finally {
      this.savesInFlight -= 1;
      if (this.savesInFlight === 0) {
        const held = this.held;
        this.held = [];
        for (const note of held) this.apply(note);
      }
    }
  }

  /** "Use mine" or "Keep this version"; the doc main keeps then arrives as a change. */
  async resolveConflict(keep: ResolveNoteConflictRequest['keep']): Promise<void> {
    await this.api.resolveNoteConflict({ meetingId: this.meetingId, kind: this.kind, keep });
  }

  private load(run: number): void {
    this.changedSinceLoad = false;
    this.api.getNotes(this.meetingId).then(
      (notes) => {
        if (run !== this.run) return;
        if (this.changedSinceLoad) {
          this.set({ ...this.state, status: 'ready', error: null });
          return;
        }
        const note = notes[this.kind];
        this.shownDoc = note === null ? null : JSON.stringify(note.doc);
        this.set({
          status: 'ready',
          note,
          error: null,
          docGeneration: this.state.docGeneration + 1,
        });
      },
      (error: unknown) => {
        if (run !== this.run) return;
        // A change that came meanwhile is the note; only with none is the read a failure.
        if (this.changedSinceLoad) this.set({ ...this.state, status: 'ready', error: null });
        else this.set({ ...this.state, status: 'failed', error: describeError(error) });
      },
    );
  }

  private changed(note: LocalNote): void {
    if (note.meetingId !== this.meetingId || note.kind !== this.kind) return;
    if (this.savesInFlight > 0) this.held.push(note);
    else this.apply(note);
  }

  private apply(note: LocalNote): void {
    this.changedSinceLoad = true;
    const own = note.revisionId !== null && this.ownRevisions.has(note.revisionId);
    const doc = JSON.stringify(note.doc);
    const status = this.state.status === 'failed' ? 'ready' : this.state.status;
    if (own || doc === this.shownDoc) {
      this.set({ ...this.state, status, error: null, note });
      return;
    }
    this.shownDoc = doc;
    this.set({ status, note, error: null, docGeneration: this.state.docGeneration + 1 });
  }

  private set(next: NoteDocumentState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

export interface NoteDocumentHandle {
  document: NoteDocument;
  state: NoteDocumentState;
}

/** One note of the meeting, over `window.roger`, for as long as the calling editor is mounted. */
export function useNoteDocument(meetingId: string, kind: NoteKind): NoteDocumentHandle {
  const document = useMemo(
    () => new NoteDocument(window.roger, meetingId, kind),
    [meetingId, kind],
  );
  const state = useSyncExternalStore(document.subscribe, document.getState);
  useEffect(() => document.start(), [document]);
  return { document, state };
}
