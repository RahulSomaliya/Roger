import { describe, expect, it } from 'vitest';
import type {
  ChatAnswerRequest,
  ChatStreamMessage,
  SendChatMessageRequest,
} from '../../../shared/ipc/chat';
import {
  type ChatMessage,
  type ChatStreamEvent,
  type ChatThread,
  MAX_CHAT_TEXT_CHARS,
  type RefCitation,
} from '../../../shared/notes';
import { type ChatExchange, MeetingChatStore, type MeetingChatApi } from './useMeetingChat';

const MEETING = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';
const OTHER_MEETING = '8d1e5b22-7c3a-4f60-8e19-5a2b9c0d7e33';
const ASKED = ['a1f0c3e2-5b7d-4e19-8c6a-2d4f6b8e0a11', 'b2e1d4f3-6c8e-4f2a-9d7b-3e5a7c9f1b22'];
const RUN_1 = '0b7e4c1a-9d2f-4e83-a6c5-3f1d8b2e7a90';
const RUN_2 = '7d1f3b9e-2c4a-4e68-8b05-6a9c2e4f1d73';
const L6: RefCitation = {
  ref: 'L6',
  segmentId: 'c3f2e5a4-7d9f-4a3b-8e8c-4f6b8d0a2c33',
  startMs: 34_700,
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function question(id: string, text: string): ChatMessage {
  return {
    id,
    role: 'user',
    text,
    citations: [],
    replyTo: null,
    runId: null,
    status: 'complete',
    createdAt: '2026-10-07T09:30:00.000Z',
  };
}

function answer(replyTo: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `${replyTo.slice(0, -4)}aaaa`,
    role: 'assistant',
    text: 'About fifteen hundred lines, with zero duplicates [L6].',
    citations: [L6],
    replyTo,
    runId: RUN_1,
    status: 'complete',
    createdAt: '2026-10-07T09:30:05.000Z',
    ...overrides,
  };
}

/** main's chat channels. Reads and sends answer when the test says. */
function fakeMain() {
  const eventListeners = new Set<(message: ChatStreamMessage) => void>();
  const threadListeners = new Set<(thread: ChatThread) => void>();
  const loads: { resolve: (thread: ChatThread) => void; reject: (error: Error) => void }[] = [];
  const sends: SendChatMessageRequest[] = [];
  const cancels: ChatAnswerRequest[] = [];
  let refuseSend: Error | null = null;
  let refuseCancel: Error | null = null;
  const api: MeetingChatApi = {
    getChatThread: () =>
      new Promise((resolve, reject) => {
        loads.push({ resolve, reject });
      }),
    sendChatMessage: (request) => {
      sends.push(request);
      const refusal = refuseSend;
      refuseSend = null;
      return refusal === null ? Promise.resolve() : Promise.reject(refusal);
    },
    cancelChatAnswer: (request) => {
      cancels.push(request);
      return refuseCancel === null ? Promise.resolve() : Promise.reject(refuseCancel);
    },
    onChatEvent: (listener) => {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    onChatThreadChanged: (listener) => {
      threadListeners.add(listener);
      return () => {
        threadListeners.delete(listener);
      };
    },
  };
  return {
    api,
    loads,
    sends,
    cancels,
    eventListeners,
    refuseNextSend: (error: Error) => {
      refuseSend = error;
    },
    refuseCancels: (error: Error) => {
      refuseCancel = error;
    },
    answerLoad: async (messages: ChatMessage[], meetingId = MEETING) => {
      loads.shift()?.resolve({ meetingId, messages });
      await settle();
    },
    failLoad: async (error: Error) => {
      loads.shift()?.reject(error);
      await settle();
    },
    event: (messageId: string, event: ChatStreamEvent, meetingId = MEETING) => {
      for (const listener of eventListeners) listener({ meetingId, messageId, event });
    },
    thread: (messages: ChatMessage[], meetingId = MEETING) => {
      for (const listener of threadListeners) listener({ meetingId, messages });
    },
  };
}

/** A chat started on MEETING, whose questions take the ids in ASKED, in order. */
async function openChat(thread: ChatMessage[] = []) {
  const main = fakeMain();
  const ids = [...ASKED];
  const chat = new MeetingChatStore(main.api, MEETING, () => {
    const id = ids.shift();
    if (id === undefined) throw new Error('The test ran out of question ids');
    return id;
  });
  const stop = chat.start();
  await main.answerLoad(thread);
  return { main, chat, stop };
}

/** One exchange as a line a test can compare. */
function line({ question: asked, answer: { phase, text, error }, live }: ChatExchange): string {
  const why = error === null ? '' : ` (${error.code})`;
  return `${asked?.text ?? '-'} => ${phase}${why}: ${text}${live ? ' [live]' : ''}`;
}

const lines = (chat: MeetingChatStore): string[] => chat.getState().exchanges.map(line);

const run = (runId = RUN_1): ChatStreamEvent => ({ type: 'run', runId, model: 'm' });
const delta = (text: string): ChatStreamEvent => ({ type: 'delta', text });

describe('MeetingChatStore', () => {
  it('loads the thread and pairs each question with its answer', async () => {
    const q1 = question('11111111-1111-4111-8111-111111111111', 'How many lines did it upload?');
    const q2 = question('22222222-2222-4222-8222-222222222222', 'Who reviews the eval report?');
    const q3 = question('33333333-3333-4333-8333-333333333333', 'When does M1 close?');
    // The oldest message is an answer whose question is past the thread's limit.
    const orphan = answer('00000000-0000-4000-8000-000000000000', { text: 'Thursday morning.' });
    const { chat } = await openChat([
      orphan,
      q1,
      answer(q1.id),
      q2,
      answer(q2.id, { status: 'failed', text: '' }),
      q3,
    ]);
    const state = chat.getState();
    expect(state.status).toBe('ready');
    expect(state.answering).toBe(false);
    expect(lines(chat)).toEqual([
      '- => complete: Thursday morning.',
      'How many lines did it upload? => complete: About fifteen hundred lines, with zero duplicates [L6].',
      'Who reviews the eval report? => failed (stored_failure): ',
      'When does M1 close? => failed (no_answer): ',
    ]);
    expect(state.exchanges.map(({ key }) => key)).toEqual([orphan.id, q1.id, q2.id, q3.id]);
  });

  it('shows a question at once and follows its answer through the events', async () => {
    const { main, chat } = await openChat();
    expect(chat.ask('  How many lines did the retry logic upload?  ')).toBe(true);
    expect(main.sends).toEqual([
      {
        meetingId: MEETING,
        messageId: ASKED[0],
        text: 'How many lines did the retry logic upload?',
      },
    ]);
    expect(lines(chat)).toEqual(['How many lines did the retry logic upload? => waiting:  [live]']);
    expect(chat.getState().answering).toBe(true);

    main.event(ASKED[0]!, run());
    main.event(ASKED[0]!, delta('About fifteen hundred [L6]'));
    main.event(ASKED[0]!, { type: 'citation', ...L6 });
    const streaming = chat.getState().exchanges[0]?.answer;
    expect(streaming).toMatchObject({ phase: 'streaming', text: 'About fifteen hundred [L6]' });
    expect(streaming?.citations).toEqual([L6]);

    main.event(ASKED[0]!, {
      type: 'done',
      message: answer(ASKED[0]!, { text: 'About fifteen hundred lines [L6].' }),
    });
    expect(lines(chat)).toEqual([
      'How many lines did the retry logic upload? => complete: About fifteen hundred lines [L6]. [live]',
    ]);
    expect(chat.getState().answering).toBe(false);
  });

  it('asks only what the API takes, one question at a time', async () => {
    const { main, chat } = await openChat();
    expect(chat.ask('   ')).toBe(false);
    expect(chat.ask('x'.repeat(MAX_CHAT_TEXT_CHARS + 1))).toBe(false);
    expect(chat.ask('First question')).toBe(true);
    expect(chat.ask('Second question')).toBe(false);
    expect(main.sends.map(({ text }) => text)).toEqual(['First question']);

    main.event(ASKED[0]!, {
      type: 'error',
      code: 'cancelled',
      message: 'The answer was cancelled.',
    });
    expect(chat.ask('Second question')).toBe(true);
  });

  it('asks nothing before the thread is read', () => {
    const main = fakeMain();
    const chat = new MeetingChatStore(main.api, MEETING, () => ASKED[0]!);
    chat.start();
    expect(chat.getState().status).toBe('loading');
    expect(chat.ask('Too early')).toBe(false);
    expect(main.sends).toEqual([]);
  });

  it('a question main did not take fails with its reason and can be asked again', async () => {
    const { main, chat } = await openChat();
    main.refuseNextSend(
      new Error(
        `Error invoking remote method 'chat:send': Error: the answer to message ${ASKED[0]!} is already on its way`,
      ),
    );
    chat.ask('Who is on the release checklist?');
    await settle();
    const failed = chat.getState().exchanges[0]?.answer;
    expect(failed?.phase).toBe('failed');
    expect(failed?.error).toEqual({
      code: 'not_sent',
      message: `the answer to message ${ASKED[0]!} is already on its way`,
    });
    expect(chat.getState().answering).toBe(false);

    chat.retry(ASKED[0]!);
    expect(main.sends).toEqual([
      { meetingId: MEETING, messageId: ASKED[0], text: 'Who is on the release checklist?' },
      { meetingId: MEETING, messageId: ASKED[0], text: 'Who is on the release checklist?' },
    ]);
    expect(lines(chat)).toEqual(['Who is on the release checklist? => waiting:  [live]']);
  });

  it('retry asks a failed question from the thread again, with its own id and text', async () => {
    const q = question('22222222-2222-4222-8222-222222222222', 'Who reviews the eval report?');
    const { main, chat } = await openChat([q, answer(q.id, { status: 'failed', text: '' })]);
    chat.retry(q.id);
    expect(main.sends).toEqual([{ meetingId: MEETING, messageId: q.id, text: q.text }]);
    expect(lines(chat)).toEqual(['Who reviews the eval report? => waiting:  [live]']);
  });

  it('does not retry an answer that cannot change, or one still coming', async () => {
    const { main, chat } = await openChat();
    chat.ask('Summarise the whole call');
    chat.retry(ASKED[0]!);
    main.event(ASKED[0]!, {
      type: 'error',
      code: 'meeting_too_long',
      message: 'Meeting is over the chat budget',
    });
    chat.retry(ASKED[0]!);
    expect(main.sends).toHaveLength(1);
  });

  it('ignores events of another meeting, and a stream it did not see start until its run', async () => {
    const q = question('11111111-1111-4111-8111-111111111111', 'How many lines?');
    const { main, chat } = await openChat([q, answer(q.id, { status: 'streaming', text: '' })]);
    const before = chat.getState();
    main.event(q.id, delta('Half'), OTHER_MEETING);
    main.thread([], OTHER_MEETING);
    // The middle of a stream this page did not see begin (it opened mid-answer) is no answer.
    main.event(q.id, delta('teen hundred'));
    expect(chat.getState()).toBe(before);
    expect(lines(chat)).toEqual(['How many lines? => streaming: ']);

    main.event(q.id, { type: 'done', message: answer(q.id) });
    expect(lines(chat)).toEqual([
      'How many lines? => complete: About fifteen hundred lines, with zero duplicates [L6]. [live]',
    ]);
  });

  it('a thread from main after a lost stream replaces the answer it was showing', async () => {
    const { main, chat } = await openChat();
    chat.ask('How many lines?');
    main.event(ASKED[0]!, run());
    main.event(ASKED[0]!, delta('About fif'));
    // The stream was lost; main polled the run to its end and read the thread again.
    main.thread([question(ASKED[0]!, 'How many lines?'), answer(ASKED[0]!)]);
    expect(lines(chat)).toEqual([
      'How many lines? => complete: About fifteen hundred lines, with zero duplicates [L6].',
    ]);
    expect(chat.getState().answering).toBe(false);
  });

  it("a lost stream's failed run shows as failed, ready to ask again", async () => {
    const { main, chat } = await openChat();
    chat.ask('How many lines?');
    main.event(ASKED[0]!, run());
    main.event(ASKED[0]!, delta('About fif'));
    main.thread([
      question(ASKED[0]!, 'How many lines?'),
      answer(ASKED[0]!, { status: 'failed', text: '' }),
    ]);
    expect(lines(chat)).toEqual(['How many lines? => failed (stored_failure): ']);
    expect(chat.getState().answering).toBe(false);
  });

  it('a stream lost before its run event ends with the failure the thread names', async () => {
    const { main, chat } = await openChat();
    chat.ask('How many lines?');
    main.thread([
      question(ASKED[0]!, 'How many lines?'),
      answer(ASKED[0]!, { status: 'failed', text: '', runId: RUN_2 }),
    ]);
    expect(lines(chat)).toEqual(['How many lines? => failed (stored_failure): ']);
  });

  it('a thread read while an answer streams keeps the answer coming', async () => {
    const { main, chat } = await openChat();
    chat.ask('How many lines?');
    main.event(ASKED[0]!, run());
    main.event(ASKED[0]!, delta('About fif'));
    // Another lost answer's thread, read while this one is still being written.
    main.thread([
      question(ASKED[0]!, 'How many lines?'),
      answer(ASKED[0]!, { status: 'streaming', text: '' }),
    ]);
    expect(lines(chat)).toEqual(['How many lines? => streaming: About fif [live]']);
    expect(chat.getState().answering).toBe(true);
  });

  it('a retried answer is not undone by a thread read before the retry', async () => {
    const q = question('22222222-2222-4222-8222-222222222222', 'Who reviews the eval report?');
    const failedTry = answer(q.id, { status: 'failed', text: '', runId: RUN_1 });
    const { main, chat } = await openChat([q, failedTry]);
    chat.retry(q.id);
    // Read by main before this try began: it still names the first try's failed run.
    main.thread([q, failedTry]);
    expect(lines(chat)).toEqual(['Who reviews the eval report? => waiting:  [live]']);
    main.event(q.id, run(RUN_2));
    main.event(q.id, delta('Priyanka, on Thursday'));
    main.thread([q, failedTry]);
    expect(lines(chat)).toEqual([
      'Who reviews the eval report? => streaming: Priyanka, on Thursday [live]',
    ]);
  });

  it('a stopped answer that finished first shows the stored answer', async () => {
    const { main, chat } = await openChat();
    chat.ask('How many lines?');
    main.event(ASKED[0]!, run());
    main.event(ASKED[0]!, delta('About'));
    chat.cancel(ASKED[0]!);
    expect(main.cancels).toEqual([{ meetingId: MEETING, messageId: ASKED[0] }]);
    // main tells the page at once, as LlmStreams does for every cancel.
    main.event(ASKED[0]!, {
      type: 'error',
      code: 'cancelled',
      message: 'The answer was cancelled.',
    });
    expect(lines(chat)).toEqual(['How many lines? => failed (cancelled): About [live]']);

    // The run beat the cancel: main polled it and sends the thread holding the stored answer.
    main.thread([question(ASKED[0]!, 'How many lines?'), answer(ASKED[0]!)]);
    expect(lines(chat)).toEqual([
      'How many lines? => complete: About fifteen hundred lines, with zero duplicates [L6].',
    ]);
    // A late event cannot unmake the stored answer.
    main.event(ASKED[0]!, {
      type: 'error',
      code: 'cancelled',
      message: 'The answer was cancelled.',
    });
    expect(lines(chat)).toEqual([
      'How many lines? => complete: About fifteen hundred lines, with zero duplicates [L6].',
    ]);
  });

  it('a cancel main could not pass on says the answer may still come', async () => {
    const { main, chat } = await openChat();
    chat.ask('How many lines?');
    main.refuseCancels(new Error("Error invoking remote method 'chat:cancel': ApiError: offline"));
    chat.cancel(ASKED[0]!);
    await settle();
    expect(chat.getState().notice).toBe(
      'Roger could not stop that answer (offline). It may still arrive.',
    );
    // Stop is only for an answer still coming.
    main.event(ASKED[0]!, { type: 'done', message: answer(ASKED[0]!) });
    chat.cancel(ASKED[0]!);
    expect(main.cancels).toHaveLength(1);
    // The next question clears it.
    chat.ask('And the duplicates?');
    expect(chat.getState().notice).toBeNull();
  });

  it('a question the thread now holds is shown once, in thread order', async () => {
    const earlier = question('11111111-1111-4111-8111-111111111111', 'How many lines?');
    const { main, chat } = await openChat([earlier, answer(earlier.id)]);
    chat.ask('Any duplicates?');
    main.event(ASKED[0]!, run());
    main.thread([
      earlier,
      answer(earlier.id),
      question(ASKED[0]!, 'Any duplicates?'),
      answer(ASKED[0]!, { status: 'streaming', text: '' }),
    ]);
    expect(chat.getState().exchanges.map(({ key }) => key)).toEqual([earlier.id, ASKED[0]]);
  });

  it('a failed read offers to read again', async () => {
    const main = fakeMain();
    const chat = new MeetingChatStore(main.api, MEETING, () => ASKED[0]!);
    chat.start();
    await main.failLoad(
      new Error("Error invoking remote method 'chat:get-thread': ApiError: GET failed"),
    );
    expect(chat.getState()).toMatchObject({ status: 'failed', error: 'GET failed' });

    chat.reload();
    expect(chat.getState()).toMatchObject({ status: 'loading', error: null });
    await main.answerLoad([question(ASKED[0]!, 'How many lines?')]);
    expect(chat.getState().status).toBe('ready');
    expect(lines(chat)).toEqual(['How many lines? => failed (no_answer): ']);
  });

  it('a thread from main while the read is on its way wins over that read', async () => {
    const main = fakeMain();
    const chat = new MeetingChatStore(main.api, MEETING, () => ASKED[0]!);
    chat.start();
    const q = question('11111111-1111-4111-8111-111111111111', 'How many lines?');
    main.thread([q, answer(q.id)]);
    expect(chat.getState().status).toBe('ready');
    await main.answerLoad([q, answer(q.id, { status: 'streaming', text: '' })]);
    expect(lines(chat)).toEqual([
      'How many lines? => complete: About fifteen hundred lines, with zero duplicates [L6].',
    ]);
  });

  it('stops listening when stopped, and drops a read answered after', async () => {
    const main = fakeMain();
    const chat = new MeetingChatStore(main.api, MEETING, () => ASKED[0]!);
    const stop = chat.start();
    stop();
    expect(main.eventListeners.size).toBe(0);
    await main.answerLoad([question(ASKED[0]!, 'Late')]);
    expect(chat.getState().status).toBe('loading');

    // Started again (React's StrictMode runs every effect twice): one subscription, one read.
    chat.start();
    expect(main.eventListeners.size).toBe(1);
    await main.answerLoad([]);
    expect(chat.getState().status).toBe('ready');
  });
});
