import type { NotesApi, NotesFlush } from '../../../shared/ipc/notes';
import type { Unsubscribe } from '../../../shared/ipc/unsubscribe';
import type { NoteDoc } from '../../../shared/notes';
import { describeError } from '../app/describeError';

/**
 * When an open note is written to the Mac (M4 plan, "Notes on the Mac"): 400 ms after the last
 * edit, and at once on blur, on unmount, on `pagehide` and `beforeunload`, and when main asks
 * before it quits (`notes:flush-request`). React does not unmount on Cmd-Q, so a save left to
 * unmount loses the last keystrokes while the page says "Saved on this Mac"; main's quit hook
 * (M4-T16, notesQuitGuard.ts) waits for this page's ack, or 1 s, before it closes notes.sqlite.
 */

/** How long typing must pause before the note is written. */
export const SAVE_DEBOUNCE_MS = 400;

/**
 * Where the open note stands on this Mac, before main and NotesSync take over (saveStatus.ts):
 * - `saved`: nothing unsaved (or nothing typed yet).
 * - `pending`: edited; the save waits for a pause in typing.
 * - `saving`: a save is on its way to main.
 * - `failed`: main refused the newest save. The edits are still in the editor, still unsaved,
 *   and the next edit or flush sends them again.
 */
export type SaverState =
  | { phase: 'saved' }
  | { phase: 'pending' }
  | { phase: 'saving' }
  | { phase: 'failed'; message: string };

/** The page events that end a page without an unmount: a reload, a closing window. */
const PAGE_END_EVENTS = ['pagehide', 'beforeunload'] as const;

export interface DebouncedSaverOptions {
  /** The doc to save, read when the save starts: the editor's content. */
  read: () => NoteDoc;
  /** Saves it; resolves once main has written notes.sqlite (`saveNote`). */
  write: (doc: NoteDoc) => Promise<void>;
  /** The window, whose `pagehide` and `beforeunload` save at once. Left out, nothing listens. */
  page?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** The page's answer to main's flush request; left out, main's quit does not wait for this. */
  responder?: NotesFlushResponder;
  onState?: (state: SaverState) => void;
}

/**
 * Saves one open note. Saves never wait for each other: IPC keeps their order, so main writes the
 * newest last, and a save started by `pagehide` must leave before the page goes, not after the
 * one before it answers. Each save covers the edits made before it started; an older save that
 * lands or fails after a newer one changes nothing the newer one settled.
 */
export class DebouncedSaver {
  private readonly options: DebouncedSaverOptions;
  /** Edits so far, the edits the newest started save covers, and the newest landed save. */
  private edits = 0;
  private sentThrough = 0;
  private savedThrough = 0;
  private failure: { through: number; message: string } | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reported: SaverState = { phase: 'saved' };
  private disposed = false;
  private readonly stopListening: Unsubscribe;
  private readonly unregister: () => void;

  constructor(options: DebouncedSaverOptions) {
    this.options = options;
    const { page, responder } = options;
    const onPageEnd = (): void => {
      void this.flush();
    };
    for (const event of PAGE_END_EVENTS) page?.addEventListener(event, onPageEnd);
    this.stopListening = () => {
      for (const event of PAGE_END_EVENTS) page?.removeEventListener(event, onPageEnd);
    };
    this.unregister = responder?.register(this) ?? (() => undefined);
  }

  /** True while some edit has not landed in main. */
  get unsaved(): boolean {
    return this.edits > this.savedThrough;
  }

  /** The editor's content changed. */
  edited(): void {
    if (this.disposed) return;
    this.edits += 1;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
    this.report();
  }

  /** The editor lost focus: save now. */
  blurred(): void {
    void this.flush();
  }

  /**
   * Saves the edits no save has taken yet, at once, then resolves when every save so far has
   * landed or failed. Never rejects: a failure shows as the `failed` state.
   */
  flush(): Promise<void> {
    this.clearTimer();
    if (this.edits > this.sentThrough) this.send();
    return Promise.allSettled([...this.inFlight]).then(() => undefined);
  }

  /**
   * The editor unmounts: saves what is left, stops listening, and leaves main's flush once that
   * save has landed, so a quit right after closing a meeting still waits for it.
   */
  dispose(): Promise<void> {
    if (this.disposed) return this.flush();
    const flushed = this.flush();
    this.disposed = true;
    this.stopListening();
    return flushed.finally(this.unregister);
  }

  private send(): void {
    const through = this.edits;
    this.sentThrough = through;
    // Started before any await, so a save from `pagehide` leaves while the page still exists.
    const saving = this.options.write(this.options.read()).then(
      () => {
        this.savedThrough = Math.max(this.savedThrough, through);
      },
      (error: unknown) => {
        if (through <= this.savedThrough) return;
        this.failure = { through, message: describeError(error) };
        // Main has not got these edits: the next flush sends them again, unless a newer save
        // that holds them is already on its way.
        if (this.sentThrough === through) this.sentThrough = this.savedThrough;
      },
    );
    const settled = saving.finally(() => {
      this.inFlight.delete(settled);
      this.report();
    });
    this.inFlight.add(settled);
    this.report();
  }

  private state(): SaverState {
    if (this.inFlight.size > 0) return { phase: 'saving' };
    if (this.failure !== null && this.failure.through > this.savedThrough && this.unsaved) {
      return { phase: 'failed', message: this.failure.message };
    }
    return this.unsaved ? { phase: 'pending' } : { phase: 'saved' };
  }

  private report(): void {
    if (this.disposed) return;
    const next = this.state();
    const same =
      next.phase === this.reported.phase &&
      (next.phase !== 'failed' ||
        (this.reported.phase === 'failed' && this.reported.message === next.message));
    if (same) return;
    this.reported = next;
    this.options.onState?.(next);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

/** What the responder asks of each open editor's saver. */
export interface FlushableNote {
  flush(): Promise<void>;
}

/**
 * The page's one answer to main's `notes:flush-request` (quit): flush every open note, then ack
 * once. One subscription for the page, never one per editor: main waits for one ack per window,
 * and a second editor acking first would let main close notes.sqlite under the other's save. It
 * subscribes when the first editor opens and stays, so a window whose editors have closed still
 * answers at once instead of costing the quit main's 1 s wait.
 */
export class NotesFlushResponder {
  private readonly notes = new Set<FlushableNote>();
  private subscription: Unsubscribe | null = null;

  constructor(private readonly api: Pick<NotesApi, 'onNotesFlushRequest' | 'ackNotesFlush'>) {}

  /** Adds an open note to every flush; returns the function that takes it out. */
  register(note: FlushableNote): () => void {
    this.subscription ??= this.api.onNotesFlushRequest((request) => {
      void this.answer(request);
    });
    this.notes.add(note);
    return () => {
      this.notes.delete(note);
    };
  }

  private async answer(request: NotesFlush): Promise<void> {
    // flush() never rejects, so a refused save still gets main its ack: the edits stay in the
    // editor with the refusal on show, and main must not hold the quit for a save that cannot land.
    await Promise.all([...this.notes].map((note) => note.flush()));
    this.api.ackNotesFlush({ requestId: request.requestId });
  }
}

let pageResponder: NotesFlushResponder | undefined;

/** The page's responder, over `window.roger`, made when the first editor opens. */
export function notesFlushResponder(): NotesFlushResponder {
  pageResponder ??= new NotesFlushResponder(window.roger);
  return pageResponder;
}
