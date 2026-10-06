import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { chatChannels, type ChatStreamMessage } from '../../shared/ipc/chat';
import { notesChannels, type NotesStreamMessage } from '../../shared/ipc/notes';
import type { ChatMessage, Note } from '../../shared/notes';
import { createStreamRequest } from '../api/streamRequest';
import { createLogger } from '../logger';
import { LlmStreams, type StreamWindow } from './LlmStreams';

const MEETING = '0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b';
const OTHER_MEETING = '5d2e8a4f-7b1c-4e9d-8a3f-2c6b1e0d9f7a';
const RUN = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const CHAT_RUN = 'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f';
const QUESTION = 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b';
const ANSWER = 'f7e6d5c4-b3a2-4918-8a7b-6c5d4e3f2a1b';
const SEGMENT = '7f3c2b1a-0d9e-4f8a-b7c6-5d4e3f2a1b0c';

/** One request to the fake API: the test answers it, then writes its event stream. */
interface FakeCall {
  url: string;
  body: unknown;
  signal: AbortSignal;
  /** The API took the request: answers 200 with an open event stream. */
  open(): void;
  /** The contract's error envelope before the stream. */
  refuse(status: number, code: string, message: string): void;
  send(event: string, data: unknown): void;
  /** The API closes the stream. */
  end(): void;
  /** The connection breaks mid-stream. */
  fail(): void;
}

/**
 * The API behind main's real stream client (createStreamRequest): every POST waits for the test
 * to answer it. Aborting a request rejects its fetch, or errors its body, as undici does.
 */
function fakeApi() {
  const calls: FakeCall[] = [];
  const encoder = new TextEncoder();
  const fetchImpl: typeof fetch = (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error('every stream request carries a signal');
      if (typeof init.body !== 'string') throw new Error('expected a JSON string body');
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
      });
      const write = (text: string) => {
        if (controller === null) throw new Error('the stream is not open');
        controller.enqueue(encoder.encode(text));
      };
      signal.addEventListener('abort', () => {
        const aborted = new DOMException('This operation was aborted', 'AbortError');
        reject(aborted);
        controller?.error(aborted);
      });
      calls.push({
        url: input instanceof Request ? input.url : input.toString(),
        body: JSON.parse(init.body),
        signal,
        open: () => {
          resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
        },
        refuse: (status, code, message) => {
          resolve(new Response(JSON.stringify({ error: { code, message } }), { status }));
        },
        send: (event, data) => {
          write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        end: () => {
          controller?.close();
        },
        fail: () => {
          controller?.error(new TypeError('terminated'));
        },
      });
    });
  return { calls, fetchImpl };
}

/** A window's webContents as LlmStreams sees it: a page to send to, which can close. */
function fakeWindow(id: number) {
  const events = new EventEmitter();
  let destroyed = false;
  const sent: { channel: string; payload: unknown }[] = [];
  const window: StreamWindow = {
    id,
    isDestroyed: () => destroyed,
    send: (channel, payload) => {
      sent.push({ channel, payload });
    },
    once: (event, listener) => events.once(event, listener),
  };
  return {
    window,
    sent,
    /** The payloads sent on one channel, in order. */
    on: (channel: string) => sent.filter((s) => s.channel === channel).map((s) => s.payload),
    close: () => {
      destroyed = true;
      events.emit('destroyed');
    },
  };
}

function harness() {
  const api = fakeApi();
  const lines: string[] = [];
  const cancelRun = vi
    .fn<(meetingId: string, runId: string) => Promise<unknown>>()
    .mockResolvedValue({});
  const streams = new LlmStreams({
    stream: createStreamRequest(
      { baseUrl: 'http://api.test', token: 'secret', fetchImpl: api.fetchImpl },
      { openTimeoutMs: 5_000, idleTimeoutMs: 5_000 },
    ),
    cancelRun,
    logger: createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) }),
  });
  /** The nth request the API received, once it has arrived. */
  const call = async (index: number): Promise<FakeCall> => {
    await vi.waitFor(() => {
      expect(api.calls.length).toBeGreaterThan(index);
    });
    return api.calls[index]!;
  };
  return { streams, api, call, cancelRun, lines };
}

const generate = { meetingId: MEETING, runId: RUN, templateId: 'standup' };

function notesRequest(overrides: Partial<typeof generate> = {}) {
  return { ...generate, userNotesVersion: 4, aiBaseVersion: 2, ...overrides };
}

const citationWire = { ref: 'L12', segment_id: SEGMENT, start_ms: 192_000 };
const citation = { ref: 'L12', segmentId: SEGMENT, startMs: 192_000 };

const aiDoc = {
  type: 'doc',
  content: [
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Beta ships Friday ' },
                {
                  type: 'citation',
                  attrs: { segmentIds: [SEGMENT], startMs: 192_000, label: '03:12', support: 'ok' },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const noteWire = {
  kind: 'ai',
  doc: aiDoc,
  version: 3,
  template_id: 'standup',
  last_run_id: RUN,
  generated_version: 3,
  updated_at: '2026-10-06T10:00:00Z',
};

const note: Note = {
  kind: 'ai',
  doc: { type: 'doc', content: aiDoc.content },
  version: 3,
  templateId: 'standup',
  lastRunId: RUN,
  generatedVersion: 3,
  updatedAt: '2026-10-06T10:00:00Z',
};

const answerWire = {
  id: ANSWER,
  role: 'assistant',
  text: 'Beta ships Friday [L12]',
  citations: [citationWire],
  reply_to: QUESTION,
  run_id: CHAT_RUN,
  status: 'complete',
  created_at: '2026-10-06T10:01:00Z',
};

const answer: ChatMessage = {
  id: ANSWER,
  role: 'assistant',
  text: 'Beta ships Friday [L12]',
  citations: [citation],
  replyTo: QUESTION,
  runId: CHAT_RUN,
  status: 'complete',
  createdAt: '2026-10-06T10:01:00Z',
};

const question = { meetingId: MEETING, messageId: QUESTION, text: 'When does the beta ship?' };

describe('LlmStreams', () => {
  it("maps a notes run's events to the shared events and ends with the saved note", async () => {
    const { streams, call, lines } = harness();
    const page = fakeWindow(1);
    const end = streams.streamNotes(notesRequest(), page.window);

    const api = await call(0);
    expect(api.url).toBe(`http://api.test/v1/meetings/${MEETING}/notes/generate`);
    expect(api.body).toEqual({
      run_id: RUN,
      template_id: 'standup',
      user_notes_version: 4,
      ai_base_version: 2,
    });
    api.open();
    api.send('run', { run_id: RUN, model: 'test-model', template_id: 'standup', line_count: 120 });
    api.send('section', { index: 0, heading: 'Decisions' });
    api.send('item', {
      section: 0,
      text: 'Beta ships Friday',
      citations: [citationWire],
      support: 'ok',
    });
    // An event this build does not know (a newer API) is skipped, not a broken stream.
    api.send('progress', { percent: 50 });
    api.send('from_notes', { text: 'Ask about pricing' });
    api.send('dropped', { text: 'Revenue doubled', reason: 'no_refs' });
    api.send('done', { run_id: RUN, note: noteWire });

    await expect(end).resolves.toEqual({ kind: 'done', result: note });
    const message = (event: unknown): NotesStreamMessage =>
      ({ meetingId: MEETING, runId: RUN, event }) as NotesStreamMessage;
    expect(page.sent.every((s) => s.channel === notesChannels.NotesEvent)).toBe(true);
    expect(page.on(notesChannels.NotesEvent)).toEqual([
      message({
        type: 'run',
        runId: RUN,
        model: 'test-model',
        templateId: 'standup',
        lineCount: 120,
      }),
      message({ type: 'section', index: 0, heading: 'Decisions' }),
      message({
        type: 'item',
        section: 0,
        text: 'Beta ships Friday',
        citations: [citation],
        support: 'ok',
      }),
      message({ type: 'from_notes', text: 'Ask about pricing' }),
      message({ type: 'dropped', text: 'Revenue doubled', reason: 'no_refs' }),
      message({ type: 'done', runId: RUN, note }),
    ]);
    expect(lines.join('\n')).toContain('"event":"progress"');
  });

  it('maps a chat answer, learning its run id from the run event', async () => {
    const { streams, call } = harness();
    const page = fakeWindow(1);
    const end = streams.streamChat(question, page.window);

    const api = await call(0);
    expect(api.url).toBe(`http://api.test/v1/meetings/${MEETING}/chat`);
    expect(api.body).toEqual({ message_id: QUESTION, text: 'When does the beta ship?' });
    api.open();
    api.send('run', { run_id: CHAT_RUN, model: 'test-model' });
    api.send('delta', { text: 'Beta ships Friday ' });
    api.send('citation', citationWire);
    api.send('done', { message: answerWire });

    await expect(end).resolves.toEqual({ kind: 'done', result: answer });
    const message = (event: unknown): ChatStreamMessage =>
      ({ meetingId: MEETING, messageId: QUESTION, event }) as ChatStreamMessage;
    expect(page.on(chatChannels.ChatEvent)).toEqual([
      message({ type: 'run', runId: CHAT_RUN, model: 'test-model' }),
      message({ type: 'delta', text: 'Beta ships Friday ' }),
      message({ type: 'citation', ...citation }),
      message({ type: 'done', message: answer }),
    ]);
  });

  it('forwards events in order to the requesting window only', async () => {
    const { streams, call } = harness();
    const first = fakeWindow(1);
    const second = fakeWindow(2);
    const notes = streams.streamNotes(notesRequest(), first.window);
    const chat = streams.streamChat({ ...question, meetingId: OTHER_MEETING }, second.window);
    const notesApi = await call(0);
    const chatApi = await call(1);
    notesApi.open();
    chatApi.open();

    // Interleaved on the wire; each page sees its own stream, in its own order.
    notesApi.send('section', { index: 0, heading: 'Decisions' });
    chatApi.send('delta', { text: 'one ' });
    notesApi.send('section', { index: 1, heading: 'Action items' });
    chatApi.send('delta', { text: 'two ' });
    chatApi.send('delta', { text: 'three' });
    notesApi.send('error', { code: 'cut_off', message: 'The notes were cut off.' });
    chatApi.send('error', { code: 'llm_provider_error', message: 'The model failed.' });
    await Promise.all([notes, chat]);

    expect(first.sent.map((s) => s.channel)).toEqual(Array(3).fill(notesChannels.NotesEvent));
    expect(first.on(notesChannels.NotesEvent).map((m) => (m as NotesStreamMessage).event)).toEqual([
      { type: 'section', index: 0, heading: 'Decisions' },
      { type: 'section', index: 1, heading: 'Action items' },
      { type: 'error', code: 'cut_off', message: 'The notes were cut off.' },
    ]);
    expect(second.sent.map((s) => s.channel)).toEqual(Array(4).fill(chatChannels.ChatEvent));
    expect(second.on(chatChannels.ChatEvent)).toEqual(
      [
        { type: 'delta', text: 'one ' },
        { type: 'delta', text: 'two ' },
        { type: 'delta', text: 'three' },
        { type: 'error', code: 'llm_provider_error', message: 'The model failed.' },
      ].map((event) => ({ meetingId: OTHER_MEETING, messageId: QUESTION, event })),
    );
    await expect(notes).resolves.toEqual({
      kind: 'error',
      code: 'cut_off',
      message: 'The notes were cut off.',
      status: null,
    });
  });

  it('a refusal before the stream is an error event with the envelope code', async () => {
    const { streams, call } = harness();
    const page = fakeWindow(1);
    const refused = streams.streamNotes(notesRequest(), page.window);
    (await call(0)).refuse(409, 'conflict', 'Another notes run is running');

    await expect(refused).resolves.toEqual({
      kind: 'error',
      code: 'conflict',
      message: 'Another notes run is running',
      status: 409,
    });
    expect(page.on(notesChannels.NotesEvent)).toEqual([
      {
        meetingId: MEETING,
        runId: RUN,
        event: { type: 'error', code: 'conflict', message: 'Another notes run is running' },
      },
    ]);

    // Done or refused, the meeting's slot is free again.
    const chat = streams.streamChat(question, page.window);
    (await call(1)).refuse(422, 'meeting_too_long', 'The meeting is too long to chat with');
    await expect(chat).resolves.toMatchObject({ kind: 'error', code: 'meeting_too_long' });
    const again = streams.streamNotes(notesRequest(), page.window);
    (await call(2)).refuse(422, 'empty_meeting', 'Nothing to write notes from');
    await expect(again).resolves.toMatchObject({ kind: 'error', status: 422 });
  });

  it('cancel aborts the fetch and asks the API to cancel the run', async () => {
    const { streams, call, cancelRun } = harness();
    const page = fakeWindow(1);
    const end = streams.streamNotes(notesRequest(), page.window);
    const api = await call(0);
    api.open();
    api.send('section', { index: 0, heading: 'Decisions' });
    await vi.waitFor(() => {
      expect(page.sent).toHaveLength(1);
    });

    await expect(streams.cancelNotes(MEETING)).resolves.toBe(true);
    expect(api.signal.aborted).toBe(true);
    expect(cancelRun).toHaveBeenCalledExactlyOnceWith(MEETING, RUN);
    await expect(end).resolves.toEqual({
      kind: 'error',
      code: 'cancelled',
      message: 'Notes generation was cancelled.',
      status: null,
    });
    expect(page.on(notesChannels.NotesEvent).map((m) => (m as NotesStreamMessage).event)).toEqual([
      { type: 'section', index: 0, heading: 'Decisions' },
      { type: 'error', code: 'cancelled', message: 'Notes generation was cancelled.' },
    ]);
    // Nothing is left to cancel.
    await expect(streams.cancelNotes(MEETING)).resolves.toBe(false);
    await expect(streams.cancelChat({ meetingId: MEETING, messageId: QUESTION })).resolves.toBe(
      false,
    );
  });

  it('cancel waits until the API holds the run, so the cancel cannot arrive before the run', async () => {
    const { streams, call, cancelRun } = harness();
    const page = fakeWindow(1);

    // A notes run is claimed before the API answers: until then a cancel would be a 404, and the
    // run would then start and be paid for.
    const notes = streams.streamNotes(notesRequest(), page.window);
    const notesApi = await call(0);
    const notesCancel = streams.cancelNotes(MEETING);
    expect(page.on(notesChannels.NotesEvent)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelRun).not.toHaveBeenCalled();
    expect(notesApi.signal.aborted).toBe(false);
    notesApi.open();
    await expect(notesCancel).resolves.toBe(true);
    expect(cancelRun).toHaveBeenCalledExactlyOnceWith(MEETING, RUN);
    expect(notesApi.signal.aborted).toBe(true);
    await expect(notes).resolves.toMatchObject({ kind: 'error', code: 'cancelled' });

    // A chat answer's run id comes in its first event; events read meanwhile are not forwarded.
    const chat = streams.streamChat(question, page.window);
    const chatApi = await call(1);
    chatApi.open();
    const chatCancel = streams.cancelChat({ meetingId: MEETING, messageId: QUESTION });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelRun).toHaveBeenCalledTimes(1);
    chatApi.send('run', { run_id: CHAT_RUN, model: 'test-model' });
    await expect(chatCancel).resolves.toBe(true);
    expect(cancelRun).toHaveBeenLastCalledWith(MEETING, CHAT_RUN);
    await expect(chat).resolves.toMatchObject({ kind: 'error', code: 'cancelled' });
    expect(page.on(chatChannels.ChatEvent)).toEqual([
      {
        meetingId: MEETING,
        messageId: QUESTION,
        event: { type: 'error', code: 'cancelled', message: 'The answer was cancelled.' },
      },
    ]);

    // A stream that ends before the API named its run leaves nothing to cancel.
    const refused = streams.streamChat({ ...question, messageId: ANSWER }, page.window);
    const refusedApi = await call(2);
    const refusedCancel = streams.cancelChat({ meetingId: MEETING, messageId: ANSWER });
    refusedApi.refuse(409, 'conflict', 'Message stored under another meeting');
    await expect(refusedCancel).resolves.toBe(true);
    await expect(refused).resolves.toMatchObject({ kind: 'error', code: 'cancelled' });
    expect(cancelRun).toHaveBeenCalledTimes(2);
  });

  it('closing the window aborts its streams', async () => {
    const { streams, call, cancelRun } = harness();
    const closing = fakeWindow(1);
    const staying = fakeWindow(2);
    const notes = streams.streamNotes(notesRequest(), closing.window);
    const chat = streams.streamChat(question, closing.window);
    const other = streams.streamChat(
      { ...question, meetingId: OTHER_MEETING, messageId: ANSWER },
      staying.window,
    );
    const [notesApi, chatApi, otherApi] = [await call(0), await call(1), await call(2)];
    notesApi.open();
    chatApi.open();
    otherApi.open();
    chatApi.send('run', { run_id: CHAT_RUN, model: 'test-model' });
    await vi.waitFor(() => {
      expect(closing.sent).toHaveLength(1);
    });

    closing.close();
    // The runs go on in the API, which saves what they write: the callers poll them.
    await expect(notes).resolves.toEqual({ kind: 'dropped', runId: RUN, cause: 'window_closed' });
    await expect(chat).resolves.toEqual({
      kind: 'dropped',
      runId: CHAT_RUN,
      cause: 'window_closed',
    });
    expect(notesApi.signal.aborted).toBe(true);
    expect(chatApi.signal.aborted).toBe(true);
    expect(cancelRun).not.toHaveBeenCalled();
    expect(closing.sent).toHaveLength(1);

    expect(otherApi.signal.aborted).toBe(false);
    otherApi.send('done', { message: answerWire });
    await expect(other).resolves.toMatchObject({ kind: 'done' });
    expect(staying.sent).toHaveLength(1);
  });

  it('a stream that ends with no done or error is reported as dropped with its run id', async () => {
    const { streams, call, lines } = harness();
    const notes = streams.streamNotes(notesRequest(), null);
    const notesApi = await call(0);
    notesApi.open();
    notesApi.send('section', { index: 0, heading: 'Decisions' });
    notesApi.end();
    await expect(notes).resolves.toEqual({ kind: 'dropped', runId: RUN, cause: 'stream_ended' });

    const page = fakeWindow(1);
    const chat = streams.streamChat(question, page.window);
    const chatApi = await call(1);
    chatApi.open();
    chatApi.send('run', { run_id: CHAT_RUN, model: 'test-model' });
    chatApi.send('delta', { text: 'Beta' });
    // A broken stream discards bytes not read yet (the Streams spec), so break it once both are.
    await vi.waitFor(() => {
      expect(page.sent).toHaveLength(2);
    });
    chatApi.fail();
    await expect(chat).resolves.toEqual({
      kind: 'dropped',
      runId: CHAT_RUN,
      cause: 'network_error',
    });

    // Dropped before the API named the run: the caller reloads the thread instead.
    const early = streams.streamChat(question, null);
    const earlyApi = await call(2);
    earlyApi.open();
    earlyApi.end();
    await expect(early).resolves.toEqual({ kind: 'dropped', runId: null, cause: 'stream_ended' });

    const ended = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(ended.filter((entry) => entry.message === 'llm stream dropped')).toHaveLength(3);
  });

  it('an event that breaks the contract drops the stream and never logs its text', async () => {
    const { streams, call, lines } = harness();
    const page = fakeWindow(1);
    const end = streams.streamNotes(notesRequest(), page.window);
    const api = await call(0);
    api.open();
    api.send('section', { index: 0, heading: 'Decisions' });
    api.send('item', {
      section: 0,
      text: 'Acme pays 50k for the pilot',
      citations: [{ ref: 'L12', start_ms: 1 }],
      support: 'ok',
    });

    await expect(end).resolves.toEqual({ kind: 'dropped', runId: RUN, cause: 'invalid_event' });
    expect(api.signal.aborted).toBe(true);
    expect(page.sent).toHaveLength(1);
    const log = lines.join('\n');
    expect(log).toContain('citations[0].segment_id');
    expect(log).not.toContain('Acme');

    // A saved doc that is not a doc the editor may load (a __proto__ key, GHSA-cp6q-959q-f8rh).
    const poisoned = streams.streamNotes(notesRequest(), page.window);
    const poisonedApi = await call(1);
    poisonedApi.open();
    poisonedApi.send('done', {
      run_id: RUN,
      note: {
        ...noteWire,
        doc: JSON.parse('{"type":"doc","attrs":{"__proto__":{"x":1}}}') as unknown,
      },
    });
    await expect(poisoned).resolves.toMatchObject({ kind: 'dropped', cause: 'invalid_event' });
    expect(lines.join('\n')).toContain('holds a \\"__proto__\\" key');
  });

  it('refuses a second notes stream for a meeting while one is open', async () => {
    const { streams, api: server, call } = harness();
    const first = streams.streamNotes(notesRequest(), null);
    // The API allows one running notes run per meeting; a second request would only be a 409.
    await expect(streams.streamNotes(notesRequest({ runId: CHAT_RUN }), null)).rejects.toThrow(
      `a notes stream for meeting ${MEETING} is already open`,
    );
    const api = await call(0);
    expect(server.calls).toHaveLength(1);
    api.open();
    api.send('error', { code: 'internal_error', message: 'Something failed' });
    await expect(first).resolves.toMatchObject({ kind: 'error', code: 'internal_error' });
  });
});
