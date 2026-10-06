import { chatChannels, type SendChatMessageRequest } from '../../shared/ipc/chat';
import { notesChannels } from '../../shared/ipc/notes';
import type { ChatMessage, ChatThread, LocalNote, MeetingNotes } from '../../shared/notes';
import { ApiError } from '../api/http';
import type { NotesClient } from '../api/notesClient';
import { handleTrusted, onTrusted, type IpcMainLike, type IpcTrust } from '../ipc/trust';
import { errorMessage, type LogFields, type Logger } from '../logger';
import type { LlmStreams, StreamEnd, StreamWindow } from './LlmStreams';
import type { NotesGenerator } from './NotesGenerator';
import type { NotesStore } from './NotesStore';
import type { NotesSync } from './NotesSync';
import type { NotesQuitGuard, Stoppable } from './notesQuitGuard';
import {
  parseChatAnswerRequest,
  parseGenerateNotesRequest,
  parseMeetingIdPayload,
  parseNotesFlushAck,
  parseNotesRunRequest,
  parseResolveNoteConflictRequest,
  parseSaveNoteRequest,
  parseSendChatMessageRequest,
  type Parsed,
} from './notes-ipc-validation';

/**
 * After a lost chat stream, the run is read every 2 s for 10 s, then every 5 s (M4 "Streaming"),
 * the cadence of NotesGenerator's poll after a lost notes stream (RUN_POLL_* there): keep the two
 * in step.
 */
const CHAT_RUN_POLL_FAST_MS = 2_000;
const CHAT_RUN_POLL_FAST_FOR_MS = 10_000;
const CHAT_RUN_POLL_SLOW_MS = 5_000;
/**
 * How long a lost answer's run may read `running` before the poll stops and the thread is read as
 * it stands. The API fails a run whose heartbeat is 2 minutes old, but the run it answers carries
 * no heartbeat, so the poll cannot tell a long answer from a dead one (NotesGenerator's
 * RUN_POLL_LIMIT_MS says the same).
 */
export const CHAT_RUN_POLL_LIMIT_MS = 120_000;

/** The main window as this needs it; a BrowserWindow is one (its webContents is one object). */
export interface NotesWindow {
  isDestroyed(): boolean;
  readonly webContents: StreamWindow;
}

export interface NotesIpcDeps {
  ipcMain: IpcMainLike;
  /** The main window, whose page alone may use these channels; null while it is closed. */
  getWindow: () => NotesWindow | null;
  store: Pick<NotesStore, 'getNotes' | 'onNoteChanged'>;
  sync: Pick<NotesSync, 'save' | 'resolveConflict' | 'pullMeeting'>;
  generator: Pick<NotesGenerator, 'generate' | 'cancel' | 'getPending' | 'onPendingChanged'>;
  streams: Pick<LlmStreams, 'streamChat' | 'cancelChat'>;
  api: Pick<NotesClient, 'listTemplates' | 'getRun' | 'getChatThread'>;
  /** Takes the page's answer to main's flush request (`notes:flush-ack`). */
  flush: Pick<NotesQuitGuard, 'ack'>;
  logger: Logger;
}

/**
 * Wires the notes and chat channels (src/shared/ipc/notes.ts and chat.ts) for the main window's
 * page only (ipc/trust.ts): the prompt panel shows calendar cards and has no business with notes.
 * Every payload is parsed first (notes-ipc-validation.ts). Saves go through NotesSync into
 * notes.sqlite, generates through NotesGenerator, chat answers through LlmStreams; every stored
 * note change (the page's own saves included), every pending-generate change and every thread
 * reloaded after a lost answer is sent to the page.
 *
 * A chat answer whose stream was lost (no `done` or `error`, or a cancel the API did not confirm)
 * goes on in the API, which stores it: its run is polled until it ends, then the thread is read
 * again and sent as `chat:thread-changed`. Notes runs are NotesGenerator's to follow.
 *
 * Log lines carry channels, ids, codes and rules, never a payload: notes and questions are what
 * the user typed. Returns what the quit stops before notes.sqlite closes (the polls, the events).
 */
export function registerNotesIpc(deps: NotesIpcDeps): Stoppable {
  return new NotesIpc(deps).register();
}

class NotesIpc {
  private readonly trust: IpcTrust;
  /**
   * Questions whose answer is streaming: one stream per message id. A lost answer's poll does not
   * count, so a retry then streams again, and the API attaches it to the answer it is writing.
   */
  private readonly answering = new Set<string>();
  /** Questions the page cancelled while their answer streamed (see answerEnded). */
  private readonly cancelled = new Set<string>();
  /** Meetings whose server notes are being pulled: two editors opening ask once. */
  private readonly pulling = new Set<string>();
  /** The polls' waits; stop() ends them. */
  private readonly sleeps = new Set<() => void>();
  private readonly unsubscribes: (() => void)[] = [];
  private stopped = false;

  constructor(private readonly deps: NotesIpcDeps) {
    this.trust = { ipcMain: deps.ipcMain, getWindow: deps.getWindow, logger: deps.logger };
  }

  register(): Stoppable {
    const { store, sync, generator, streams, api } = this.deps;

    this.handle(notesChannels.NotesGet, parseMeetingIdPayload, (meetingId): MeetingNotes => {
      const notes = store.getNotes(meetingId);
      this.pullServerNotes(meetingId);
      return notes;
    });
    this.handle(notesChannels.NotesSave, parseSaveNoteRequest, ({ meetingId, kind, doc, base }) =>
      sync.save(meetingId, kind, doc, base),
    );
    this.handle(notesChannels.NotesResolveConflict, parseResolveNoteConflictRequest, (request) =>
      sync.resolveConflict(request.meetingId, request.kind, request.keep),
    );
    this.handle(notesChannels.NotesListTemplates, noPayload, () => api.listTemplates());
    this.handle(notesChannels.NotesGenerate, parseGenerateNotesRequest, (request) =>
      generator.generate(request.meetingId, request.templateId),
    );
    // Settles once the API has the cancel (up to the stream's header wait): the page is told
    // `cancelled` at once by the stream and must never block on this answer.
    this.handle(notesChannels.NotesCancelGenerate, parseMeetingIdPayload, (meetingId) =>
      generator.cancel(meetingId),
    );
    this.handle(notesChannels.NotesGetPendingGenerate, parseMeetingIdPayload, (meetingId) =>
      generator.getPending(meetingId),
    );
    this.handle(notesChannels.NotesGetRun, parseNotesRunRequest, (request) =>
      api.getRun(request.meetingId, request.runId),
    );
    onTrusted(this.trust, notesChannels.NotesFlushAck, (payload) => {
      const ack = parseNotesFlushAck(payload);
      if (ack.ok) this.deps.flush.ack(ack.value);
      else this.refused(notesChannels.NotesFlushAck, ack.problem);
    });

    this.handle(chatChannels.ChatGetThread, parseMeetingIdPayload, (meetingId) =>
      api.getChatThread(meetingId),
    );
    this.handle(chatChannels.ChatSend, parseSendChatMessageRequest, (request) => {
      this.answer(request);
    });
    // As notes:cancel-generate: settles once the API holds the run; never block the page on it.
    this.handle(chatChannels.ChatCancel, parseChatAnswerRequest, async (request) => {
      if (this.answering.has(request.messageId)) this.cancelled.add(request.messageId);
      await streams.cancelChat(request);
    });

    this.unsubscribes.push(
      store.onNoteChanged((note: LocalNote) => {
        this.toPage(notesChannels.NotesChanged, note);
      }),
      generator.onPendingChanged((change) => {
        this.toPage(notesChannels.NotesPendingGenerateChanged, change);
      }),
    );
    return {
      stop: () => {
        this.stop();
      },
    };
  }

  private stop(): void {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    for (const wake of [...this.sleeps]) wake();
  }

  /**
   * Whether stop() ran (quit: notes.sqlite closes next). A method, not the field: stop() runs
   * while a read is out, and a field checked twice around an await reads as narrowed to typed
   * lint, which then calls the second check unnecessary.
   */
  private isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Registers an invoke for the trusted page: the payload is parsed first, and a refusal or a
   * failure is logged (channel and ids, never the payload) and rejects the page's invoke.
   */
  private handle<T, R>(
    channel: string,
    parse: (payload: unknown) => Parsed<T>,
    run: (request: T) => R | Promise<R>,
  ): void {
    handleTrusted(this.trust, channel, async (payload) => {
      const parsed = parse(payload);
      if (!parsed.ok) {
        this.refused(channel, parsed.problem);
        throw new Error(`${channel} refused: ${parsed.problem}`);
      }
      try {
        return await run(parsed.value);
      } catch (error) {
        // The page gets the message too (the invoke rejects with it) and shows it.
        this.deps.logger.warn('notes request failed', {
          channel,
          ...idsOf(parsed.value),
          error: errorMessage(error),
        });
        throw error;
      }
    });
  }

  private refused(channel: string, problem: string): void {
    this.deps.logger.warn('notes request refused', { channel, problem });
  }

  /** Sends a main → page event to the main window, if it is open. */
  private toPage(channel: string, payload: unknown): void {
    const window = this.deps.getWindow();
    if (window === null || window.isDestroyed()) return;
    window.webContents.send(channel, payload);
  }

  /**
   * Takes the server's notes of the meeting into notes.sqlite after `notes:get` answered from it;
   * what changes reaches the page as `notes:changed`. With the API away the page keeps the Mac's
   * copy, which is the point of it: logged, never a failure.
   */
  private pullServerNotes(meetingId: string): void {
    if (this.pulling.has(meetingId)) return;
    this.pulling.add(meetingId);
    this.deps.sync.pullMeeting(meetingId).then(
      () => {
        this.pulling.delete(meetingId);
      },
      (error: unknown) => {
        this.pulling.delete(meetingId);
        // Quit stopped the sync while the GET was out: nothing failed, and the store may be closed.
        if (this.isStopped()) return;
        const fields: LogFields = { meetingId, error: errorMessage(error) };
        if (error instanceof ApiError) {
          this.deps.logger.info('server notes not loaded', { ...fields, code: error.code });
        } else this.deps.logger.error('server notes not loaded', fields);
      },
    );
  }

  /**
   * Streams the answer to `request` to the page that asked. Resolves at once: the answer, and any
   * refusal before it, arrives as `chat:event` messages for this message id.
   */
  private answer(request: SendChatMessageRequest): void {
    const { messageId } = request;
    if (this.answering.has(messageId)) {
      throw new Error(`the answer to message ${messageId} is already on its way`);
    }
    this.answering.add(messageId);
    const window = this.deps.getWindow();
    const target = window === null || window.isDestroyed() ? null : window.webContents;
    this.deps.streams
      .streamChat(request, target)
      .finally(() => {
        this.answering.delete(messageId);
      })
      .then((end) => this.answerEnded(request, end))
      .catch((error: unknown) => {
        // LlmStreams hands every API failure over as an end; this is a bug or a page gone wrong.
        this.deps.logger.error('chat answer failed', {
          meetingId: request.meetingId,
          messageId,
          error: errorMessage(error),
        });
      });
  }

  /**
   * After a chat stream ended. `done` and `error` reached the page as events. A lost stream's
   * answer goes on in the API and is stored there: its run is polled to its end, then the thread
   * is read again.
   *
   * Trap: after a cancel, a stream that ends `done`, or `dropped` with `cancel_unconfirmed`, is
   * not a cancel. The answer beat it (or the cancel failed) and is stored, while the page was
   * told `cancelled` at once and, LlmStreams no longer forwarding, never got that `done`. Both
   * read the thread again; ended as cancelled, the page would keep a stored answer out of its
   * thread.
   */
  private async answerEnded(
    request: SendChatMessageRequest,
    end: StreamEnd<ChatMessage>,
  ): Promise<void> {
    const cancelled = this.cancelled.delete(request.messageId);
    if (end.kind === 'error' || (end.kind === 'done' && !cancelled)) return;
    const { meetingId } = request;
    if (end.kind === 'dropped' && end.runId !== null) await this.pollRun(meetingId, end.runId);
    if (this.isStopped()) return;
    let thread: ChatThread;
    try {
      thread = await this.deps.api.getChatThread(meetingId);
    } catch (error) {
      // The page keeps what it streamed, and reads the thread again when it opens the meeting.
      this.deps.logger.warn('chat thread not reloaded after a lost answer', {
        meetingId,
        messageId: request.messageId,
        error: errorMessage(error),
      });
      return;
    }
    if (this.isStopped()) return;
    this.toPage(chatChannels.ChatThreadChanged, thread);
  }

  /** Reads the run until it is no longer `running`, the API forgets it, or the limit passes. */
  private async pollRun(meetingId: string, runId: string): Promise<void> {
    const started = Date.now();
    const log = this.deps.logger.child({ meetingId, runId });
    for (;;) {
      if (await this.runEnded(meetingId, runId, log)) return;
      const elapsed = Date.now() - started;
      if (elapsed >= CHAT_RUN_POLL_LIMIT_MS) {
        log.warn('chat run still running when its poll stopped', { elapsedMs: elapsed });
        return;
      }
      const wait =
        elapsed < CHAT_RUN_POLL_FAST_FOR_MS ? CHAT_RUN_POLL_FAST_MS : CHAT_RUN_POLL_SLOW_MS;
      if (!(await this.sleep(wait))) return;
    }
  }

  /** One read of the run: true once there is nothing more to wait for. */
  private async runEnded(meetingId: string, runId: string, log: Logger): Promise<boolean> {
    if (this.isStopped()) return true;
    try {
      const run = await this.deps.api.getRun(meetingId, runId);
      return run.status !== 'running';
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      // The API does not hold the run (another workspace's id, a reset database): the thread
      // says what there is.
      if (error.isNotFound) return true;
      // Away or failing: read again at the next turn, up to the limit.
      log.info('chat run not read', { code: error.code, status: error.status });
      return false;
    }
  }

  /** Waits `ms`; false when stop() ended the wait. */
  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.sleeps.delete(wake);
        resolve(false);
      };
      const timer = setTimeout(() => {
        this.sleeps.delete(wake);
        resolve(!this.stopped);
      }, ms);
      this.sleeps.add(wake);
    });
  }
}

/** A request that takes no payload: whatever the page sent is ignored. */
function noPayload(): Parsed<undefined> {
  return { ok: true, value: undefined };
}

/** The ids a request names, for a log line: never its text or doc. */
function idsOf(request: unknown): LogFields {
  if (typeof request === 'string') return { meetingId: request };
  if (typeof request !== 'object' || request === null) return {};
  const fields: LogFields = {};
  for (const key of ['meetingId', 'kind', 'runId', 'messageId', 'templateId'] as const) {
    if (key in request) fields[key] = (request as Record<string, unknown>)[key];
  }
  return fields;
}
