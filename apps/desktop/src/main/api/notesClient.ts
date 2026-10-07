import {
  noteDocProblem,
  type ChatMessage,
  type ChatMessageStatus,
  type ChatRole,
  type ChatThread,
  type DroppedLine,
  type LlmRun,
  type LlmRunKind,
  type LlmRunStatus,
  type Note,
  type NoteDoc,
  type NoteKind,
  type NoteTemplate,
  type RefCitation,
} from '../../shared/notes';
import {
  ApiError,
  type ApiConnection,
  type ApiRequest,
  createApiRequest,
  type HttpMethod,
} from './http';

/**
 * Typed client for the notes, templates, runs and chat history routes (docs/api-contract.md: Note
 * templates, Notes, Notes runs and streaming, Chat), on the shared HTTP core in ./http.ts. The
 * streamed routes (generate, chat questions) go through streamRequest.ts (M4-T15), not here.
 *
 * The wire speaks snake_case; this file maps it to the camelCase types in shared/notes.ts and is
 * the only place that does, for these routes. Responses are cast as the contract types them, as
 * every client's are, with two exceptions: a notes doc and its kind are checked, because a doc
 * goes into notes.sqlite and the editor as it is (a `__proto__` key becomes DOM attributes in
 * TipTap before 3.30.4), and a cost is read as a number or a numeric string.
 */

/** A run as the history lists it: everything but its docs. */
export type LlmRunSummary = Omit<LlmRun, 'outputDoc' | 'replacedDoc'>;

/** Both notes of a meeting as Postgres holds them; null where that doc does not exist yet. */
export interface ServerNotes {
  user: Note | null;
  ai: Note | null;
}

export interface PutNoteRequest {
  doc: NoteDoc;
  /** The server version the doc builds on; 0 creates the note. A stale one is a `409`. */
  baseVersion: number;
  /** The local save that wrote the doc: a re-send of the same id is answered `200`, not stored twice. */
  revisionId: string;
}

export interface ListRunsOptions {
  kind?: LlmRunKind;
  limit?: number;
}

export interface ChatThreadOptions {
  limit?: number;
}

// The wire shapes, as docs/api-contract.md writes them.

interface NoteWire {
  /** Checked before use (`noteFromWire`), so typed as the wire may carry it. */
  kind: string;
  doc: unknown;
  version: number;
  template_id: string | null;
  last_run_id: string | null;
  generated_version: number | null;
  updated_at: string;
}

interface ServerNotesWire {
  user: NoteWire | null;
  ai: NoteWire | null;
}

interface LlmRunWire {
  id: string;
  kind: LlmRunKind;
  status: LlmRunStatus;
  model: string;
  template_id: string | null;
  error_code: string | null;
  error: string | null;
  /** `llm_runs.dropped` is nullable: null before the run listed any. */
  dropped: DroppedLine[] | null;
  flagged_count: number;
  from_notes_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  /**
   * `llm_runs.cost_usd` is a Postgres `numeric`, which the API may serialise as a Decimal string
   * ("0.0083"). Null when the vendor sent no usage, never 0.
   */
  cost_usd: number | string | null;
  started_at: string;
  finished_at: string | null;
  /** Only `GET /runs/{run_id}` carries the docs. */
  output_doc?: unknown;
  replaced_doc?: unknown;
}

interface RefCitationWire {
  ref: string;
  segment_id: string;
  start_ms: number;
}

interface ChatMessageWire {
  id: string;
  role: ChatRole;
  text: string;
  /** `chat_messages.citations` is nullable: a question carries none. */
  citations: RefCitationWire[] | null;
  reply_to: string | null;
  run_id: string | null;
  status: ChatMessageStatus;
  created_at: string;
}

interface ListWire<T> {
  items: T[];
}

export class NotesClient {
  private readonly request: ApiRequest;

  constructor(connection: ApiConnection) {
    this.request = createApiRequest(connection);
  }

  /** The AI notes templates, ordered by name. The wire already uses these field names. */
  async listTemplates(): Promise<NoteTemplate[]> {
    const body = await this.request<ListWire<NoteTemplate>>('GET', '/v1/note-templates');
    return body.items;
  }

  async getNotes(meetingId: string): Promise<ServerNotes> {
    const path = `${meetingPath(meetingId)}/notes`;
    const body = await this.request<ServerNotesWire>('GET', path);
    const at = { method: 'GET', path } as const;
    return {
      user: body.user === null ? null : noteFromWire(body.user, 'user', at),
      ai: body.ai === null ? null : noteFromWire(body.ai, 'ai', at),
    };
  }

  /** Stores a doc: `200` with the stored note. A stale `baseVersion` rejects with a `409`. */
  async putNote(meetingId: string, kind: NoteKind, request: PutNoteRequest): Promise<Note> {
    const path = `${meetingPath(meetingId)}/notes/${kind}`;
    const wire = await this.request<NoteWire>('PUT', path, {
      doc: request.doc,
      base_version: request.baseVersion,
      revision_id: request.revisionId,
    });
    return noteFromWire(wire, kind, { method: 'PUT', path });
  }

  /** The meeting's run history, newest first, as the API orders it. */
  async listRuns(meetingId: string, options: ListRunsOptions = {}): Promise<LlmRunSummary[]> {
    const query = new URLSearchParams();
    if (options.kind !== undefined) query.set('kind', options.kind);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const path = `${meetingPath(meetingId)}/runs`;
    const search = query.toString();
    const body = await this.request<ListWire<LlmRunWire>>(
      'GET',
      search === '' ? path : `${path}?${search}`,
    );
    return body.items.map((run) => runSummaryFromWire(run, meetingId, { method: 'GET', path }));
  }

  /** One run with the doc it wrote and the doc it replaced ("Restore previous notes"). */
  async getRun(meetingId: string, runId: string): Promise<LlmRun> {
    const path = `${meetingPath(meetingId)}/runs/${encodeURIComponent(runId)}`;
    const wire = await this.request<LlmRunWire>('GET', path);
    const at = { method: 'GET', path } as const;
    return {
      ...runSummaryFromWire(wire, meetingId, at),
      outputDoc: runDocFromWire(wire.output_doc, 'output_doc', at),
      replacedDoc: runDocFromWire(wire.replaced_doc, 'replaced_doc', at),
    };
  }

  /** Stops a notes or chat run. A run of another meeting or workspace is a `404`. */
  async cancelRun(meetingId: string, runId: string): Promise<LlmRunSummary> {
    const path = `${meetingPath(meetingId)}/runs/${encodeURIComponent(runId)}/cancel`;
    const wire = await this.request<LlmRunWire>('POST', path);
    return runSummaryFromWire(wire, meetingId, { method: 'POST', path });
  }

  /** The meeting's chat thread, oldest first. */
  async getChatThread(meetingId: string, options: ChatThreadOptions = {}): Promise<ChatThread> {
    const search = options.limit === undefined ? '' : `?limit=${options.limit}`;
    const body = await this.request<ListWire<ChatMessageWire>>(
      'GET',
      `${meetingPath(meetingId)}/chat${search}`,
    );
    return { meetingId, messages: body.items.map(chatMessageFromWire) };
  }
}

/**
 * The slices of the client each service uses, so a test fake typed by them needs no cast
 * (NotesClient's private member makes it nominal).
 */
export type NotesSyncApi = Pick<NotesClient, 'getNotes' | 'putNote'>;

/** Where a response came from, for the message of an `invalid_response`. */
interface ResponseAt {
  method: HttpMethod;
  path: string;
}

function meetingPath(meetingId: string): string {
  return `/v1/meetings/${encodeURIComponent(meetingId)}`;
}

function invalidResponse(at: ResponseAt, what: string): ApiError {
  return new ApiError(200, 'invalid_response', `${at.method} ${at.path} returned ${what}`);
}

function noteFromWire(wire: NoteWire, kind: NoteKind, at: ResponseAt): Note {
  // Checked, not cast: the note lands in notes.sqlite under this kind, so a swapped kind would
  // overwrite the other doc of the meeting.
  if (wire.kind !== kind) {
    throw invalidResponse(at, `a note of kind "${wire.kind}" where the ${kind} note belongs`);
  }
  return {
    kind,
    doc: docFromWire(wire.doc, `a ${kind} note doc`, at),
    version: wire.version,
    templateId: wire.template_id,
    lastRunId: wire.last_run_id,
    generatedVersion: wire.generated_version,
    updatedAt: wire.updated_at,
  };
}

/**
 * The same check main makes on a save from the page (`noteDocProblem`, shared/notes.ts): a doc
 * notes.sqlite takes from the API is one the desktop could have saved itself.
 */
function docFromWire(value: unknown, what: string, at: ResponseAt): NoteDoc {
  const problem = noteDocProblem(value);
  if (problem !== null) throw invalidResponse(at, `${what} that is ${problem}`);
  // noteDocProblem accepted it, which is what NoteDoc means.
  return value as NoteDoc;
}

function runDocFromWire(value: unknown, field: string, at: ResponseAt): NoteDoc | null {
  // `undefined` is a missing field, not "no doc": a run read without its docs must not show as a
  // first run (null `replaced_doc`) with nothing to restore.
  if (value === undefined) throw invalidResponse(at, `no ${field}`);
  return value === null ? null : docFromWire(value, `a ${field}`, at);
}

function runSummaryFromWire(wire: LlmRunWire, meetingId: string, at: ResponseAt): LlmRunSummary {
  return {
    id: wire.id,
    meetingId,
    kind: wire.kind,
    status: wire.status,
    model: wire.model,
    templateId: wire.template_id,
    errorCode: wire.error_code,
    error: wire.error,
    dropped: wire.dropped ?? [],
    flaggedCount: wire.flagged_count,
    fromNotesCount: wire.from_notes_count,
    inputTokens: wire.input_tokens,
    outputTokens: wire.output_tokens,
    cachedTokens: wire.cached_tokens,
    costUsd: costFromWire(wire.cost_usd, at),
    startedAt: wire.started_at,
    finishedAt: wire.finished_at,
  };
}

function costFromWire(value: number | string | null, at: ResponseAt): number | null {
  if (value === null) return null;
  // `Number('')` is 0, and a missing cost must never read as free.
  const cost = typeof value === 'string' && value.trim() === '' ? Number.NaN : Number(value);
  if (!Number.isFinite(cost)) throw invalidResponse(at, 'a cost that is not a number');
  return cost;
}

function chatMessageFromWire(wire: ChatMessageWire): ChatMessage {
  return {
    id: wire.id,
    role: wire.role,
    text: wire.text,
    citations: (wire.citations ?? []).map(citationFromWire),
    replyTo: wire.reply_to,
    runId: wire.run_id,
    status: wire.status,
    createdAt: wire.created_at,
  };
}

function citationFromWire(wire: RefCitationWire): RefCitation {
  return { ref: wire.ref, segmentId: wire.segment_id, startMs: wire.start_ms };
}
