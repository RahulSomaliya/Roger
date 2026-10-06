import {
  chatChannels,
  type ChatAnswerRequest,
  type ChatStreamMessage,
  type SendChatMessageRequest,
} from '../../shared/ipc/chat';
import { notesChannels } from '../../shared/ipc/notes';
import type {
  ChatMessage,
  ChatThread,
  LlmRunStatus,
  LocalNote,
  MeetingNotes,
} from '../../shared/notes';
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
export const CHAT_RUN_POLL_FAST_MS = 2_000;
const CHAT_RUN_POLL_FAST_FOR_MS = 10_000;
const CHAT_RUN_POLL_SLOW_MS = 5_000;
/**
 * How long a lost answer's run may read `running` before the poll stops and the thread is read as
 * it stands. The API fails a run whose heartbeat is 2 minutes old, but the run it answers carries
 * no heartbeat, so the poll cannot tell a long answer from a dead one (NotesGenerator's
 * RUN_POLL_LIMIT_MS says the same).
 */
export const CHAT_RUN_POLL_LIMIT_MS = 120_000;

/** What the page is told of a cancelled answer: the text LlmStreams sends for one it streams. */
const CHAT_CANCELLED_MESSAGE = 'The answer was cancelled.';

/** A lost answer main follows in the API (answerEnded), for a cancel made meanwhile. */
class FollowedAnswer {
  private found: (runId: string | null) => void = () => undefined;
  /** Settles with the run the follow polls once it knows it, or null once there is none. */
  readonly run = new Promise<string | null>((resolve) => {
    this.found = resolve;
  });
  /** The page's cancel during the follow, once sent: settles when the API answered it. */
  cancel: Promise<void> | null = null;
  /** Ends the poll's wait early, so it reads at once what the cancel did; null while none. */
  wake: (() => void) | null = null;

  constructor(readonly meetingId: string) {}

  /** Only the first call counts, as with any promise. */
  runFound(runId: string | null): void {
    this.found(runId);
  }
}

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
  /** `cancelRun` stops a lost answer's run, which no stream holds any more. */
  api: Pick<NotesClient, 'listTemplates' | 'getRun' | 'getChatThread' | 'cancelRun'>;
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
 * again and sent as `chat:thread-changed`. A cancel meanwhile stops that run, as one during the
 * stream would. Notes runs are NotesGenerator's to follow.
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
  /** Lost answers being followed in the API, by question (answerEnded). */
  private readonly following = new Map<string, FollowedAnswer>();
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
      if (this.answering.has(request.messageId)) {
        this.cancelled.add(request.messageId);
        await streams.cancelChat(request);
        return;
      }
      // Trap: a lost answer has no stream left to cancel (LlmStreams answers false), and its run
      // goes on in the API, paid, while the page still shows it coming. Its follow stops it.
      await this.cancelFollowed(request);
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
    const follow = new FollowedAnswer(request.meetingId);
    this.following.set(request.messageId, follow);
    try {
      await this.followAnswer(request, end, follow);
    } finally {
      // A cancel still waiting for the run learns there is none left to stop.
      follow.runFound(null);
      if (this.following.get(request.messageId) === follow) {
        this.following.delete(request.messageId);
      }
    }
  }

  /** Polls the lost answer's run to its end, then sends the thread, unless the page cancelled it. */
  private async followAnswer(
    request: SendChatMessageRequest,
    end: StreamEnd<ChatMessage>,
    follow: FollowedAnswer,
  ): Promise<void> {
    if (end.kind === 'dropped' && end.runId !== null) {
      if (await this.pollRun(follow, end.runId)) return;
    }
    let thread = await this.readThread(request);
    if (thread === null) return;
    // Trap: a stream lost before its `run` event names no run, but the API stored the answer
    // `streaming`, with its run, before it answered the request. Sent now, the thread shows the
    // answer half written and nothing reads it again once the run ends: follow the run the answer
    // names, as if the stream had named it, then read again.
    const writing =
      end.kind === 'dropped' && end.runId === null ? runWriting(thread, request) : null;
    if (writing !== null) {
      if (await this.pollRun(follow, writing)) return;
      thread = await this.readThread(request);
      if (thread === null) return;
    }
    this.toPage(chatChannels.ChatThreadChanged, thread);
  }

  /**
   * The meeting's thread as the API holds it, or null once the quit came or when it could not be
   * read (logged).
   */
  private async readThread(request: SendChatMessageRequest): Promise<ChatThread | null> {
    if (this.isStopped()) return null;
    let thread: ChatThread;
    try {
      thread = await this.deps.api.getChatThread(request.meetingId);
    } catch (error) {
      // The page keeps what it streamed, and reads the thread again when it opens the meeting.
      this.deps.logger.warn('chat thread not reloaded after a lost answer', {
        meetingId: request.meetingId,
        messageId: request.messageId,
        error: errorMessage(error),
      });
      return null;
    }
    return this.isStopped() ? null : thread;
  }

  /**
   * The page's cancel of a lost answer main follows: the page is told `cancelled` at once, as
   * LlmStreams tells it for a stream, and the run is asked to stop once the follow knows it.
   * Settles when the API answered, and rejects when that request failed (the follow goes on, and
   * a second cancel asks again). A question with no follow, or of another meeting, does nothing.
   */
  private cancelFollowed(request: ChatAnswerRequest): Promise<void> {
    const follow = this.following.get(request.messageId);
    if (follow?.meetingId !== request.meetingId) return Promise.resolve();
    if (follow.cancel === null) {
      const cancelled: ChatStreamMessage = {
        meetingId: request.meetingId,
        messageId: request.messageId,
        event: { type: 'error', code: 'cancelled', message: CHAT_CANCELLED_MESSAGE },
      };
      this.toPage(chatChannels.ChatEvent, cancelled);
      follow.cancel = this.stopFollowedRun(follow).catch((error: unknown) => {
        follow.cancel = null;
        throw error;
      });
    }
    return follow.cancel;
  }

  private async stopFollowedRun(follow: FollowedAnswer): Promise<void> {
    const runId = await follow.run;
    // No run to stop: the answer ended before, and the thread the follow sends holds it.
    if (runId === null) return;
    try {
      const run = await this.deps.api.cancelRun(follow.meetingId, runId);
      this.deps.logger.info('chat run cancel answered', {
        meetingId: follow.meetingId,
        runId,
        runStatus: run.status,
      });
    } finally {
      // The poll reads at once what the cancel did: stopped, or beaten by the answer.
      follow.wake?.();
    }
  }

  /**
   * Reads the run until it is no longer `running`, the API forgets it, or the limit passes. True
   * when the page's cancel stopped it: the follow then ends with no thread, as a stream's
   * confirmed cancel does.
   */
  private async pollRun(follow: FollowedAnswer, runId: string): Promise<boolean> {
    follow.runFound(runId);
    const started = Date.now();
    const log = this.deps.logger.child({ meetingId: follow.meetingId, runId });
    for (;;) {
      const status = await this.runStatus(follow.meetingId, runId, log);
      if (status === 'cancelled' && follow.cancel !== null) return true;
      if (status !== 'running' && status !== 'unread') return false;
      const elapsed = Date.now() - started;
      if (elapsed >= CHAT_RUN_POLL_LIMIT_MS) {
        log.warn('chat run still running when its poll stopped', { elapsedMs: elapsed });
        return false;
      }
      const wait =
        elapsed < CHAT_RUN_POLL_FAST_FOR_MS ? CHAT_RUN_POLL_FAST_MS : CHAT_RUN_POLL_SLOW_MS;
      if (!(await this.sleep(wait, follow))) return false;
    }
  }

  /**
   * One read of the run: its status, `ended` when there is nothing more to wait for (the quit
   * came, or the API does not hold it), `unread` when it could not be read this turn.
   */
  private async runStatus(
    meetingId: string,
    runId: string,
    log: Logger,
  ): Promise<LlmRunStatus | 'ended' | 'unread'> {
    if (this.isStopped()) return 'ended';
    try {
      const run = await this.deps.api.getRun(meetingId, runId);
      return run.status;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      // The API does not hold the run (another workspace's id, a reset database): the thread
      // says what there is.
      if (error.isNotFound) return 'ended';
      // Away or failing: read again at the next turn, up to the limit.
      log.info('chat run not read', { code: error.code, status: error.status });
      return 'unread';
    }
  }

  /**
   * Waits `ms`, or until a cancel of the followed answer was answered; false when stop() ended
   * the wait.
   */
  private sleep(ms: number, follow: FollowedAnswer): Promise<boolean> {
    return new Promise((resolve) => {
      const end = (goOn: boolean): void => {
        clearTimeout(timer);
        this.sleeps.delete(stop);
        follow.wake = null;
        resolve(goOn);
      };
      const stop = (): void => {
        end(false);
      };
      const timer = setTimeout(() => {
        end(!this.isStopped());
      }, ms);
      this.sleeps.add(stop);
      follow.wake = () => {
        end(true);
      };
    });
  }
}

/** The run still writing the answer to `request`'s question in `thread`, or null. */
function runWriting(thread: ChatThread, request: SendChatMessageRequest): string | null {
  const answer = thread.messages.find(
    (message) => message.replyTo === request.messageId && message.status === 'streaming',
  );
  return answer?.runId ?? null;
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
