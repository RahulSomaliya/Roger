import { randomUUID } from 'node:crypto';
import { notesChannels, type NotesFlush } from '../../shared/ipc/notes';
import type { QuitHook } from '../lifecycle';
import { errorMessage, type Logger } from '../logger';

/**
 * How long main waits for each window's answer to a flush request (M4 "Saving at quit"). A page
 * answers once its open editors' saves have landed (renderer/src/notes/debouncedSaver.ts,
 * NotesFlushResponder); one with no editor open answers at once.
 */
export const NOTES_FLUSH_TIMEOUT_MS = 1_000;

/**
 * The quit hook's own bound: the windows' waits run side by side, so the flush takes at most
 * NOTES_FLUSH_TIMEOUT_MS, and the closes after it are synchronous. Shorter, the lifecycle would
 * move on before notes.sqlite closed.
 */
const NOTES_QUIT_HOOK_TIMEOUT_MS = 2 * NOTES_FLUSH_TIMEOUT_MS;

/** The parts of a window this needs; a BrowserWindow is one. */
export interface FlushWindow {
  readonly webContents: {
    readonly id: number;
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

/** Something the quit stops before notes.sqlite closes: the generator, the sync, chat polls. */
export interface Stoppable {
  stop(): void;
}

export interface NotesQuitGuardOptions {
  store: { close(): void };
  /** The windows whose pages may hold notes editors: the main window, while it is open. */
  windows: () => readonly FlushWindow[];
  logger: Logger;
  flushTimeoutMs?: number;
  /** Each flush request's id; a UUIDv4 by default (the ack's validator expects one). */
  newRequestId?: () => string;
}

/**
 * Saves the notes still in the windows' editors before main acts on what notes.sqlite holds:
 * at quit, then closes notes.sqlite, and at Stop, before the delete sites ask whether a silent
 * meeting has notes (TranscriptUploader's `saveOpenNotes`, CaptureService.keepsForNotes). The
 * editor saves 400 ms after the last keystroke, and React does not unmount on Cmd-Q, so without
 * this the last typing is lost while the page says "Saved on this Mac", or a meeting whose only
 * content is that typing is discarded as empty.
 *
 * Trap: the quit runs this as one hook in RecordingLifecycle's list (`[slot M4-T16 quit]` in
 * index.ts), after the recording stopped and before the uploader stops and roger.sqlite closes.
 * Never as a `before-quit` listener of its own: Electron runs that on the first Cmd+Q, while the
 * lifecycle is still stopping the recording (lifecycle.ts, `quitHooks`).
 */
export class NotesQuitGuard {
  private readonly flushTimeoutMs: number;
  private readonly newRequestId: () => string;
  /** The answer each outstanding request waits for, by request id. */
  private readonly waiting = new Map<string, () => void>();
  private readonly stopFirst: Stoppable[] = [];

  /** The hook `[slot M4-T16 quit]` puts in the lifecycle's list. */
  readonly quitHook: QuitHook = {
    name: 'save the notes open in an editor, then close notes.sqlite',
    timeoutMs: NOTES_QUIT_HOOK_TIMEOUT_MS,
    run: () => this.quit(),
  };

  constructor(private readonly options: NotesQuitGuardOptions) {
    this.flushTimeoutMs = options.flushTimeoutMs ?? NOTES_FLUSH_TIMEOUT_MS;
    this.newRequestId = options.newRequestId ?? randomUUID;
  }

  /**
   * Sends `notes:flush-request` to every open window and resolves once each answered, or its
   * wait ran out (logged). Never rejects: a page that cannot answer must not hold up a quit or a
   * Stop, and its editors keep what they could not save.
   */
  async flushOpenNotes(): Promise<void> {
    const windows = this.options.windows().filter((window) => !window.webContents.isDestroyed());
    await Promise.all(windows.map((window) => this.flushWindow(window)));
  }

  /** A page's answer (`notes:flush-ack`), passed on by notes-ipc.ts from the trusted page only. */
  ack(flush: NotesFlush): void {
    const answered = this.waiting.get(flush.requestId);
    if (answered === undefined) {
      // An answer after its wait ran out, or to no request of ours.
      this.options.logger.debug('notes flush answer for no waiting request');
      return;
    }
    answered();
  }

  /** Stopped in this order once the quit's flush is over, before notes.sqlite closes. */
  stopBeforeClose(...services: Stoppable[]): void {
    this.stopFirst.push(...services);
  }

  private async quit(): Promise<void> {
    await this.flushOpenNotes();
    // Each stop on its own: one that throws must not keep notes.sqlite open, or the services
    // after it running, through the rest of the quit.
    for (const service of this.stopFirst) {
      try {
        service.stop();
      } catch (error) {
        this.options.logger.error('notes service did not stop at quit', {
          error: errorMessage(error),
        });
      }
    }
    this.options.store.close();
  }

  private flushWindow(window: FlushWindow): Promise<void> {
    const { logger } = this.options;
    const windowId = window.webContents.id;
    const requestId = this.newRequestId();
    return new Promise<void>((resolve) => {
      const settle = (): void => {
        clearTimeout(timer);
        this.waiting.delete(requestId);
        resolve();
      };
      const timer = setTimeout(() => {
        logger.warn('notes flush not answered in time', {
          windowId,
          timeoutMs: this.flushTimeoutMs,
        });
        settle();
      }, this.flushTimeoutMs);
      this.waiting.set(requestId, settle);
      try {
        const request: NotesFlush = { requestId };
        window.webContents.send(notesChannels.NotesFlushRequest, request);
      } catch (error) {
        // Destroyed between the check and the send: there is no page left to wait for.
        logger.warn('notes flush request not sent', { windowId, error: errorMessage(error) });
        settle();
      }
    });
  }
}
