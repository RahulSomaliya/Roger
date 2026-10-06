import {
  chatChannels,
  type ChatAnswerRequest,
  type ChatStreamMessage,
  type SendChatMessageRequest,
} from '../../shared/ipc/chat';
import { notesChannels, type NotesStreamMessage } from '../../shared/ipc/notes';
import {
  isNoteDoc,
  noteDocProblem,
  type ChatMessage,
  type ChatStreamEvent,
  type LlmRun,
  type LlmRunStatus,
  type Note,
  type NotesStreamEvent,
  type RefCitation,
} from '../../shared/notes';
import { ApiError } from '../api/http';
import type { SseEvent } from '../api/sse';
import type { StreamRequest } from '../api/streamRequest';
import type { LogFields, Logger } from '../logger';

/**
 * The notes and chat streams main holds open to the API (M4 "Streaming"): one per notes run, one
 * per chat answer, each tied to the window that asked, after openwhispr's stream registry
 * (`src/helpers/agentStreamRequestRegistry.js`). It maps the API's SSE events (snake_case,
 * docs/api-contract.md) to the shared stream events (src/shared/notes.ts) and sends them to that
 * window only: NotesStreamMessage on `notes:event`, ChatStreamMessage on `chat:event`. A refusal
 * before the stream reaches the page as an `error` event with the envelope's code.
 *
 * Every stream ends in one StreamEnd for its caller (NotesGenerator for notes, notes-ipc for
 * chat), which decides what follows. A `dropped` stream is not a failed run: the run goes on in
 * the API, which saves what it writes, so the caller polls `GET .../runs/{id}` and loads the
 * stored result (or, with no run id, the chat thread). Nothing here retries or polls.
 *
 * Event data is meeting content (note lines, answers, the user's question): logs carry event
 * names, ids, codes and the broken rule, never data. No Electron import, so this tests under Node.
 */

/** The parts of a window's webContents a stream needs. Electron's WebContents fits. */
export interface StreamWindow {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: 'destroyed', listener: () => void): unknown;
}

export interface LlmStreamsDeps {
  /** createStreamRequest (main/api/streamRequest.ts) on the app's API connection. */
  stream: StreamRequest;
  /**
   * `POST /v1/meetings/{id}/runs/{run_id}/cancel`, from the notes client (M4-T14). Answers the
   * run: its status says whether the cancel stopped it or the run had already finished.
   */
  cancelRun: (meetingId: string, runId: string) => Promise<Pick<LlmRun, 'status'>>;
  logger: Logger;
}

/** One notes run to stream: `POST /v1/meetings/{id}/notes/generate`. */
export interface NotesStreamRequest {
  meetingId: string;
  /**
   * The pending generate's run id, made before the first attempt. Re-sent, it attaches to the
   * running run or replays the finished one (M4 "Re-sent ids"), never a second paid run.
   */
  runId: string;
  templateId: string;
  /** The stored versions NotesSync flushed just before; 0 when that doc does not exist. */
  userNotesVersion: number;
  aiBaseVersion: number;
}

/**
 * Why a stream ended with no `done` or `error`. Not the `dropped` event of a notes run, which is
 * one AI line the API removed: this is the whole stream lost while its run goes on in the API.
 * - `window_closed`: the asking window closed, and main stopped reading on purpose.
 * - `cancel_unconfirmed`: this stream was cancelled, but the API did not say it stopped the run.
 *   Its answer names another status (the run finished first: a `succeeded` notes run saved its AI
 *   doc), or the cancel request failed and the run may still finish and save.
 */
export type StreamDropCause =
  'stream_ended' | 'network_error' | 'invalid_event' | 'window_closed' | 'cancel_unconfirmed';

/**
 * How a stream ended, once, for its caller.
 * - `done`: the stored result: the AI note (notes) or the answer (chat).
 * - `error`: the API's `error` event (`status` null), a refusal before the stream (`status` is
 *   the HTTP status, 0 for `network_error`), or this stream's cancel (`cancelled`, null), once
 *   the API answered that it stopped the run (or the stream ended before the API named one).
 * - `dropped`: see StreamDropCause. `runId` is null only for a chat answer whose `run` event
 *   never came.
 *
 * A cancelled stream can still end `done` or `dropped` (`cancel_unconfirmed`): the run beat the
 * cancel. The page was told `cancelled` at once, so the caller loads what the run saved (for
 * notes, `applyServerNote`), or notes.sqlite keeps an older AI doc than Postgres.
 */
export type StreamEnd<TDone> =
  | { kind: 'done'; result: TDone }
  | { kind: 'error'; code: string; message: string; status: number | null }
  | { kind: 'dropped'; runId: string | null; cause: StreamDropCause };

/** The `error` event, the same in both event unions. */
type StreamErrorEvent = Extract<NotesStreamEvent | ChatStreamEvent, { type: 'error' }>;

/** What one API event does to a stream. */
interface Step<TEvent, TDone> {
  /** What the page gets. */
  event: TEvent;
  /** The run the event names: a chat answer learns its run id from its `run` event. */
  runId?: string;
  /** Set by `done` and `error`: the stream is over. */
  end?: StreamEnd<TDone>;
}

type EventMap<TEvent, TDone> = ReadonlyMap<string, (data: Fields) => Step<TEvent, TDone>>;

/** One stream to open: where it goes, what it sends, and how its events are read and passed on. */
interface StreamSpec<TEvent, TDone> {
  name: 'notes' | 'chat';
  /** The registry key: one notes stream per meeting, one chat stream per question. */
  key: string;
  /** Names the stream in errors: `meeting <id>`, `message <id>`. */
  subject: string;
  meetingId: string;
  /** Known up front for notes; null for chat until the API's `run` event names it. */
  runId: string | null;
  path: string;
  body: unknown;
  events: EventMap<TEvent, TDone>;
  cancelledMessage: string;
  logFields: LogFields;
  send(window: StreamWindow, event: TEvent | StreamErrorEvent): void;
}

interface OpenStream {
  readonly meetingId: string;
  readonly window: StreamWindow | null;
  readonly abort: AbortController;
  readonly log: Logger;
  readonly cancelledMessage: string;
  runId: string | null;
  /** Why main stopped reading, or null while it reads. Nothing reaches the page once set. */
  stop: 'cancelled' | 'window_closed' | null;
  readonly runHeld: RunHeld;
  /**
   * The cancel under way: the API's cancel, sent once the API holds the run. Settles with the
   * run's status from the API's answer, or null when the stream ended before the API named a run.
   */
  cancelling: Promise<LlmRunStatus | null> | null;
  sendError(code: string, message: string): void;
}

export class LlmStreams {
  private readonly open = new Map<string, OpenStream>();
  private readonly watched = new WeakSet<StreamWindow>();

  constructor(private readonly deps: LlmStreamsDeps) {}

  /**
   * Streams a notes run to `window` (null: no page listens, the caller still gets the end).
   * Rejects while the meeting has a notes stream open: the API runs one notes run per meeting.
   */
  streamNotes(request: NotesStreamRequest, window: StreamWindow | null): Promise<StreamEnd<Note>> {
    const { meetingId, runId } = request;
    return this.run(
      {
        name: 'notes',
        key: `notes:${meetingId}`,
        subject: `meeting ${meetingId}`,
        meetingId,
        runId,
        path: `/v1/meetings/${encodeURIComponent(meetingId)}/notes/generate`,
        body: {
          run_id: runId,
          template_id: request.templateId,
          user_notes_version: request.userNotesVersion,
          ai_base_version: request.aiBaseVersion,
        },
        events: NOTES_EVENTS,
        cancelledMessage: 'Notes generation was cancelled.',
        logFields: { stream: 'notes', meetingId, runId },
        send: (target, event) => {
          const message: NotesStreamMessage = { meetingId, runId, event };
          target.send(notesChannels.NotesEvent, message);
        },
      },
      window,
    );
  }

  /** Streams the answer to one question to `window`. Rejects while that question has one open. */
  streamChat(
    request: SendChatMessageRequest,
    window: StreamWindow | null,
  ): Promise<StreamEnd<ChatMessage>> {
    const { meetingId, messageId } = request;
    return this.run(
      {
        name: 'chat',
        key: `chat:${messageId}`,
        subject: `message ${messageId}`,
        meetingId,
        runId: null,
        path: `/v1/meetings/${encodeURIComponent(meetingId)}/chat`,
        body: { message_id: messageId, text: request.text },
        events: CHAT_EVENTS,
        cancelledMessage: 'The answer was cancelled.',
        logFields: { stream: 'chat', meetingId, messageId },
        send: (target, event) => {
          const message: ChatStreamMessage = { meetingId, messageId, event };
          target.send(chatChannels.ChatEvent, message);
        },
      },
      window,
    );
  }

  /**
   * Cancels the meeting's notes stream: the page gets a `cancelled` error at once and the API is
   * asked to stop the run. The stream ends as `cancelled` only when the API's answer says it
   * stopped the run; otherwise as StreamEnd says. False when no stream is open. Settles when the
   * API answered the cancel, and rejects when that request failed.
   */
  cancelNotes(meetingId: string): Promise<boolean> {
    return this.cancel(this.open.get(`notes:${meetingId}`));
  }

  /** As cancelNotes, for the answer to one question. */
  cancelChat(request: ChatAnswerRequest): Promise<boolean> {
    const stream = this.open.get(`chat:${request.messageId}`);
    return this.cancel(stream?.meetingId === request.meetingId ? stream : undefined);
  }

  private async run<TEvent, TDone>(
    spec: StreamSpec<TEvent, TDone>,
    window: StreamWindow | null,
  ): Promise<StreamEnd<TDone>> {
    if (this.open.has(spec.key)) {
      throw new Error(`a ${spec.name} stream for ${spec.subject} is already open`);
    }
    const stream: OpenStream = {
      meetingId: spec.meetingId,
      window,
      abort: new AbortController(),
      log: this.deps.logger.child(spec.logFields),
      cancelledMessage: spec.cancelledMessage,
      runId: spec.runId,
      stop: null,
      runHeld: new RunHeld(),
      cancelling: null,
      sendError: (code, message) => {
        this.forward(stream, spec, { type: 'error', code, message });
      },
    };
    this.open.set(spec.key, stream);
    this.watch(window);
    stream.log.info('llm stream opening');
    try {
      const pumped = await this.pump(stream, spec);
      // The stream is over: a cancel still waiting for the run id learns there is none to send.
      stream.runHeld.resolve(null);
      const end = pumped === 'stopped' ? await this.stoppedEnd(stream) : pumped;
      logEnd(stream.log, end);
      return end;
    } finally {
      this.open.delete(spec.key);
      stream.runHeld.resolve(null);
    }
  }

  /** Reads the stream to its end; `stopped` when main stopped reading (stoppedEnd decides). */
  private async pump<TEvent, TDone>(
    stream: OpenStream,
    spec: StreamSpec<TEvent, TDone>,
  ): Promise<StreamEnd<TDone> | 'stopped'> {
    let events: AsyncIterable<SseEvent>;
    try {
      events = await this.deps.stream(spec.path, spec.body, stream.abort.signal);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (stream.stop !== null) return 'stopped';
      stream.sendError(error.code, error.message);
      return { kind: 'error', code: error.code, message: error.message, status: error.status };
    }
    // The API answers a notes run only after its claim committed (M4 "Where generation runs"):
    // from here a cancel finds the run.
    if (stream.runId !== null) stream.runHeld.resolve(stream.runId);
    try {
      for await (const sse of events) {
        const read = spec.events.get(sse.event);
        if (read === undefined) {
          stream.log.warn('llm stream event unknown, skipped', { event: sse.event });
          continue;
        }
        let step: Step<TEvent, TDone>;
        try {
          step = read(Fields.parse(sse.data));
        } catch (error) {
          if (!(error instanceof EventShapeError)) throw error;
          stream.log.error('llm stream event broke the contract', {
            event: sse.event,
            problem: error.message,
          });
          // Leaving the loop closes the connection. The run is fine in the API: the caller polls
          // it and loads what it stored, as after any lost stream.
          return stream.stop === null
            ? { kind: 'dropped', runId: stream.runId, cause: 'invalid_event' }
            : 'stopped';
        }
        if (step.runId !== undefined && stream.runId === null) {
          stream.runId = step.runId;
          stream.runHeld.resolve(step.runId);
        }
        this.forward(stream, spec, step.event);
        if (step.end === undefined) continue;
        // A `done` read after main stopped reading is still the run's saved result: the run beat
        // the cancel (a replayed chat answer has no `run` event, so nothing aborts it), and the
        // caller must apply it. Ending it as `cancelled` leaves notes.sqlite on an older AI doc.
        return stream.stop === null || step.end.kind === 'done' ? step.end : 'stopped';
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (stream.stop !== null) return 'stopped';
      stream.log.info('llm stream connection failed', { error: error.message });
      return { kind: 'dropped', runId: stream.runId, cause: 'network_error' };
    }
    return stream.stop === null
      ? { kind: 'dropped', runId: stream.runId, cause: 'stream_ended' }
      : 'stopped';
  }

  /**
   * The end of a stream main stopped reading. A closed window's run goes on in the API. A
   * cancelled one ends `cancelled` only once the API's answer says it stopped the run: a run that
   * finished first saved its output, and the abort threw its `done` away, so the caller must
   * load it (StreamEnd). Only `cancelled` confirms. `running` (the API answered before it marked
   * the run) ends `dropped` too, and the caller's poll reads the final status; the cancel route
   * (M4-T8) answers the run once it is marked, or every cancel costs that poll.
   */
  private async stoppedEnd(stream: OpenStream): Promise<StreamEnd<never>> {
    if (stream.cancelling === null) {
      return { kind: 'dropped', runId: stream.runId, cause: 'window_closed' };
    }
    let status: LlmRunStatus | null;
    try {
      status = await stream.cancelling;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      // cancel() hands this failure to its own caller; for the stream it means the run may go on.
      stream.log.warn('llm run cancel failed, the run may still finish', {
        code: error.code,
        status: error.status,
      });
      return { kind: 'dropped', runId: stream.runId, cause: 'cancel_unconfirmed' };
    }
    if (status === null || status === 'cancelled') {
      return { kind: 'error', code: 'cancelled', message: stream.cancelledMessage, status: null };
    }
    stream.log.warn('llm run ended before its cancel', { runStatus: status });
    return { kind: 'dropped', runId: stream.runId, cause: 'cancel_unconfirmed' };
  }

  /** Sends one event to the stream's window, unless main stopped reading or the page is gone. */
  private forward<TEvent>(
    stream: OpenStream,
    spec: StreamSpec<TEvent, unknown>,
    event: TEvent | StreamErrorEvent,
  ): void {
    const target = stream.window;
    if (stream.stop !== null || target === null || target.isDestroyed()) return;
    spec.send(target, event);
  }

  private async cancel(stream: OpenStream | undefined): Promise<boolean> {
    if (stream === undefined) return false;
    if (stream.cancelling === null) {
      if (stream.stop === null) stream.sendError('cancelled', stream.cancelledMessage);
      stream.stop = 'cancelled';
      stream.cancelling = this.cancelRun(stream);
    }
    await stream.cancelling;
    return true;
  }

  /**
   * Waits until the API holds the run before asking it to stop. Sent earlier, the cancel can
   * reach the API before the generate's claim: a 404, and the run then starts and is paid for.
   * A chat answer's run id arrives in its first event, so until then the stream is read on
   * without forwarding. Waiting is bounded by the stream's open timeout (streamRequest.ts).
   */
  private async cancelRun(stream: OpenStream): Promise<LlmRunStatus | null> {
    const runId = await stream.runHeld.promise;
    stream.abort.abort();
    if (runId === null) {
      stream.log.info('llm stream cancelled before the API named its run');
      return null;
    }
    const run = await this.deps.cancelRun(stream.meetingId, runId);
    stream.log.info('llm run cancel answered', { runId, runStatus: run.status });
    return run.status;
  }

  /**
   * A closed window's streams stop being read, and only that: their runs go on in the API and
   * save their output ("Closing the laptop mid-run must not throw away paid output"), and each
   * caller gets `dropped` to poll the run. Never cancel the run here.
   */
  private watch(window: StreamWindow | null): void {
    if (window === null || this.watched.has(window)) return;
    this.watched.add(window);
    window.once('destroyed', () => {
      for (const stream of this.open.values()) {
        if (stream.window !== window || stream.stop !== null) continue;
        stream.stop = 'window_closed';
        stream.abort.abort();
      }
    });
  }
}

function logEnd(log: Logger, end: StreamEnd<unknown>): void {
  if (end.kind === 'done') log.info('llm stream done');
  else if (end.kind === 'error') {
    log.info('llm stream ended with an error', { code: end.code, status: end.status });
  } else log.warn('llm stream dropped', { runId: end.runId, cause: end.cause });
}

/** Settles with the run id once the API holds the run, or null when the stream ended first. */
class RunHeld {
  private settle: (runId: string | null) => void = () => undefined;
  readonly promise = new Promise<string | null>((resolve) => {
    this.settle = resolve;
  });

  /** Only the first call counts, as with any promise. */
  resolve(runId: string | null): void {
    this.settle(runId);
  }
}

// The API's events ------------------------------------------------------------------------------

/** An event that breaks the contract. Its message names the field and the rule, never a value. */
class EventShapeError extends Error {}

/** One event's JSON object, read field by field; a missing or wrong field is an EventShapeError. */
class Fields {
  private constructor(
    private readonly data: Record<string, unknown>,
    private readonly path: string,
  ) {}

  static parse(json: string): Fields {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      // Not the SyntaxError's message: V8 quotes the text around the fault, meeting content.
      throw new EventShapeError('data is not JSON');
    }
    return Fields.of(value, 'data');
  }

  static of(value: unknown, path: string): Fields {
    if (!isRecord(value)) throw new EventShapeError(`${path} is not an object`);
    return new Fields(value, path);
  }

  raw(key: string): unknown {
    return this.data[key];
  }

  text(key: string): string {
    const value = this.data[key];
    if (typeof value !== 'string') this.fail(key, 'is not a string');
    return value;
  }

  nullableText(key: string): string | null {
    return this.data[key] === null ? null : this.text(key);
  }

  /** A non-negative integer: an index, a count, a version, milliseconds. */
  count(key: string): number {
    const value = this.data[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      this.fail(key, 'is not a count');
    }
    return value;
  }

  nullableCount(key: string): number | null {
    return this.data[key] === null ? null : this.count(key);
  }

  oneOf<T extends string>(key: string, values: readonly T[]): T {
    const value = this.data[key];
    const match = values.find((allowed) => allowed === value);
    if (match === undefined) this.fail(key, `is not one of ${values.join(', ')}`);
    return match;
  }

  object(key: string): Fields {
    return Fields.of(this.data[key], `${this.path}.${key}`);
  }

  /** A list of objects; null passes as null. */
  nullableObjects(key: string): Fields[] | null {
    const value = this.data[key];
    if (value === null) return null;
    if (!Array.isArray(value)) this.fail(key, 'is not a list');
    return value.map((item, index) => Fields.of(item, `${this.path}.${key}[${index}]`));
  }

  objects(key: string): Fields[] {
    const list = this.nullableObjects(key);
    if (list === null) this.fail(key, 'is not a list');
    return list;
  }

  fail(key: string, rule: string): never {
    throw new EventShapeError(`${this.path}.${key} ${rule}`);
  }
}

/** What JSON.parse makes of `{...}`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorStep<TDone>(data: Fields): Step<StreamErrorEvent, TDone> {
  const code = data.text('code');
  const message = data.text('message');
  return {
    event: { type: 'error', code, message },
    end: { kind: 'error', code, message, status: null },
  };
}

function toCitation(data: Fields): RefCitation {
  return {
    ref: data.text('ref'),
    segmentId: data.text('segment_id'),
    startMs: data.count('start_ms'),
  };
}

/**
 * The note a run saved. Its doc goes into notes.sqlite and then into the editor, so it passes
 * the same guard as a save from the page (a `__proto__` key, GHSA-cp6q-959q-f8rh, never gets in).
 */
function toNote(data: Fields): Note {
  const doc = data.raw('doc');
  if (!isNoteDoc(doc)) data.fail('doc', noteDocProblem(doc) ?? 'is not a notes doc');
  return {
    kind: data.oneOf('kind', ['user', 'ai']),
    doc,
    version: data.count('version'),
    templateId: data.nullableText('template_id'),
    lastRunId: data.nullableText('last_run_id'),
    generatedVersion: data.nullableCount('generated_version'),
    updatedAt: data.text('updated_at'),
  };
}

function toChatMessage(data: Fields): ChatMessage {
  return {
    id: data.text('id'),
    role: data.oneOf('role', ['user', 'assistant']),
    text: data.text('text'),
    // Stored as null for a question; the shared type says empty.
    citations: data.nullableObjects('citations')?.map(toCitation) ?? [],
    replyTo: data.nullableText('reply_to'),
    runId: data.nullableText('run_id'),
    status: data.oneOf('status', ['complete', 'streaming', 'failed']),
    createdAt: data.text('created_at'),
  };
}

/** A notes run's events (docs/api-contract.md, "Notes runs and streaming"). */
const NOTES_EVENTS: EventMap<NotesStreamEvent, Note> = new Map<
  string,
  (data: Fields) => Step<NotesStreamEvent, Note>
>([
  [
    'run',
    (data) => ({
      event: {
        type: 'run',
        runId: data.text('run_id'),
        model: data.text('model'),
        templateId: data.text('template_id'),
        lineCount: data.count('line_count'),
      },
    }),
  ],
  [
    'section',
    (data) => ({
      event: { type: 'section', index: data.count('index'), heading: data.text('heading') },
    }),
  ],
  [
    'item',
    (data) => ({
      event: {
        type: 'item',
        section: data.count('section'),
        text: data.text('text'),
        citations: data.objects('citations').map(toCitation),
        support: data.oneOf('support', ['ok', 'weak']),
      },
    }),
  ],
  ['from_notes', (data) => ({ event: { type: 'from_notes', text: data.text('text') } })],
  [
    'dropped',
    (data) => ({
      event: {
        type: 'dropped',
        text: data.text('text'),
        reason: data.oneOf('reason', ['no_refs', 'unknown_refs']),
      },
    }),
  ],
  [
    'done',
    (data) => {
      const note = toNote(data.object('note'));
      return {
        event: { type: 'done', runId: data.text('run_id'), note },
        end: { kind: 'done', result: note },
      };
    },
  ],
  ['error', errorStep],
]);

/** A chat answer's events (docs/api-contract.md, "Chat"). */
const CHAT_EVENTS: EventMap<ChatStreamEvent, ChatMessage> = new Map<
  string,
  (data: Fields) => Step<ChatStreamEvent, ChatMessage>
>([
  [
    // `run {run_id, model}`, both required by ChatStreamEvent (shared/notes.ts). Section 10 of
    // docs/plans/phase-2-build-order.md tells M4-T10 to send both: a chat `run` without `model`
    // drops every answer as `invalid_event` before its run id is read, so the caller reloads the
    // thread at once and a cancel never reaches the API.
    'run',
    (data) => {
      const runId = data.text('run_id');
      return { event: { type: 'run', runId, model: data.text('model') }, runId };
    },
  ],
  ['delta', (data) => ({ event: { type: 'delta', text: data.text('text') } })],
  ['citation', (data) => ({ event: { type: 'citation', ...toCitation(data) } })],
  [
    'done',
    (data) => {
      const message = toChatMessage(data.object('message'));
      return { event: { type: 'done', message }, end: { kind: 'done', result: message } };
    },
  ],
  ['error', errorStep],
]);
