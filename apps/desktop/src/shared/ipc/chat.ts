import type { ChatStreamEvent, ChatThread } from '../notes';
import type { Unsubscribe } from './unsubscribe';

/**
 * Chat's channels: questions to one meeting, answered with citations. Main registers them in
 * src/main/notes/notes-ipc.ts (M4-T16) with the notes channels, and validates every payload
 * before use (`isChatText` in src/shared/notes.ts for the question).
 */
export const chatChannels = {
  /** renderer → main, invoke */
  ChatGetThread: 'chat:get-thread',
  ChatSend: 'chat:send',
  ChatCancel: 'chat:cancel',
  /** main → renderer events */
  ChatEvent: 'chat:event',
  ChatThreadChanged: 'chat:thread-changed',
} as const;

export interface SendChatMessageRequest {
  meetingId: string;
  /**
   * Made by the page, once per question. A retry sends the same id: the API never stores a second
   * message for it, replays a complete answer, attaches to a streaming one and answers a failed
   * one again.
   */
  messageId: string;
  text: string;
}

export interface ChatAnswerRequest {
  meetingId: string;
  /** The question whose answer this is about. */
  messageId: string;
}

/** One event of the answer to a question, as main forwards it from the API's stream. */
export interface ChatStreamMessage {
  meetingId: string;
  /** The question being answered. */
  messageId: string;
  event: ChatStreamEvent;
}

/** Chat's part of `window.roger`. */
export interface ChatApi {
  getChatThread(meetingId: string): Promise<ChatThread>;
  /**
   * Resolves once main has taken the question. The answer, and any failure, a refusal before the
   * stream included (`meeting_too_long`), arrives as `chat:event` messages for this message id.
   */
  sendChatMessage(request: SendChatMessageRequest): Promise<void>;
  /** Stops an answer in progress: its stream ends with a `cancelled` error. */
  cancelChatAnswer(request: ChatAnswerRequest): Promise<void>;
  onChatEvent(listener: (message: ChatStreamMessage) => void): Unsubscribe;
  /**
   * The whole thread, read again from the API: after a dropped answer stream, once main has polled
   * its run to the end.
   */
  onChatThreadChanged(listener: (thread: ChatThread) => void): Unsubscribe;
}
