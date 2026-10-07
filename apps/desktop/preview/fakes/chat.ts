import { chatChannels, type ChatApi, type ChatStreamMessage } from '../../src/shared/ipc/chat';
import { type ChatMessage, type ChatThread, isChatText } from '../../src/shared/notes';
import type { FakeHub } from './hub';

/**
 * Chat's part of the preview's `window.roger`: main with a healthy API, minus the model. A
 * question is stored once per message id, as the API stores it; a scenario streams the answer on
 * ChatEvent, and its `done` message joins the thread. A thread a scenario pushes on
 * ChatThreadChanged becomes the one getChatThread answers, as it would be in main.
 */
export function createChatFake(hub: FakeHub): ChatApi {
  const threads = new Map<string, ChatMessage[]>();
  /** Questions whose answer has not ended, as `${meetingId}/${messageId}`. */
  const answering = new Set<string>();
  const answerKey = (meetingId: string, messageId: string): string => `${meetingId}/${messageId}`;

  hub.on(chatChannels.ChatThreadChanged, (thread: ChatThread) => {
    threads.set(thread.meetingId, thread.messages);
  });
  hub.on(chatChannels.ChatEvent, ({ meetingId, messageId, event }: ChatStreamMessage) => {
    if (event.type !== 'done' && event.type !== 'error') return;
    answering.delete(answerKey(meetingId, messageId));
    if (event.type === 'done') {
      const others = (threads.get(meetingId) ?? []).filter(({ id }) => id !== event.message.id);
      threads.set(meetingId, [...others, event.message]);
    }
  });

  return {
    getChatThread: (meetingId) =>
      hub.request(chatChannels.ChatGetThread, () => ({
        meetingId,
        messages: structuredClone(threads.get(meetingId) ?? []),
      })),
    sendChatMessage: ({ meetingId, messageId, text }) =>
      hub.request(chatChannels.ChatSend, () => {
        if (!isChatText(text)) {
          throw new Error(`message ${messageId} is not a question the API takes`);
        }
        const thread = threads.get(meetingId) ?? [];
        answering.add(answerKey(meetingId, messageId));
        // A re-sent message id never stores a second question.
        if (thread.some(({ id }) => id === messageId)) return;
        threads.set(meetingId, [
          ...thread,
          {
            id: messageId,
            role: 'user',
            text,
            citations: [],
            replyTo: null,
            runId: null,
            status: 'complete',
            createdAt: new Date().toISOString(),
          },
        ]);
      }),
    cancelChatAnswer: ({ meetingId, messageId }) =>
      hub.request(chatChannels.ChatCancel, () => {
        if (!answering.has(answerKey(meetingId, messageId))) return;
        // As the API ends a cancelled answer's stream.
        hub.emit(chatChannels.ChatEvent, {
          meetingId,
          messageId,
          event: { type: 'error', code: 'cancelled', message: 'Cancelled.' },
        });
      }),
    onChatEvent: (listener) => hub.on(chatChannels.ChatEvent, listener),
    onChatThreadChanged: (listener) => hub.on(chatChannels.ChatThreadChanged, listener),
  };
}
