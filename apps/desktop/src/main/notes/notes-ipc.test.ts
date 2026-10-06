import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chatChannels,
  type ChatAnswerRequest,
  type SendChatMessageRequest,
} from '../../shared/ipc/chat';
import { notesChannels, type PendingGenerateChange } from '../../shared/ipc/notes';
import type {
  ChatMessage,
  ChatThread,
  LlmRun,
  LlmRunStatus,
  LocalNote,
  Note,
  NoteDoc,
  PendingGenerateState,
} from '../../shared/notes';
import { ApiError } from '../api/http';
import type { NotesSyncApi, ServerNotes } from '../api/notesClient';
import type { IpcMainLike, SenderEvent } from '../ipc/trust';
import { createLogger } from '../logger';
import type { StreamEnd, StreamWindow } from './LlmStreams';
import {
  CHAT_RUN_POLL_LIMIT_MS,
  registerNotesIpc,
  type NotesIpcDeps,
  type NotesWindow,
} from './notes-ipc';
import { NotesSync } from './NotesSync';
import { SqliteNotesStore } from './SqliteNotesStore';

const MAIN_PAGE = 7;
const PROMPT_PANEL = 9;
const MEETING = '0b8e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const RUN = '7f3c9d1e-2a4b-4c6d-8e0f-1a2b3c4d5e6f';
const MESSAGE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REQUEST = '00000000-0000-4000-8000-000000000001';

type Handler = (event: SenderEvent, payload: unknown) => unknown;
type Listener = (event: SenderEvent, payload: unknown) => void;

function paragraphs(...lines: string[]): NoteDoc {
  return {
    type: 'doc',
    content: lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
  };
}

function serverNote(version: number, doc: NoteDoc): Note {
  return {
    kind: 'user',
    doc,
    version,
    templateId: null,
    lastRunId: null,
    generatedVersion: null,
    updatedAt: '2026-10-06T09:00:00Z',
  };
}

function chatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: MESSAGE,
    role: 'user',
    text: 'What did we agree on pricing?',
    citations: [],
    replyTo: null,
    runId: null,
    status: 'complete',
    createdAt: '2026-10-06T10:00:00Z',
    ...overrides,
  };
}

function run(status: LlmRunStatus): LlmRun {
  return {
    id: RUN,
    meetingId: MEETING,
    kind: 'chat',
    status,
    model: 'fake',
    templateId: null,
    errorCode: null,
    error: null,
    dropped: [],
    flaggedCount: 0,
    fromNotesCount: 0,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    costUsd: null,
    startedAt: '2026-10-06T10:00:00Z',
    finishedAt: null,
    outputDoc: null,
    replacedDoc: null,
  };
}

/** A page's webContents as LlmStreams and the events need it. */
function contents(id: number) {
  const sent: { channel: string; payload: unknown }[] = [];
  const webContents: StreamWindow = {
    id,
    isDestroyed: () => false,
    send: (channel, payload) => {
      sent.push({ channel, payload });
    },
    once: () => undefined,
  };
  return { webContents, sent };
}

/** The chat stream's end, which the test settles. */
function deferredEnd() {
  let settle!: (end: StreamEnd<ChatMessage>) => void;
  const promise = new Promise<StreamEnd<ChatMessage>>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

class FakeServer implements NotesSyncApi {
  notes: ServerNotes = { user: null, ai: null };
  down = false;
  getNotes(): Promise<ServerNotes> {
    if (this.down) {
      return Promise.reject(new ApiError(0, 'network_error', 'GET /v1/meetings/x/notes failed'));
    }
    return Promise.resolve(this.notes);
  }
  putNote(): Promise<Note> {
    return Promise.reject(new Error('no PUT expected: the sync is not started'));
  }
}

function harness() {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Listener>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    on: (channel, listener) => {
      listeners.set(channel, listener);
    },
  };
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) });
  const page = contents(MAIN_PAGE);
  const window: NotesWindow = { isDestroyed: () => false, webContents: page.webContents };

  const store = new SqliteNotesStore(':memory:');
  const server = new FakeServer();
  const sync = new NotesSync({
    store,
    api: server,
    meetings: { remoteState: () => 'created', onChange: () => () => undefined },
    onMeetingMissing: () => undefined,
    logger,
  });
  const calls: string[] = [];
  const pendingListeners = new Set<(change: PendingGenerateChange) => void>();
  const pending: PendingGenerateState = {
    meetingId: MEETING,
    runId: RUN,
    templateId: 'standup',
    reason: 'button',
    createdAt: '2026-10-06T10:00:00Z',
    status: { phase: 'running' },
  };
  const generator: NotesIpcDeps['generator'] = {
    generate: (meetingId, templateId) => {
      calls.push(`generate ${meetingId} ${templateId}`);
      return pending;
    },
    cancel: (meetingId) => {
      calls.push(`cancel generate ${meetingId}`);
      return Promise.resolve();
    },
    getPending: (meetingId) => {
      calls.push(`get pending ${meetingId}`);
      return null;
    },
    onPendingChanged: (listener) => {
      pendingListeners.add(listener);
      return () => {
        pendingListeners.delete(listener);
      };
    },
  };
  const chatEnds: ReturnType<typeof deferredEnd>[] = [];
  const streams: NotesIpcDeps['streams'] = {
    streamChat: (request: SendChatMessageRequest, target: StreamWindow | null) => {
      calls.push(`stream chat ${request.messageId} to ${target?.id ?? 'nobody'}`);
      const end = deferredEnd();
      chatEnds.push(end);
      return end.promise;
    },
    cancelChat: (request: ChatAnswerRequest) => {
      calls.push(`cancel chat ${request.messageId}`);
      return Promise.resolve(true);
    },
  };
  const runStatuses: (LlmRunStatus | ApiError)[] = [];
  let thread: ChatThread = { meetingId: MEETING, messages: [chatMessage()] };
  const api: NotesIpcDeps['api'] = {
    listTemplates: () => {
      calls.push('list templates');
      return Promise.resolve([]);
    },
    getRun: (meetingId, runId) => {
      calls.push(`get run ${runId}`);
      const next = runStatuses.shift() ?? 'running';
      if (next instanceof ApiError) return Promise.reject(next);
      return Promise.resolve({ ...run(next), meetingId });
    },
    getChatThread: (meetingId) => {
      calls.push(`get thread ${meetingId}`);
      return Promise.resolve(thread);
    },
  };
  const acks: string[] = [];
  const ipc = registerNotesIpc({
    ipcMain,
    getWindow: () => window,
    store,
    sync,
    generator,
    streams,
    api,
    flush: {
      ack: ({ requestId }) => {
        acks.push(requestId);
      },
    },
    logger,
  });

  /** Like ipcRenderer.invoke: a handler that throws rejects the page's promise. */
  const invoke = (channel: string, senderId: number, payload?: unknown): Promise<unknown> =>
    Promise.resolve().then(() => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`nothing registered on ${channel}`);
      return handler({ sender: { id: senderId } }, payload);
    });
  const send = (channel: string, senderId: number, payload: unknown): void => {
    const listener = listeners.get(channel);
    if (!listener) throw new Error(`nothing listens on ${channel}`);
    listener({ sender: { id: senderId } }, payload);
  };

  return {
    handlers,
    listeners,
    invoke,
    send,
    store,
    server,
    ipc,
    calls,
    acks,
    chatEnds,
    runStatuses,
    setThread: (next: ChatThread) => {
      thread = next;
    },
    pendingChanged: (change: PendingGenerateChange) => {
      for (const listener of pendingListeners) listener(change);
    },
    sentOn: (channel: string) =>
      page.sent.filter((message) => message.channel === channel).map((m) => m.payload),
    logged: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    rawLog: () => lines.join('\n'),
  };
}

const INVOKE_CHANNELS = [
  notesChannels.NotesGet,
  notesChannels.NotesSave,
  notesChannels.NotesResolveConflict,
  notesChannels.NotesListTemplates,
  notesChannels.NotesGenerate,
  notesChannels.NotesCancelGenerate,
  notesChannels.NotesGetPendingGenerate,
  notesChannels.NotesGetRun,
  chatChannels.ChatGetThread,
  chatChannels.ChatSend,
  chatChannels.ChatCancel,
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the notes and chat IPC', () => {
  it('registers every request channel of the page, and listens for the flush ack', () => {
    const h = harness();
    expect([...h.handlers.keys()].sort()).toEqual([...INVOKE_CHANNELS].sort());
    expect([...h.listeners.keys()]).toEqual([notesChannels.NotesFlushAck]);
  });

  it('ignores untrusted senders', async () => {
    const h = harness();
    const payloads: Record<string, unknown> = {
      [notesChannels.NotesSave]: {
        meetingId: MEETING,
        kind: 'user',
        doc: paragraphs('x'),
        base: null,
      },
      [chatChannels.ChatSend]: { meetingId: MEETING, messageId: MESSAGE, text: 'Why?' },
    };
    for (const channel of INVOKE_CHANNELS) {
      await expect(
        h.invoke(channel, PROMPT_PANEL, payloads[channel] ?? MEETING),
        channel,
      ).rejects.toThrow('untrusted sender');
    }
    h.send(notesChannels.NotesFlushAck, PROMPT_PANEL, { requestId: REQUEST });

    expect(h.calls).toEqual([]);
    expect(h.acks).toEqual([]);
    expect(h.store.getNotes(MEETING)).toEqual({ meetingId: MEETING, user: null, ai: null });
    expect(
      h.logged().filter((l) => l.message === 'ipc message from unexpected sender ignored'),
    ).toHaveLength(INVOKE_CHANNELS.length + 1);
  });

  it('refuses a payload it cannot read, naming the rule and never the text', async () => {
    const h = harness();
    await expect(
      h.invoke(notesChannels.NotesSave, MAIN_PAGE, {
        meetingId: MEETING,
        kind: 'draft',
        doc: paragraphs('Pricing for Acme is 40k'),
        base: null,
      }),
    ).rejects.toThrow('notes:save refused: kind is not user or ai');
    await expect(
      h.invoke(chatChannels.ChatSend, MAIN_PAGE, {
        meetingId: MEETING,
        messageId: MESSAGE,
        text: 'a'.repeat(4001),
      }),
    ).rejects.toThrow('chat:send refused: text is not 1 to 4000 characters');
    h.send(notesChannels.NotesFlushAck, MAIN_PAGE, { requestId: 'not an id' });
    expect(h.acks).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(h.rawLog()).not.toContain('Acme');
    expect(h.logged()).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'notes request refused',
        channel: 'notes:save',
      }),
    );
  });

  it('saves on the base the page sent, and tells the page every stored change', async () => {
    const h = harness();
    const loaded = h.store.applyServerNote(MEETING, serverNote(2, paragraphs('Agenda')));
    h.store.applyServerNote(MEETING, serverNote(3, paragraphs('Theirs')));

    const kept = (await h.invoke(notesChannels.NotesSave, MAIN_PAGE, {
      meetingId: MEETING,
      kind: 'user',
      doc: paragraphs('Agenda', 'typed'),
      base: { revisionId: loaded.revisionId, version: loaded.baseVersion },
    })) as LocalNote;

    // Built on version 2, which version 3 replaced: kept aside, the server's doc stays.
    expect(kept).toMatchObject({
      doc: paragraphs('Theirs'),
      conflictCopy: paragraphs('Agenda', 'typed'),
      sync: 'conflict',
    });
    const changes = h.sentOn(notesChannels.NotesChanged) as LocalNote[];
    expect(changes.map((note) => note.doc)).toEqual([
      paragraphs('Agenda'),
      paragraphs('Theirs'),
      paragraphs('Theirs'),
    ]);
    expect(changes.at(-1)).toEqual(kept);
    const mine = (await h.invoke(notesChannels.NotesResolveConflict, MAIN_PAGE, {
      meetingId: MEETING,
      kind: 'user',
      keep: 'mine',
    })) as LocalNote;
    expect(mine).toMatchObject({ doc: paragraphs('Agenda', 'typed'), conflictCopy: null });
    expect(h.sentOn(notesChannels.NotesChanged).at(-1)).toEqual(mine);
  });

  it("answers notes:get from notes.sqlite, then takes the server's notes", async () => {
    const h = harness();
    h.server.notes = { user: serverNote(1, paragraphs('From the server')), ai: null };

    const first = await h.invoke(notesChannels.NotesGet, MAIN_PAGE, MEETING);
    expect(first).toEqual({ meetingId: MEETING, user: null, ai: null });
    await vi.advanceTimersByTimeAsync(0);

    expect(h.store.getNote(MEETING, 'user')?.doc).toEqual(paragraphs('From the server'));
    expect((h.sentOn(notesChannels.NotesChanged) as LocalNote[]).map((n) => n.doc)).toEqual([
      paragraphs('From the server'),
    ]);
  });

  it('keeps answering notes:get while the API is away, and says why it did not pull', async () => {
    const h = harness();
    h.server.down = true;
    await expect(h.invoke(notesChannels.NotesGet, MAIN_PAGE, MEETING)).resolves.toEqual({
      meetingId: MEETING,
      user: null,
      ai: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.logged()).toContainEqual(
      expect.objectContaining({
        message: 'server notes not loaded',
        meetingId: MEETING,
        code: 'network_error',
      }),
    );
  });

  it('passes generate, cancel and the pending generate through, and tells the page each change', async () => {
    const h = harness();
    await h.invoke(notesChannels.NotesGenerate, MAIN_PAGE, {
      meetingId: MEETING,
      templateId: 'standup',
    });
    await h.invoke(notesChannels.NotesGetPendingGenerate, MAIN_PAGE, MEETING);
    await h.invoke(notesChannels.NotesCancelGenerate, MAIN_PAGE, MEETING);
    h.pendingChanged({ meetingId: MEETING, pending: null });

    expect(h.calls).toEqual([
      `generate ${MEETING} standup`,
      `get pending ${MEETING}`,
      `cancel generate ${MEETING}`,
    ]);
    expect(h.sentOn(notesChannels.NotesPendingGenerateChanged)).toEqual([
      { meetingId: MEETING, pending: null },
    ]);
  });

  it("hands a page's flush ack to the quit guard", () => {
    const h = harness();
    h.send(notesChannels.NotesFlushAck, MAIN_PAGE, { requestId: REQUEST, extra: 1 });
    expect(h.acks).toEqual([REQUEST]);
  });

  it('a dropped chat stream polls its run and reloads the thread', async () => {
    const h = harness();
    await h.invoke(chatChannels.ChatSend, MAIN_PAGE, {
      meetingId: MEETING,
      messageId: MESSAGE,
      text: 'What did we agree on pricing?',
    });
    expect(h.calls).toEqual([`stream chat ${MESSAGE} to ${MAIN_PAGE}`]);
    h.runStatuses.push('running', 'running', 'succeeded');
    const answered: ChatThread = {
      meetingId: MEETING,
      messages: [
        chatMessage(),
        chatMessage({
          id: RUN,
          role: 'assistant',
          text: 'Forty thousand.',
          replyTo: MESSAGE,
          runId: RUN,
        }),
      ],
    };
    h.setThread(answered);

    h.chatEnds[0]?.settle({ kind: 'dropped', runId: RUN, cause: 'network_error' });
    await vi.advanceTimersByTimeAsync(0);
    // Read every 2 s: the run is still answering, then it has finished.
    expect(h.calls.filter((call) => call.startsWith('get run'))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.calls.filter((call) => call.startsWith('get run'))).toHaveLength(2);
    expect(h.sentOn(chatChannels.ChatThreadChanged)).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.calls.slice(1)).toEqual([
      `get run ${RUN}`,
      `get run ${RUN}`,
      `get run ${RUN}`,
      `get thread ${MEETING}`,
    ]);
    expect(h.sentOn(chatChannels.ChatThreadChanged)).toEqual([answered]);
  });

  it('a cancel the API did not confirm is followed like any lost stream', async () => {
    const h = harness();
    await h.invoke(chatChannels.ChatSend, MAIN_PAGE, {
      meetingId: MEETING,
      messageId: MESSAGE,
      text: 'Why?',
    });
    await h.invoke(chatChannels.ChatCancel, MAIN_PAGE, { meetingId: MEETING, messageId: MESSAGE });
    h.runStatuses.push('succeeded');
    // The run beat the cancel and saved its answer: the page, told `cancelled`, gets the thread.
    h.chatEnds[0]?.settle({ kind: 'dropped', runId: RUN, cause: 'cancel_unconfirmed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual([
      `stream chat ${MESSAGE} to ${MAIN_PAGE}`,
      `cancel chat ${MESSAGE}`,
      `get run ${RUN}`,
      `get thread ${MEETING}`,
    ]);
    expect(h.sentOn(chatChannels.ChatThreadChanged)).toHaveLength(1);
  });

  it('a lost answer whose run was never named reloads the thread at once', async () => {
    const h = harness();
    await h.invoke(chatChannels.ChatSend, MAIN_PAGE, {
      meetingId: MEETING,
      messageId: MESSAGE,
      text: 'Why?',
    });
    h.chatEnds[0]?.settle({ kind: 'dropped', runId: null, cause: 'invalid_event' });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls.slice(1)).toEqual([`get thread ${MEETING}`]);
  });

  it('polls a run the API cannot be reached for until it can, and stops at the limit', async () => {
    const h = harness();
    await h.invoke(chatChannels.ChatSend, MAIN_PAGE, {
      meetingId: MEETING,
      messageId: MESSAGE,
      text: 'Why?',
    });
    h.runStatuses.push(new ApiError(0, 'network_error', 'GET run failed'));
    h.chatEnds[0]?.settle({ kind: 'dropped', runId: RUN, cause: 'stream_ended' });
    // Every later read answers `running`: past the limit the thread is read as it stands.
    await vi.advanceTimersByTimeAsync(CHAT_RUN_POLL_LIMIT_MS + 5_000);
    const reads = h.calls.filter((call) => call.startsWith('get run'));
    // 2 s for the first 10 s, then 5 s: 5 + 22 reads in 2 minutes.
    expect(reads.length).toBeGreaterThanOrEqual(25);
    expect(reads.length).toBeLessThanOrEqual(28);
    expect(h.calls.at(-1)).toBe(`get thread ${MEETING}`);
    expect(h.logged()).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'chat run still running when its poll stopped',
      }),
    );
  });

  it('a done or error end needs no reload', async () => {
    const h = harness();
    for (const [index, end] of [
      { kind: 'done', result: chatMessage({ role: 'assistant' }) },
      { kind: 'error', code: 'meeting_too_long', message: 'Too long', status: 422 },
    ].entries()) {
      const messageId = `${MESSAGE.slice(0, -1)}${index}`;
      await h.invoke(chatChannels.ChatSend, MAIN_PAGE, {
        meetingId: MEETING,
        messageId,
        text: 'Why?',
      });
      h.chatEnds[index]?.settle(end as StreamEnd<ChatMessage>);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls.filter((call) => !call.startsWith('stream chat'))).toEqual([]);
  });

  it('refuses a second send of a question whose answer is still coming', async () => {
    const h = harness();
    const question = { meetingId: MEETING, messageId: MESSAGE, text: 'Why?' };
    await h.invoke(chatChannels.ChatSend, MAIN_PAGE, question);
    await expect(h.invoke(chatChannels.ChatSend, MAIN_PAGE, question)).rejects.toThrow(
      `the answer to message ${MESSAGE} is already on its way`,
    );
    // Once it ended, a retry with the same id is sent again (the API answers it from its store).
    h.chatEnds[0]?.settle({ kind: 'done', result: chatMessage({ role: 'assistant' }) });
    await vi.advanceTimersByTimeAsync(0);
    await h.invoke(chatChannels.ChatSend, MAIN_PAGE, question);
    expect(h.calls.filter((call) => call.startsWith('stream chat'))).toHaveLength(2);
  });

  it('stop ends a poll, and nothing is read or sent after it', async () => {
    const h = harness();
    await h.invoke(chatChannels.ChatSend, MAIN_PAGE, {
      meetingId: MEETING,
      messageId: MESSAGE,
      text: 'Why?',
    });
    h.chatEnds[0]?.settle({ kind: 'dropped', runId: RUN, cause: 'network_error' });
    await vi.advanceTimersByTimeAsync(0);
    const before = h.calls.length;

    h.ipc.stop();
    // No poll timer outlives the quit.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(CHAT_RUN_POLL_LIMIT_MS);
    h.store.applyServerNote(MEETING, serverNote(1, paragraphs('After quit')));

    expect(h.calls).toHaveLength(before);
    expect(h.sentOn(chatChannels.ChatThreadChanged)).toEqual([]);
    expect(h.sentOn(notesChannels.NotesChanged)).toEqual([]);
  });
});
