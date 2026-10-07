import {
  type CalendarAttendee,
  MAX_MEETING_ATTENDEES,
  type MeetingCalendarEvent,
  parseInstant,
  type ResponseStatus,
} from '../shared/calendar';
import {
  isStartSource,
  MAX_MEETING_TITLE_LENGTH,
  type StartCaptureRequest,
  storedMeetingText,
} from '../shared/capture';
import type { AudioSourceStateMessage } from '../shared/ipc';
import type { MeetingRequest, SegmentRequest } from '../shared/ipc/capture';
import { SETTINGS_PANE_IDS, type SettingsPaneRequest } from '../shared/ipc/setup';
import { isAudioSource, type AudioSource } from '../shared/transcript';

/**
 * Renderer payloads are untrusted input: validated here, without any Electron import so tests run
 * under Node. Every parser builds a fresh object of the fields it checked, so nothing else a
 * payload carries reaches a handler.
 */

/** 100 ms chunks are 3200 bytes; anything near a megabyte is not audio from our worklet. */
export const MAX_AUDIO_CHUNK_BYTES = 1_048_576;

/**
 * How far a chunk's capture time may be from main's clock: a time further than this is junk or a
 * forged payload, and would put the chunk's lines hours away on the meeting timeline. Real chunks
 * are milliseconds off only while the renderer builds the time on `Date.now()` per chunk (see
 * `AudioChunkMessage.capturedAtMs`). One built on `performance.timeOrigin` falls behind by every
 * sleep since the page loaded, because Chromium's monotonic clock stops while a Mac sleeps: past
 * a day of sleeps this refuses every mic chunk, and the mic is dead until Roger restarts.
 */
export const MAX_CAPTURE_TIME_SKEW_MS = 86_400_000;

export interface ParsedAudioChunk {
  source: AudioSource;
  pcm: Uint8Array;
  /** Wall clock of the first sample, or null when the renderer sent none (use the arrival). */
  capturedAtMs: number | null;
}

export function parseAudioChunk(
  message: unknown,
  nowMs: number = Date.now(),
): ParsedAudioChunk | null {
  if (typeof message !== 'object' || message === null) return null;
  const { source, pcm, capturedAtMs } = message as {
    source?: unknown;
    pcm?: unknown;
    capturedAtMs?: unknown;
  };
  if (!isAudioSource(source)) return null;
  let bytes: Uint8Array;
  if (pcm instanceof ArrayBuffer) bytes = new Uint8Array(pcm);
  else if (ArrayBuffer.isView(pcm))
    bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  else return null;
  // Int16 samples: an odd length would shift every later sample the vendor hears.
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength % 2 !== 0 ||
    bytes.byteLength > MAX_AUDIO_CHUNK_BYTES
  )
    return null;
  if (capturedAtMs === undefined) return { source, pcm: bytes, capturedAtMs: null };
  // A bad time refuses the whole chunk rather than falling back to the arrival time: a renderer
  // that sends one is broken (see MAX_CAPTURE_TIME_SKEW_MS for the clock that breaks it) or not
  // ours, and its audio cannot be placed on the timeline either.
  if (
    typeof capturedAtMs !== 'number' ||
    !Number.isFinite(capturedAtMs) ||
    Math.abs(capturedAtMs - nowMs) > MAX_CAPTURE_TIME_SKEW_MS
  )
    return null;
  return { source, pcm: bytes, capturedAtMs };
}

export function isSourceStateMessage(message: unknown): message is AudioSourceStateMessage {
  if (typeof message !== 'object' || message === null) return false;
  const { source, state, message: text } = message as Record<string, unknown>;
  return (
    isAudioSource(source) &&
    (state === 'active' || state === 'ended' || state === 'error') &&
    (text === undefined || typeof text === 'string')
  );
}

/** A lowercase RFC 4122 version 4 UUID, the only spelling `randomUUID()` makes. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The desktop makes every meeting and segment id with `randomUUID()`. One spelling only: meeting
 * ids name folders on disk (`userData/audio/<id>`), so `../x` or an absolute path would make a
 * delete climb out of the audio root, and on a case-insensitive disk an upper-case copy would
 * name the same folder as another id.
 */
export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

export function parseMeetingRequest(payload: unknown): MeetingRequest | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { meetingId } = payload as Record<string, unknown>;
  return isUuidV4(meetingId) ? { meetingId } : null;
}

export function parseSegmentRequest(payload: unknown): SegmentRequest | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { meetingId, segmentId } = payload as Record<string, unknown>;
  return isUuidV4(meetingId) && isUuidV4(segmentId) ? { meetingId, segmentId } : null;
}

/**
 * The pane picks which link main opens, so only a listed name passes: never a URL, and never a key
 * an object lookup would find on the prototype (`toString`, `__proto__`).
 */
export function parseSettingsPaneRequest(payload: unknown): SettingsPaneRequest | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { pane } = payload as Record<string, unknown>;
  const known = SETTINGS_PANE_IDS.find((id) => id === pane);
  return known === undefined ? null : { pane: known };
}

/**
 * The longest text field of a meeting's calendar link the API stores, in characters once trimmed:
 * `MAX_CALENDAR_TEXT_LENGTH` in apps/api/src/roger_api/schemas/meetings.py. Change the two together;
 * ipc-validation.test.ts reads the API's source and fails when they differ.
 */
export const MAX_CALENDAR_TEXT_LENGTH = 2048;

const RESPONSE_STATUSES: readonly ResponseStatus[] = [
  'accepted',
  'tentative',
  'declined',
  'needs_action',
];

/**
 * A Start's request (StartCaptureRequest), from the window's `capture:start` or main's own
 * `CaptureService.requestStart`. Every field meets what `POST /v1/meetings` accepts (API contract):
 * the uploader sends them with the meeting's create, and a create the API refuses keeps the whole
 * meeting, its transcript included, off the server; refused here, the start says why at once.
 * No payload is a plain manual Start (`startCapture()` sends none). Throws naming the field, unlike
 * the parsers above, which answer null: a request with this many fields should say which was wrong.
 * Values are passed on as sent; the API trims and cleans them as it stores them.
 */
export function parseStartCaptureRequest(payload: unknown): StartCaptureRequest {
  if (payload === undefined) return {};
  const fields = record(payload, null);
  const request: StartCaptureRequest = {};
  if (fields.source !== undefined) {
    if (!isStartSource(fields.source)) refuse('source is not a start source');
    request.source = fields.source;
  }
  if (fields.title !== undefined) {
    request.title = text(fields.title, 'title', { max: MAX_MEETING_TITLE_LENGTH, blank: true });
  }
  if (fields.calendarEvent !== undefined && fields.calendarEvent !== null) {
    request.calendarEvent = meetingCalendarEvent(fields.calendarEvent);
  }
  return request;
}

function meetingCalendarEvent(value: unknown): MeetingCalendarEvent {
  const fields = record(value, 'calendarEvent');
  const { provider } = fields;
  if (provider !== 'google' && provider !== 'fake') {
    refuse('calendarEvent.provider is not google or fake');
  }
  const attendees = list(fields.attendees, 'calendarEvent.attendees');
  if (attendees.length > MAX_MEETING_ATTENDEES) {
    refuse(`calendarEvent.attendees has over ${MAX_MEETING_ATTENDEES} people`);
  }
  return {
    provider,
    eventId: calendarText(fields.eventId, 'calendarEvent.eventId'),
    icalUid: optionalCalendarText(fields.icalUid, 'calendarEvent.icalUid'),
    recurringEventId: optionalCalendarText(
      fields.recurringEventId,
      'calendarEvent.recurringEventId',
    ),
    scheduledStart: instant(fields.scheduledStart, 'calendarEvent.scheduledStart'),
    scheduledEnd: instant(fields.scheduledEnd, 'calendarEvent.scheduledEnd'),
    attendees: attendees.map((each, index) =>
      calendarAttendee(each, `calendarEvent.attendees[${index}]`),
    ),
  };
}

function calendarAttendee(value: unknown, name: string): CalendarAttendee {
  const fields = record(value, name);
  const { responseStatus, isSelf, isOrganizer } = fields;
  const response = RESPONSE_STATUSES.find((status) => status === responseStatus);
  if (response === undefined) refuse(`${name}.responseStatus is not a response`);
  if (typeof isSelf !== 'boolean') refuse(`${name}.isSelf is not true or false`);
  if (typeof isOrganizer !== 'boolean') refuse(`${name}.isOrganizer is not true or false`);
  return {
    email: calendarText(fields.email, `${name}.email`),
    displayName: optionalCalendarText(fields.displayName, `${name}.displayName`),
    responseStatus: response,
    isSelf,
    isOrganizer,
  };
}

function calendarText(value: unknown, name: string): string {
  return text(value, name, { max: MAX_CALENDAR_TEXT_LENGTH, blank: false });
}

/** Left out or null reads as null, as the API stores it; it stores a blank one as null too. */
function optionalCalendarText(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  return text(value, name, { max: MAX_CALENDAR_TEXT_LENGTH, blank: true });
}

/**
 * Text measured as the API measures it before it stores it: its storedMeetingText (U+0000 dropped,
 * then trimmed as the API trims, never with trim()), counted in code points as Python's `len`
 * counts (`Array.from`, never `.length`: an emoji is one character to the API and two UTF-16 units
 * here).
 */
function text(value: unknown, name: string, rules: { max: number; blank: boolean }): string {
  if (typeof value !== 'string') refuse(`${name} is not text`);
  const length = Array.from(storedMeetingText(value)).length;
  if (length === 0 && !rules.blank) refuse(`${name} is blank`);
  if (length > rules.max) refuse(`${name} is over ${rules.max} characters`);
  return value;
}

/** An instant with a zone, as the API requires: one without would be read in the Mac's zone. */
function instant(value: unknown, name: string): string {
  if (typeof value !== 'string' || !isApiInstant(value)) {
    refuse(`${name} is not an instant with a zone`);
  }
  return value;
}

/** Python's `datetime.min` and `datetime.max` in UTC, to the millisecond a Date keeps. */
const PYTHON_FIRST_MS = Date.parse('0001-01-01T00:00:00.000Z');
const PYTHON_LAST_MS = Date.parse('9999-12-31T23:59:59.999Z');

/** The year and the hour as written, in parseInstant's form. */
const WRITTEN_YEAR_AND_HOUR = /^(\d{4})-\d{2}-\d{2}T(\d{2}):/;

/**
 * Whether the API reads `value` as an instant (`UtcDatetime`). parseInstant alone is not enough:
 * its Date.parse also takes hour 24 (the next midnight) and year 0, which pydantic refuses (422),
 * and a time near year 1 or 9999 whose zone moves it out of Python's years makes the API's
 * conversion to UTC overflow (500). parseInstant's error is not passed on: it quotes the value,
 * which is the page's text and would reach main's log through the refusal; the field's name in the
 * refusal says enough.
 */
function isApiInstant(value: string): boolean {
  let ms: number;
  try {
    ms = parseInstant(value);
  } catch {
    return false;
  }
  const written = WRITTEN_YEAR_AND_HOUR.exec(value);
  return (
    written !== null &&
    Number(written[1]) >= 1 &&
    Number(written[2]) <= 23 &&
    ms >= PYTHON_FIRST_MS &&
    ms <= PYTHON_LAST_MS
  );
}

/** `name` null: the request itself. */
function record(value: unknown, name: string | null): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse(name === null ? 'not an object' : `${name} is not an object`);
  }
  // Checked just above: an object that is not an array, read field by field as unknown.
  return value as Record<string, unknown>;
}

function list(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) refuse(`${name} is not a list`);
  // Checked just above; each item is read as unknown.
  return value as readonly unknown[];
}

function refuse(why: string): never {
  throw new Error(`invalid start request: ${why}`);
}
