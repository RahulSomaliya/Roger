import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ChatApi, ChatStreamMessage } from '../../../shared/ipc/chat';
import type { Unsubscribe } from '../../../shared/ipc/unsubscribe';
import { type ChatMessage, type ChatThread, isChatText } from '../../../shared/notes';
import { describeError } from '../app/describeError';
import {
  applyChatEvent,
  canRetry,
  type ChatAnswer,
  failedAnswer,
  isAnswering,
  NO_ANSWER,
  NOT_SENT,
  storedAnswer,
  WAITING_ANSWER,
} from './chatStream';

/**
 * One meeting's chat as the panel shows it: the thread main reads from the API, and the answers
 * this page follows as their events arrive (`chat:event`, chatStream.ts).
 *
 * Main streams each answer to the page that asked, one terminal event per question (`done`, or
 * `error`, `cancelled` included). A stream main loses (the network, a cancel the API did not
 * confirm, a `done` that beat a cancel) sends no terminal event: main polls the run to its end and
 * sends the whole thread instead (`chat:thread-changed`). So a thread from main can be the only
 * word on an answer this page shows as still coming, and it can also arrive while another answer
 * streams, or be read before a retry began. `takeThread` decides which wins, per question.
 *
 * Main only logs a thread it could not read after a lost stream; the page reads the thread again
 * whenever the meeting opens (`start`).
 */

export type MeetingChatApi = Pick<
  ChatApi,
  'getChatThread' | 'sendChatMessage' | 'cancelChatAnswer' | 'onChatEvent' | 'onChatThreadChanged'
>;

export interface ChatQuestion {
  id: string;
  text: string;
}

/** A question and its answer, in thread order. */
export interface ChatExchange {
  /** The question's id; an answer whose question is past the thread's limit has its own. */
  key: string;
  /** Null for an answer whose question the thread no longer holds (`GET .../chat?limit=`). */
  question: ChatQuestion | null;
  answer: ChatAnswer;
  /** This page follows the answer's events, so Stop can reach it. */
  live: boolean;
}

export interface MeetingChatState {
  /** `loading` until main answers the first read; `failed` when it could not read the thread. */
  status: 'loading' | 'ready' | 'failed';
  /** Why the thread could not be read. */
  error: string | null;
  exchanges: readonly ChatExchange[];
  /** An answer this page follows is still coming: the next question waits for it, or for Stop. */
  answering: boolean;
  /** News that belongs to no one answer: a Stop main could not pass on. */
  notice: string | null;
}

export class MeetingChatStore {
  private state: MeetingChatState = {
    status: 'loading',
    error: null,
    exchanges: [],
    answering: false,
    notice: null,
  };
  private readonly listeners = new Set<() => void>();
  /** The thread as main last read it, oldest first. */
  private thread: readonly ChatMessage[] = [];
  /** Questions asked here that the thread does not hold yet, in the order asked. */
  private asked: ChatQuestion[] = [];
  /** Answers this page follows, by question id. Where it holds one, it is what the page shows. */
  private readonly live = new Map<string, ChatAnswer>();
  /**
   * The runs of a question's tries before its latest retry. A thread main read before the retry
   * began still names one of them as failed; that failure is over, and must not end the new try.
   */
  private readonly retiredRuns = new Map<string, Set<string | null>>();
  /**
   * Each question's tries sent from this page. A retry puts the same waiting answer back under the
   * same id, so only this tells a Stop's late reply that the try it was pressed on is over.
   */
  private readonly tries = new Map<string, number>();
  /** Bumped by every start and stop, so an answer to an earlier start is dropped. */
  private run = 0;
  /** A thread arrived since the read began: it is newer than what the read will answer. */
  private changedSinceLoad = false;
  private stopListening: Unsubscribe | null = null;

  constructor(
    private readonly api: MeetingChatApi,
    readonly meetingId: string,
    /** A new question's id. The API stores it, and a retry re-sends it. */
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  readonly getState = (): MeetingChatState => this.state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Follows main's chat events and reads the thread; returns the function that stops both. */
  start(): Unsubscribe {
    this.stopListening?.();
    this.run += 1;
    const run = this.run;
    const stopEvents = this.api.onChatEvent((message) => {
      if (run === this.run) this.followEvent(message);
    });
    const stopThreads = this.api.onChatThreadChanged((thread) => {
      if (run === this.run) this.threadChanged(thread);
    });
    this.stopListening = () => {
      stopEvents();
      stopThreads();
    };
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
    this.update({ status: 'loading', error: null });
    this.load(this.run);
  }

  /**
   * Asks `text` (trimmed) with a new id. False, and nothing sent, before the thread is read, while
   * an answer is still coming, or for text the API would refuse (`isChatText`).
   */
  ask(text: string): boolean {
    const asked = text.trim();
    if (!this.canAsk() || !isChatText(asked)) return false;
    const question = { id: this.newId(), text: asked };
    this.asked.push(question);
    this.live.set(question.id, WAITING_ANSWER);
    this.update({ notice: null });
    this.send(question);
    return true;
  }

  /**
   * Asks a question whose answer failed again, with its own id: the API writes that answer again
   * with a new run, or replays it if it was stored meanwhile.
   */
  retry(questionId: string): void {
    const exchange = this.state.exchanges.find(({ question }) => question?.id === questionId);
    if (exchange?.question == null || !canRetry(exchange.answer) || !this.canAsk()) return;
    const retired = this.retiredRuns.get(questionId) ?? new Set<string | null>();
    retired.add(exchange.answer.runId);
    retired.add(latestAnswer(this.thread, questionId)?.runId ?? null);
    this.retiredRuns.set(questionId, retired);
    this.live.set(questionId, WAITING_ANSWER);
    this.update({ notice: null });
    this.send(exchange.question);
  }

  /**
   * Stops an answer still coming. Main tells the page `cancelled` at once and asks the API to stop
   * the run, which can take as long as the API takes to name the run: never wait on it here. An
   * answer that beat the Stop still arrives, as a thread from main.
   */
  cancel(questionId: string): void {
    const answer = this.live.get(questionId);
    if (answer === undefined || !isAnswering(answer)) return;
    const run = this.run;
    const stoppedTry = this.tries.get(questionId);
    this.api.cancelChatAnswer({ meetingId: this.meetingId, messageId: questionId }).then(
      () => {
        if (run !== this.run) return;
        // Main sends `cancelled` before it answers, for a stream and for a lost answer it still
        // follows. With neither left (a lost answer whose thread main could not read again) it
        // answers and sends nothing: still shown as coming, the answer would hold every next
        // question back until the meeting is opened again.
        //
        // Main may answer only once the API stopped the run, long after its `cancelled` offered
        // Ask again: a retry main took meanwhile is a new paid run, not this Stop's to end.
        if (this.tries.get(questionId) !== stoppedTry) return;
        const current = this.live.get(questionId);
        if (current === undefined || !isAnswering(current)) return;
        this.live.set(
          questionId,
          failedAnswer(current, { code: 'cancelled', message: 'The answer was cancelled.' }),
        );
        this.update({});
      },
      (error: unknown) => {
        if (run !== this.run) return;
        this.update({
          notice: `Roger could not stop that answer (${describeError(error)}). It may still arrive.`,
        });
      },
    );
  }

  private canAsk(): boolean {
    return this.state.status === 'ready' && !this.state.answering;
  }

  private send(question: ChatQuestion): void {
    const run = this.run;
    this.tries.set(question.id, (this.tries.get(question.id) ?? 0) + 1);
    this.api
      .sendChatMessage({ meetingId: this.meetingId, messageId: question.id, text: question.text })
      .catch((error: unknown) => {
        if (run !== this.run) return;
        // Main took nothing, so no event will come for this try.
        const answer = this.live.get(question.id) ?? WAITING_ANSWER;
        this.live.set(
          question.id,
          failedAnswer(answer, { code: NOT_SENT, message: describeError(error) }),
        );
        this.update({});
      });
  }

  private load(run: number): void {
    this.changedSinceLoad = false;
    this.api.getChatThread(this.meetingId).then(
      (thread) => {
        if (run !== this.run) return;
        if (!this.changedSinceLoad && thread.meetingId === this.meetingId) {
          this.takeThread(thread.messages);
        }
        this.update({ status: 'ready', error: null });
      },
      (error: unknown) => {
        if (run !== this.run) return;
        // A thread that came meanwhile is the thread; only with none is the read a failure.
        if (this.changedSinceLoad) this.update({ status: 'ready', error: null });
        else this.update({ status: 'failed', error: describeError(error) });
      },
    );
  }

  private threadChanged(thread: ChatThread): void {
    if (thread.meetingId !== this.meetingId) return;
    this.changedSinceLoad = true;
    this.takeThread(thread.messages);
    this.update({ status: 'ready', error: null });
  }

  /**
   * Takes a thread main read. Per question this page follows: a stored complete answer always
   * wins (it is never written again; it is also how an answer that beat a Stop arrives). A stored
   * failure ends an answer still coming, unless it names a run of a try before a retry (read
   * before the retry began). A stored answer still being written leaves the live one alone: it is
   * this page's own stream, ahead of the read.
   */
  private takeThread(messages: readonly ChatMessage[]): void {
    for (const [questionId, answer] of this.live) {
      const stored = latestAnswer(messages, questionId);
      if (stored !== undefined && this.storedWins(questionId, stored, answer)) {
        this.live.delete(questionId);
      }
    }
    this.thread = messages;
    const held = new Set(messages.map(({ id }) => id));
    this.asked = this.asked.filter(({ id }) => !held.has(id));
  }

  private storedWins(questionId: string, stored: ChatMessage, answer: ChatAnswer): boolean {
    switch (stored.status) {
      case 'complete':
        return true;
      case 'streaming':
        return false;
      case 'failed':
        return (
          isAnswering(answer) && !(this.retiredRuns.get(questionId)?.has(stored.runId) ?? false)
        );
    }
  }

  private followEvent({ meetingId, messageId, event }: ChatStreamMessage): void {
    if (meetingId !== this.meetingId) return;
    const answer = this.live.get(messageId);
    if (answer === undefined) {
      // Not an answer this page followed from its start: one asked before the page opened (a
      // reload, the meeting opened again), still streaming to this window. Its middle is no
      // answer; its `run` starts it over, and `done` or `error` is all of it. A stored complete
      // answer is final: a late event (a `cancelled` after the thread came) cannot unmake it.
      if (event.type === 'delta' || event.type === 'citation') return;
      if (latestAnswer(this.thread, messageId)?.status === 'complete') return;
    }
    this.live.set(messageId, applyChatEvent(answer ?? WAITING_ANSWER, event));
    this.update({});
  }

  private update(changes: Partial<Pick<MeetingChatState, 'status' | 'error' | 'notice'>>): void {
    const exchanges = exchangesOf(this.thread, this.asked, this.live);
    this.state = {
      ...this.state,
      ...changes,
      exchanges,
      answering: exchanges.some(({ live, answer }) => live && isAnswering(answer)),
    };
    for (const listener of [...this.listeners]) listener();
  }
}

/** The thread's latest answer to `questionId` (an answer written again keeps its row). */
function latestAnswer(
  messages: readonly ChatMessage[],
  questionId: string,
): ChatMessage | undefined {
  return messages.findLast(({ role, replyTo }) => role === 'assistant' && replyTo === questionId);
}

function exchangesOf(
  thread: readonly ChatMessage[],
  asked: readonly ChatQuestion[],
  live: ReadonlyMap<string, ChatAnswer>,
): ChatExchange[] {
  const questions = new Set<string>();
  const answers = new Map<string, ChatMessage>();
  for (const message of thread) {
    if (message.role === 'user') questions.add(message.id);
    else if (message.replyTo !== null) answers.set(message.replyTo, message);
  }
  const exchange = (question: ChatQuestion): ChatExchange => {
    const following = live.get(question.id);
    if (following !== undefined) {
      return { key: question.id, question, answer: following, live: true };
    }
    const stored = answers.get(question.id);
    const answer = stored === undefined ? NO_ANSWER : storedAnswer(stored);
    return { key: question.id, question, answer, live: false };
  };
  const exchanges = thread.flatMap((message): ChatExchange[] => {
    if (message.role === 'user') return [exchange({ id: message.id, text: message.text })];
    if (message.replyTo !== null && questions.has(message.replyTo)) return [];
    return [{ key: message.id, question: null, answer: storedAnswer(message), live: false }];
  });
  return [...exchanges, ...asked.map(exchange)];
}

export interface MeetingChatHandle {
  chat: MeetingChatStore;
  state: MeetingChatState;
}

/** The meeting's chat over `window.roger`, for as long as the calling panel is mounted. */
export function useMeetingChat(meetingId: string): MeetingChatHandle {
  const chat = useMemo(() => new MeetingChatStore(window.roger, meetingId), [meetingId]);
  const state = useSyncExternalStore(chat.subscribe, chat.getState);
  useEffect(() => chat.start(), [chat]);
  return { chat, state };
}
