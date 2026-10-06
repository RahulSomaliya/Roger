import { isMeetingId } from '../../shared/ipc/app';
import type { ChatAnswerRequest, SendChatMessageRequest } from '../../shared/ipc/chat';
import type {
  GenerateNotesRequest,
  NoteSaveBase,
  NotesFlush,
  NotesRunRequest,
  ResolveNoteConflictRequest,
  SaveNoteRequest,
} from '../../shared/ipc/notes';
import {
  isChatText,
  isNoteDoc,
  isNoteKind,
  MAX_CHAT_TEXT_CHARS,
  noteDocProblem,
} from '../../shared/notes';

/**
 * The notes and chat channels' payloads are untrusted input (CLAUDE.md rule 5), checked here
 * before any handler in notes-ipc.ts uses one, with the guards that mirror the API's limits
 * (src/shared/notes.ts): a doc or a question the API would refuse with a 422 must never reach
 * notes.sqlite or a stream. Every parser builds a fresh object of the fields it checked, so nothing
 * else a payload carries reaches a handler. A refusal names the field and the rule, never a value:
 * payloads hold what the user typed. No Electron import, so this tests under Node.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

/** Run, message, revision and flush ids: UUIDv4 as main and the page make them, lower case. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Template ids are the API's data (`general`, `standup`, `client_call`, `one_on_one`). */
const TEMPLATE_ID = /^[a-z][a-z0-9_]{0,63}$/;

/** The payload of the channels that take a meeting id alone (`notes:get`, `chat:get-thread`). */
export function parseMeetingIdPayload(payload: unknown): Parsed<string> {
  return isMeeting(payload) ? ok(payload) : refuse('the payload is not a lowercase meeting id');
}

export function parseSaveNoteRequest(payload: unknown): Parsed<SaveNoteRequest> {
  const fields = record(payload);
  if (fields === null) return notAnObject();
  const { meetingId, kind, doc, base } = fields;
  if (!isMeeting(meetingId)) return badMeetingId();
  if (!isNoteKind(kind)) return badKind();
  if (!isNoteDoc(doc)) {
    // noteDocProblem names the rule, never the doc's text.
    return refuse(`the doc: ${noteDocProblem(doc) ?? 'not a notes doc'}`);
  }
  const parsedBase = parseBase(base);
  if (parsedBase === undefined) {
    return refuse('base is not null or { revisionId: a revision id or null, version: 0 or more }');
  }
  // The doc as it came: the structured clone IPC made is main's own object already, and a copy
  // would cost a walk of the whole doc for nothing.
  return ok({ meetingId, kind, doc, base: parsedBase });
}

export function parseResolveNoteConflictRequest(
  payload: unknown,
): Parsed<ResolveNoteConflictRequest> {
  const fields = record(payload);
  if (fields === null) return notAnObject();
  const { meetingId, kind, keep } = fields;
  if (!isMeeting(meetingId)) return badMeetingId();
  if (!isNoteKind(kind)) return badKind();
  if (keep !== 'mine' && keep !== 'theirs') return refuse('keep is not mine or theirs');
  return ok({ meetingId, kind, keep });
}

export function parseGenerateNotesRequest(payload: unknown): Parsed<GenerateNotesRequest> {
  const fields = record(payload);
  if (fields === null) return notAnObject();
  const { meetingId, templateId } = fields;
  if (!isMeeting(meetingId)) return badMeetingId();
  if (typeof templateId !== 'string' || !TEMPLATE_ID.test(templateId)) {
    return refuse('templateId is not a template id (a-z, 0-9 and _, at most 64)');
  }
  return ok({ meetingId, templateId });
}

export function parseNotesRunRequest(payload: unknown): Parsed<NotesRunRequest> {
  const fields = record(payload);
  if (fields === null) return notAnObject();
  const { meetingId, runId } = fields;
  if (!isMeeting(meetingId)) return badMeetingId();
  if (!isId(runId)) return refuse('runId is not a lowercase run id');
  return ok({ meetingId, runId });
}

export function parseNotesFlushAck(payload: unknown): Parsed<NotesFlush> {
  const fields = record(payload);
  if (fields === null) return notAnObject();
  const { requestId } = fields;
  if (!isId(requestId)) return refuse('requestId is not a flush request id');
  return ok({ requestId });
}

export function parseSendChatMessageRequest(payload: unknown): Parsed<SendChatMessageRequest> {
  const fields = record(payload);
  if (fields === null) return notAnObject();
  const { meetingId, messageId, text } = fields;
  if (!isMeeting(meetingId)) return badMeetingId();
  if (!isId(messageId)) return badMessageId();
  if (!isChatText(text)) {
    return refuse(`text is not 1 to ${MAX_CHAT_TEXT_CHARS} characters with something to ask`);
  }
  return ok({ meetingId, messageId, text });
}

export function parseChatAnswerRequest(payload: unknown): Parsed<ChatAnswerRequest> {
  const fields = record(payload);
  if (fields === null) return notAnObject();
  const { meetingId, messageId } = fields;
  if (!isMeeting(meetingId)) return badMeetingId();
  if (!isId(messageId)) return badMessageId();
  return ok({ meetingId, messageId });
}

/** The base as a fresh object, null for none, or undefined when it is neither. */
function parseBase(value: unknown): NoteSaveBase | null | undefined {
  if (value === null) return null;
  const fields = record(value);
  if (fields === null) return undefined;
  const { revisionId, version } = fields;
  if (revisionId !== null && !isId(revisionId)) return undefined;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    return undefined;
  }
  return { revisionId, version };
}

/** A JSON object's fields; null for anything else (an array, a string, null). */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isMeeting(value: unknown): value is string {
  return typeof value === 'string' && isMeetingId(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function refuse(problem: string): { ok: false; problem: string } {
  return { ok: false, problem };
}

function notAnObject(): { ok: false; problem: string } {
  return refuse('the payload is not an object');
}

function badMeetingId(): { ok: false; problem: string } {
  return refuse('meetingId is not a lowercase meeting id');
}

function badKind(): { ok: false; problem: string } {
  return refuse('kind is not user or ai');
}

function badMessageId(): { ok: false; problem: string } {
  return refuse('messageId is not a lowercase message id');
}
