import { randomUUID } from 'node:crypto';
import { notesChannels, type NotesFlush } from '../../shared/ipc/notes';
import type { CaptureService, RecordingEnded } from '../capture/CaptureService';
import type { QuitHook } from '../lifecycle';
import { errorMessage, type Logger } from '../logger';
import type { TranscriptStore } from '../store/TranscriptStore';
import type { NotesGenerator } from './NotesGenerator';
import type { NotesStore } from './NotesStore';

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
   * Stop's save (TranscriptUploader's `saveOpenNotes`): sends `notes:flush-request` to every open
   * window, resolves once each answered, and rejects naming the windows whose wait ran out. Its
   * caller keeps a meeting nobody spoke in when this rejects (CaptureService.keepsForNotes), and
   * the uploader may discard it a tick later: KeptSilentMeetings below drops its generate then.
   *
   * Trap: never resolve on a wait that ran out, as the quit does. keepsForNotes bounds this with
   * its own timer of the same 1 s, set after this one's, so this one always fires first: a wait
   * that resolved would read as a save that landed, `hasNotes` would miss the typing still in a
   * busy page, and the meeting would be deleted under it, its notes then waiting for good.
   */
  async saveOpenNotes(): Promise<void> {
    const unanswered = await this.flushOpenNotes();
    if (unanswered.length > 0) {
      throw new Error(
        `the notes open in window ${unanswered.join(', ')} were not saved in ` +
          `${this.flushTimeoutMs} ms`,
      );
    }
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
    // Never fails on a window that did not answer (flushWindow logged it): a page that cannot
    // answer must not hold up the quit, and notes.sqlite closes after the 1 s either way.
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

  /**
   * Sends `notes:flush-request` to every open window and waits for each answer, or its wait
   * (logged). Resolves with the ids of the windows that did not answer in time.
   */
  private async flushOpenNotes(): Promise<number[]> {
    const windows = this.options.windows().filter((window) => !window.webContents.isDestroyed());
    const answered = await Promise.all(windows.map((window) => this.flushWindow(window)));
    return windows.filter((_, index) => !answered[index]).map((window) => window.webContents.id);
  }

  /** Resolves true once the window's page answered, false once its wait ran out. */
  private flushWindow(window: FlushWindow): Promise<boolean> {
    const { logger } = this.options;
    const windowId = window.webContents.id;
    const requestId = this.newRequestId();
    return new Promise<boolean>((resolve) => {
      const settle = (answered: boolean): void => {
        clearTimeout(timer);
        this.waiting.delete(requestId);
        resolve(answered);
      };
      const timer = setTimeout(() => {
        logger.warn('notes flush not answered in time', {
          windowId,
          timeoutMs: this.flushTimeoutMs,
        });
        settle(false);
      }, this.flushTimeoutMs);
      this.waiting.set(requestId, () => {
        settle(true);
      });
      try {
        const request: NotesFlush = { requestId };
        window.webContents.send(notesChannels.NotesFlushRequest, request);
      } catch (error) {
        // Destroyed between the check and the send: there is no page left to wait for, and no
        // editor left whose typing could be missed.
        logger.warn('notes flush request not sent', { windowId, error: errorMessage(error) });
        settle(true);
      }
    });
  }
}

export interface KeptSilentMeetingsOptions {
  /** Stop's outcome for each recording (CaptureService.onRecording). */
  recordings: Pick<CaptureService, 'onRecording'>;
  /** The uploader's status events: one ends every tick, the one that discards a meeting too. */
  uploads: { onStatus(listener: () => void): () => void };
  /** roger.sqlite: whether it still holds the meeting, as what. */
  transcripts: Pick<TranscriptStore, 'getMeeting' | 'countSegments'>;
  /** notes.sqlite's pending generates, read once at start. */
  pendingGenerates: Pick<NotesStore, 'listPendingGenerates'>;
  generator: Pick<NotesGenerator, 'getPending' | 'cancel'>;
  logger: Logger;
}

/**
 * Drops the pending generate of a meeting nobody spoke in that Stop kept and the uploader then
 * discarded as empty (the M4-T23 hand-off: a row written at Stop for a meeting later discarded is
 * never cleaned up otherwise).
 *
 * Stop keeps such a meeting, and tells its listeners `discarded: false`, when its save failed
 * (NotesQuitGuard.saveOpenNotes: every page until M4-T20 mounts the flush responder, and a busy
 * one after), when the notes check failed, or when it found notes (CaptureService.keepsForNotes).
 * NotesGenerator then writes its generate. The uploader's pending rule decides the meeting again,
 * on Stop's own upload or a later tick, and deletes it when it still holds no line and no notes,
 * telling nobody (TranscriptUploader.syncMeeting). A generate asking for its template would then
 * wait for good, its meeting page gone, read again at every re-check and launch; one with a
 * template would send a run the API can only answer `404`.
 *
 * So each such meeting is followed until the uploader decides it: from Stop, or from launch for
 * one an earlier launch kept with a generate (a quit's Stop uploads nothing, so the next launch's
 * first tick decides it). Created in Postgres, or given a line, it is let go; gone from
 * roger.sqlite, its generate is cancelled (NotesGenerator.cancel drops one whose run was never
 * sent). Only an empty meeting is ever deleted, so a followed one that is gone was discarded.
 *
 * Trap: start this before NotesGenerator.start() and in the turn that started the uploader
 * (`[slot M4-T16 notes]`). Its status listener must run before the generator's, which would
 * otherwise send a templated run for the gone meeting first; and a first tick before the scan at
 * start would delete a meeting an earlier launch kept before it is followed.
 */
export class KeptSilentMeetings implements Stoppable {
  /** The meetings the pending rule may still discard. */
  private readonly following = new Set<string>();
  private readonly unsubscribes: (() => void)[] = [];

  constructor(private readonly options: KeptSilentMeetingsOptions) {}

  start(): void {
    const { recordings, uploads, pendingGenerates, logger } = this.options;
    this.unsubscribes.push(
      recordings.onRecording({
        ended: (recording) => {
          this.recordingEnded(recording);
        },
      }),
      uploads.onStatus(() => {
        this.uploaded();
      }),
    );
    try {
      for (const row of pendingGenerates.listPendingGenerates()) this.follow(row.meetingId);
    } catch (error) {
      logger.error('kept meetings not read at launch', { error: errorMessage(error) });
    }
  }

  /** At quit, before notes.sqlite closes. */
  stop(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.following.clear();
  }

  private recordingEnded(recording: RecordingEnded): void {
    // Discarded at Stop: NotesGenerator drops the generate itself. After a failed Stop the meeting
    // may still be open, and only CrashRecovery decides it.
    if (recording.discarded || recording.stopFailed) return;
    try {
      this.follow(recording.meetingId);
    } catch (error) {
      this.options.logger.error('kept meeting not followed', {
        meetingId: recording.meetingId,
        error: errorMessage(error),
      });
    }
  }

  private follow(meetingId: string): void {
    if (this.mayBeDiscarded(meetingId)) this.following.add(meetingId);
  }

  /** Not yet in Postgres and no line: the pending rule deletes it if no notes come. */
  private mayBeDiscarded(meetingId: string): boolean {
    const { transcripts } = this.options;
    const meeting = transcripts.getMeeting(meetingId);
    return (
      meeting !== null &&
      meeting.remoteState === 'pending' &&
      transcripts.countSegments(meetingId) === 0
    );
  }

  private uploaded(): void {
    const { transcripts, logger } = this.options;
    for (const meetingId of [...this.following]) {
      try {
        if (transcripts.getMeeting(meetingId) === null) {
          this.dropGenerate(meetingId);
          this.following.delete(meetingId);
        } else if (!this.mayBeDiscarded(meetingId)) {
          this.following.delete(meetingId);
        }
      } catch (error) {
        // Still followed: read again at the next status.
        logger.error('kept meeting not checked', { meetingId, error: errorMessage(error) });
      }
    }
  }

  private dropGenerate(meetingId: string): void {
    const { generator, logger } = this.options;
    if (generator.getPending(meetingId) === null) return;
    logger.info('pending generate dropped: its meeting was discarded as empty', { meetingId });
    generator.cancel(meetingId).catch((error: unknown) => {
      // A run an earlier launch may have sent, and the API could not be asked to stop: the
      // generator's 30 s re-check sends it again, the API answers 404 for the gone meeting, and
      // that ends it.
      logger.warn('pending generate of a discarded meeting not dropped', {
        meetingId,
        error: errorMessage(error),
      });
    });
  }
}
