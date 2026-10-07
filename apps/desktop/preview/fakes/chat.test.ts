import { describe, expect, it } from 'vitest';
import { chatChannels, type ChatStreamMessage } from '../../src/shared/ipc/chat';
import type { ChatMessage, ChatStreamEvent } from '../../src/shared/notes';
import { PreviewHub } from '../control';
import { createChatFake } from './chat';
import { FakeHub } from './hub';

const MEETING = '2f6a7d0e-58d4-4c4b-9a0e-0d6f1f7a3c11';
const QUESTION = '6e2b9f14-3c5d-4a7e-8b1f-2d4c6e8a0b13';

function answer(fields: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    role: 'assistant',
    text: 'The pilot stays at $50k [L12].',
    citations: [
      { ref: 'L12', segmentId: 'd78ca638-bc0d-4fcf-ae63-3272836dda46', startMs: 305_000 },
    ],
    replyTo: QUESTION,
    runId: '8c1e3b52-7a40-4c7e-9f3d-5b2a1c9e0d47',
    status: 'complete',
    createdAt: '2026-10-06T11:00:05.000Z',
    ...fields,
  };
}

function setUp() {
  const hub = new FakeHub();
  const chat = createChatFake(hub);
  const events: ChatStreamMessage[] = [];
  chat.onChatEvent((message) => events.push(message));
  const stream = (messageId: string, event: ChatStreamEvent): void => {
    hub.emit(chatChannels.ChatEvent, { meetingId: MEETING, messageId, event });
  };
  return { hub, chat, events, stream };
}

describe('the chat fake', () => {
  it('stores a question once, however often it is re-sent', async () => {
    const { chat } = setUp();
    const question = { meetingId: MEETING, messageId: QUESTION, text: 'What is the pilot price?' };
    await chat.sendChatMessage(question);
    await chat.sendChatMessage(question);

    const { messages } = await chat.getChatThread(MEETING);
    expect(messages).toEqual([
      {
        id: QUESTION,
        role: 'user',
        text: 'What is the pilot price?',
        citations: [],
        replyTo: null,
        runId: null,
        status: 'complete',
        createdAt: expect.any(String) as string,
      },
    ]);
  });

  it('refuses a question the API would refuse', async () => {
    const { chat } = setUp();
    await expect(
      chat.sendChatMessage({ meetingId: MEETING, messageId: QUESTION, text: '   ' }),
    ).rejects.toThrow('not a question');
    await expect(chat.getChatThread(MEETING)).resolves.toEqual({
      meetingId: MEETING,
      messages: [],
    });
  });

  it("adds an answer's done message to the thread, and takes a thread a scenario pushes", async () => {
    const { hub, chat, stream } = setUp();
    await chat.sendChatMessage({ meetingId: MEETING, messageId: QUESTION, text: 'Price?' });
    stream(QUESTION, { type: 'delta', text: 'The pilot ' });
    stream(QUESTION, { type: 'done', message: answer() });
    const thread = await chat.getChatThread(MEETING);
    expect(thread.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(thread.messages[1]).toEqual(answer());

    const pushed = { meetingId: MEETING, messages: [answer({ status: 'failed' })] };
    hub.emit(chatChannels.ChatThreadChanged, pushed);
    await expect(chat.getChatThread(MEETING)).resolves.toEqual(pushed);
  });

  it('cancel ends an answer in progress with a cancelled error, and nothing after it ended', async () => {
    const { chat, events, stream } = setUp();
    await chat.sendChatMessage({ meetingId: MEETING, messageId: QUESTION, text: 'Price?' });
    await chat.cancelChatAnswer({ meetingId: MEETING, messageId: QUESTION });
    expect(events).toEqual([
      {
        meetingId: MEETING,
        messageId: QUESTION,
        event: { type: 'error', code: 'cancelled', message: 'Cancelled.' },
      },
    ]);

    await chat.cancelChatAnswer({ meetingId: MEETING, messageId: QUESTION });
    const second = '1f2e3d4c-5b6a-4978-8a6b-5c4d3e2f1a0b';
    await chat.sendChatMessage({ meetingId: MEETING, messageId: second, text: 'Owner?' });
    stream(second, { type: 'done', message: answer({ replyTo: second }) });
    await chat.cancelChatAnswer({ meetingId: MEETING, messageId: second });
    expect(events.map((message) => message.event.type)).toEqual(['error', 'done']);
  });
});

describe('the chat fake with the API offline', () => {
  it("fails the thread read with main's ApiError for its route, which the page words", async () => {
    const hub = new PreviewHub();
    const chat = createChatFake(hub);
    hub.setApiOffline(true);
    await expect(chat.getChatThread(MEETING)).rejects.toThrow(
      `Error invoking remote method 'chat:get-thread': ApiError: GET /v1/meetings/${MEETING}/chat failed: connect ECONNREFUSED 127.0.0.1:8000`,
    );
    hub.setApiOffline(false);
    await expect(chat.getChatThread(MEETING)).resolves.toEqual({
      meetingId: MEETING,
      messages: [],
    });
  });
});
