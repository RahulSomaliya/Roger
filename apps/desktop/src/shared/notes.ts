/**
 * Notes and chat domain types shared by main, preload and the renderer (M4). The API speaks
 * snake_case (docs/api-contract.md: Notes, Notes runs and streaming, Chat); these are the
 * desktop's camelCase mirror, mapped in main (main/api/notesClient.ts for requests,
 * main/notes/LlmStreams.ts for stream events) and nowhere else. Values keep the API's spelling
 * (`from_notes`, `no_refs`, `llm_provider_error`): they are codes, not field names.
 * Keep this file free of runtime imports: it is bundled into every process.
 */

// Docs -------------------------------------------------------------------------------------------

/** A mark on a text node (bold, italic, link, ...), as TipTap's `getJSON()` writes it. */
export interface NoteMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/**
 * One node of a TipTap JSON doc. Shaped so a NoteDoc goes into TipTap's `setContent` as it is.
 * The guards below check structure and citation attrs only, never the editor schema: that check
 * (`Node.fromJSON` and `doc.check()`) lives with the editor in renderer/src/notes/citationNode.ts,
 * because `setContent` strips what its schema refuses without an error.
 */
export interface NoteNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: NoteNode[];
  text?: string;
  marks?: NoteMark[];
}

/** One notes doc, the user's or the AI's. */
export interface NoteDoc {
  type: 'doc';
  content?: NoteNode[];
}

/**
 * The inline node of an AI notes chip. The editor's node (renderer/src/notes/citationNode.ts) and
 * the API's doc builder (notes_generation.py) use this name; the shared fixture
 * apps/api/tests/fixtures/ai_notes_doc.json pins both.
 */
export const CITATION_NODE_TYPE = 'citation';

/** `weak`: the line's numbers or words are not in its cited lines; the chip says "check this". */
export type CitationSupport = 'ok' | 'weak';

/** A `citation` node's attrs: one chip in the AI notes. */
export interface CitationAttrs {
  /** The transcript lines behind the chip; never empty. */
  segmentIds: string[];
  /**
   * When the first of them starts, in ms from the meeting start. Kept so M12 can re-point a chip
   * by time once the second-pass transcript replaces the segment ids.
   */
  startMs: number;
  /** The time the chip shows: "03:12", or "1:02:05" past an hour. */
  label: string;
  support: CitationSupport;
}

/**
 * The heading above the AI lines that only the user's notes back (M4 D7, option a), then a muted
 * line and a plain bullet list with no chips. The API's builder writes the same strings
 * (`FROM_YOUR_NOTES_HEADING` in notes_markdown.py); the fixture test in notes.test.ts pins both.
 */
export const FROM_YOUR_NOTES_HEADING = 'From your notes';
export const NOT_SAID_ON_THE_CALL = 'Not said on the call';

/**
 * The API's limits on a stored doc (`PUT /v1/meetings/{id}/notes/{kind}`, owned by M4-T6). Main
 * refuses a save over them, because a doc the API refuses with a 422 would stay dirty in
 * notes.sqlite and be re-sent forever while the page says "syncing". The API must measure the
 * same way (UTF-8 bytes of the compact JSON; levels as `noteDocProblem` counts them) or more
 * leniently, never more strictly.
 */
export const MAX_NOTE_DOC_BYTES = 512 * 1024;
export const MAX_NOTE_DOC_DEPTH = 32;

/** Keys that reach prototypes when a doc becomes DOM attributes (GHSA-cp6q-959q-f8rh). */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Lower case only: the navigator matches ids as text against each line's `data-segment-id`. */
const SEGMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Why `value` is not a notes doc the API would store, or null when it is. The reason names the
 * rule, never the doc's text, so it can be logged. Checked: a `doc` root; every node an object
 * with a type, its `content` a list of nodes, `text` a string, `attrs` an object, `marks` a list
 * of typed marks; citation attrs (`isCitationAttrs`); only values JSON carries as they are; no
 * `__proto__`, `constructor` or `prototype` key anywhere; at most MAX_NOTE_DOC_DEPTH levels, the
 * doc being level 1 and every object or array one level below its parent; at most
 * MAX_NOTE_DOC_BYTES of JSON in UTF-8.
 */
export function noteDocProblem(value: unknown): string | null {
  if (!isPlainObject(value) || value.type !== 'doc') return 'not a TipTap doc';
  // The JSON rules first, without recursion: a payload nested thousands deep must be refused, not
  // overflow the stack. The node walk below then recurses at most MAX_NOTE_DOC_DEPTH times, and
  // JSON.stringify meets nothing it would throw on (a BigInt) or silently change (NaN, a Date).
  const shape = jsonProblem(value);
  if (shape !== null) return shape;
  const node = nodeProblem(value);
  if (node !== null) return node;
  if (utf8Length(JSON.stringify(value)) > MAX_NOTE_DOC_BYTES) {
    return `larger than ${MAX_NOTE_DOC_BYTES} bytes`;
  }
  return null;
}

export function isNoteDoc(value: unknown): value is NoteDoc {
  return noteDocProblem(value) === null;
}

export function isCitationAttrs(value: unknown): value is CitationAttrs {
  if (!isPlainObject(value)) return false;
  const { segmentIds, startMs, label, support } = value;
  return (
    Array.isArray(segmentIds) &&
    segmentIds.length > 0 &&
    segmentIds.every((id) => typeof id === 'string' && SEGMENT_ID.test(id)) &&
    typeof startMs === 'number' &&
    Number.isSafeInteger(startMs) &&
    startMs >= 0 &&
    typeof label === 'string' &&
    label !== '' &&
    (support === 'ok' || support === 'weak')
  );
}

/**
 * Whether the doc is JSON within the limits: plain objects, arrays, strings, finite numbers,
 * booleans and null only (IPC's structured clone also carries BigInts, NaN, Dates and Maps), no
 * forbidden key, at most MAX_NOTE_DOC_DEPTH levels. `undefined` passes: JSON leaves it out.
 */
function jsonProblem(doc: Record<string, unknown>): string | null {
  const stack: { value: unknown; level: number }[] = [{ value: doc, level: 1 }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { value, level } = next;
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    const isArray = Array.isArray(value);
    if (!isArray && !isPlainObject(value)) return 'holds a value JSON cannot carry';
    if (level > MAX_NOTE_DOC_DEPTH) return `nested deeper than ${MAX_NOTE_DOC_DEPTH} levels`;
    if (!isArray) {
      const forbidden = Object.keys(value).find((key) => FORBIDDEN_KEYS.has(key));
      if (forbidden !== undefined) return `holds a "${forbidden}" key`;
    }
    for (const child of Object.values(value)) stack.push({ value: child, level: level + 1 });
  }
  return null;
}

function nodeProblem(node: Record<string, unknown>): string | null {
  const { type, attrs, content, text, marks } = node;
  if (typeof type !== 'string' || type === '') return 'a node without a type';
  if (attrs !== undefined && !isPlainObject(attrs)) return 'node attrs that are not an object';
  if (text !== undefined && typeof text !== 'string') return 'node text that is not a string';
  if (marks !== undefined && !(Array.isArray(marks) && marks.every(isMark))) {
    return 'marks that are not a list of typed marks';
  }
  if (type === CITATION_NODE_TYPE && !isCitationAttrs(attrs)) return 'a citation with bad attrs';
  if (content === undefined) return null;
  if (!Array.isArray(content)) return 'node content that is not a list';
  for (const child of content) {
    if (!isPlainObject(child)) return 'a node that is not an object';
    const problem = nodeProblem(child);
    if (problem !== null) return problem;
  }
  return null;
}

function isMark(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof value.type === 'string' &&
    value.type !== '' &&
    (value.attrs === undefined || isPlainObject(value.attrs))
  );
}

/**
 * A JSON object: not an array, a Date, a Map or any other class (IPC's structured clone carries
 * those). By tag, not prototype, so an object made in another realm (contextBridge) still counts.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

// Notes ------------------------------------------------------------------------------------------

/** The user's own notes ("My notes") and the AI notes: two docs per meeting. */
export type NoteKind = 'user' | 'ai';

export function isNoteKind(value: unknown): value is NoteKind {
  return value === 'user' || value === 'ai';
}

/** A note as Postgres holds it: `GET` and `PUT /v1/meetings/{id}/notes`, and a run's `done`. */
export interface Note {
  kind: NoteKind;
  doc: NoteDoc;
  /** Raised by every stored `PUT`; a `PUT` names the version it builds on. */
  version: number;
  /** The template of the run that wrote the AI notes; null for the user's notes. */
  templateId: string | null;
  lastRunId: string | null;
  /** The version `lastRunId` wrote (AI notes only): a higher `version` was edited since. */
  generatedVersion: number | null;
  /** UTC ISO 8601. */
  updatedAt: string;
}

/**
 * How a note stands with the API; the meeting page shows one state per note.
 * - `saved_locally`: "Saved on this Mac". In notes.sqlite, not sent yet.
 * - `waiting_for_meeting`: the meeting is not in Postgres yet (still pending in roger.sqlite, or
 *   a `404` sent it back to the uploader to re-create). NotesSync never creates a meeting.
 * - `syncing`: a `PUT` is on its way.
 * - `synced`: the server holds this doc.
 * - `offline`: the API is away; the doc stays on this Mac and NotesSync retries with backoff.
 * - `conflict`: the server had a newer version. `doc` is now the server's, and `conflictCopy`
 *   keeps the local one until the user picks ("Use mine").
 */
export type NoteSyncState =
  'saved_locally' | 'waiting_for_meeting' | 'syncing' | 'synced' | 'offline' | 'conflict';

/** A note as notes.sqlite holds it (main/notes/NotesStore.ts): what the editor shows. */
export interface LocalNote {
  meetingId: string;
  kind: NoteKind;
  doc: NoteDoc;
  /**
   * The local save that wrote `doc` (the `revision_id` its `PUT` carries), or null when `doc`
   * came from the server. An editor compares it with the id its own last save returned: equal
   * means the change is that save coming back, anything else is a doc it must load.
   */
  revisionId: string | null;
  /** `doc` holds edits the server has not stored yet. */
  dirty: boolean;
  /** The server version `doc` builds on (a `PUT`'s `base_version`); 0 while the server has none. */
  baseVersion: number;
  templateId: string | null;
  lastRunId: string | null;
  generatedVersion: number | null;
  /** The local doc a conflict pushed aside, until the user picks ("Use mine") or drops it. */
  conflictCopy: NoteDoc | null;
  sync: NoteSyncState;
  /** The last local save, or when the server's doc was taken. UTC ISO 8601. */
  updatedAt: string;
}

/** Both notes of one meeting; null where that doc does not exist yet. */
export interface MeetingNotes {
  meetingId: string;
  user: LocalNote | null;
  ai: LocalNote | null;
}

/** A template from `GET /v1/note-templates`: the sections the AI notes use, in order. */
export interface NoteTemplate {
  /** `general`, `standup`, `client_call`, `one_on_one`: templates are API data (M4-T3). */
  id: string;
  name: string;
  description: string;
  sections: NoteTemplateSection[];
}

export interface NoteTemplateSection {
  /** The exact heading the AI notes use. */
  heading: string;
  /** What belongs under it, as the prompt tells the model. */
  guidance: string;
}

// Runs and their streams -------------------------------------------------------------------------

export type LlmRunKind = 'notes' | 'chat';
export type LlmRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

/**
 * Why the API dropped an AI line (services/citations.py): `no_refs`, it cited nothing;
 * `unknown_refs`, every ref it cited points nowhere. The panel's "Removed lines" use these codes.
 */
export type DropReason = 'no_refs' | 'unknown_refs';

export interface DroppedLine {
  text: string;
  reason: DropReason;
}

/** One run, notes or chat: `GET /v1/meetings/{id}/runs/{run_id}`. */
export interface LlmRun {
  id: string;
  meetingId: string;
  kind: LlmRunKind;
  status: LlmRunStatus;
  model: string;
  templateId: string | null;
  /** A run error code (see NotesStreamEvent's `error`); null unless failed or cancelled. */
  errorCode: string | null;
  error: string | null;
  /** The lines the API removed, in the order the model wrote them: "Removed lines". */
  dropped: DroppedLine[];
  flaggedCount: number;
  fromNotesCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  /** Null when the vendor sent no usage, never 0. */
  costUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
  outputDoc: NoteDoc | null;
  /** The AI notes this run replaced, for "Restore previous notes"; null for a first run. */
  replacedDoc: NoteDoc | null;
}

/** A ref the model wrote (`L12`), which the API mapped to its transcript line. */
export interface RefCitation {
  ref: string;
  segmentId: string;
  startMs: number;
}

/**
 * A notes run's events (the API's SSE events, docs/api-contract.md), as main forwards them.
 * `error` codes: the API's `llm_provider_error` (Retry keeps the pending generate), `cut_off`,
 * `cancelled` and `internal_error`, plus the code of a refusal before the stream began (the API's
 * error envelope: `conflict`, `empty_meeting`, ...; `network_error` when the API was not reached).
 */
export type NotesStreamEvent =
  | { type: 'run'; runId: string; model: string; templateId: string; lineCount: number }
  | { type: 'section'; index: number; heading: string }
  | {
      type: 'item';
      /** The `index` of the section it belongs to. */
      section: number;
      text: string;
      citations: RefCitation[];
      support: CitationSupport;
    }
  | { type: 'from_notes'; text: string }
  | { type: 'dropped'; text: string; reason: DropReason }
  | { type: 'done'; runId: string; note: Note }
  | { type: 'error'; code: string; message: string };

/** Why a notes generate started: Stop with auto-generate on, or the Generate button. */
export type GenerateReason = 'after_stop' | 'button';

/**
 * Where a pending generate stands. The AI notes panel says one thing per phase:
 * - `needs_template`: "Which kind of call was this?" with the four templates.
 * - `waiting_for_lines`: "Notes will generate when 12 lines finish uploading".
 * - `waiting_for_notes`: the notes could not upload first. `meeting`: the meeting is not in
 *   Postgres yet; `offline`: "Waiting for your notes to upload (offline)"; `conflict`: "Resolve
 *   the conflict in My notes first".
 * - `running`: the run is streaming; its events arrive on `notes:event`.
 * - `failed`: a failure Retry can fix (`llm_provider_error`). Others end the pending generate.
 */
export type PendingGenerateStatus =
  | { phase: 'needs_template' }
  | { phase: 'waiting_for_lines'; waitingLines: number }
  | { phase: 'waiting_for_notes'; cause: 'meeting' | 'offline' | 'conflict' }
  | { phase: 'running' }
  | { phase: 'failed'; code: string; message: string };

/** A meeting's pending generate (notes.sqlite, `pending_generate`): at most one per meeting. */
export interface PendingGenerateState {
  meetingId: string;
  /**
   * Made before the first attempt and re-sent by every attempt after a crash or a dropped stream,
   * which then attaches to or replays this run instead of paying for a second one.
   */
  runId: string;
  /** Null until a template is known; the panel then asks (`needs_template`). */
  templateId: string | null;
  reason: GenerateReason;
  createdAt: string;
  status: PendingGenerateStatus;
}

// Chat -------------------------------------------------------------------------------------------

/** The API's length check on a question (`POST /v1/meetings/{id}/chat`), in characters. */
export const MAX_CHAT_TEXT_CHARS = 4000;

/**
 * A question the API takes: 1 to MAX_CHAT_TEXT_CHARS characters, not only spaces. Counted in
 * code points as the API counts characters: `String.length` counts an emoji twice and would refuse
 * a question the API takes.
 */
export function isChatText(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  let characters = 0;
  for (const _character of value) {
    characters += 1;
    if (characters > MAX_CHAT_TEXT_CHARS) return false;
  }
  return true;
}

export type ChatRole = 'user' | 'assistant';
export type ChatMessageStatus = 'complete' | 'streaming' | 'failed';

/** One message of a meeting's chat thread (`GET /v1/meetings/{id}/chat`). */
export interface ChatMessage {
  /** The desktop makes a question's id; re-sending it never stores a second message. */
  id: string;
  role: ChatRole;
  text: string;
  /** An answer's citations in text order; empty for a question. */
  citations: RefCitation[];
  /** The question an answer replies to; null for a question. */
  replyTo: string | null;
  runId: string | null;
  status: ChatMessageStatus;
  createdAt: string;
}

/** A meeting's chat thread, oldest first. */
export interface ChatThread {
  meetingId: string;
  messages: ChatMessage[];
}

/**
 * A chat answer's events (the API's SSE events), as main forwards them. `error` codes are those
 * of NotesStreamEvent, plus the API's `meeting_too_long` before the stream.
 */
export type ChatStreamEvent =
  | { type: 'run'; runId: string; model: string }
  | { type: 'delta'; text: string }
  | { type: 'citation'; ref: string; segmentId: string; startMs: number }
  | { type: 'done'; message: ChatMessage }
  | { type: 'error'; code: string; message: string };
