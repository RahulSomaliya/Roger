/**
 * The JSON lines `roger-audio` writes on stderr, one object per line, "event" first: `HelperEvent`
 * in native/roger-audio/Protocol.swift, which is the contract (test/fixtures/fake-roger-audio.mjs
 * mimics it). `tap` sends all five; `monitor` and `probe` send `warning` and `error` here too.
 * Change the three files together.
 */

/** The PCM `tap` writes to stdout, as its `ready` announces it. */
export interface HelperAudioFormat {
  /** `linear16`: Int16 little endian. */
  encoding: string;
  sampleRate: number;
  channels: number;
  chunkMs: number;
}

/** What Core Audio delivers into the tap before the helper converts it; for the log. */
export interface TapFormat {
  sampleRate: number;
  channels: number;
}

/**
 * Why the helper rebuilt its tap (`RestartReason` in Protocol.swift). Kept as text: a newer helper
 * may add one, and a rebuild with an unknown reason is still a rebuild.
 * - output_device_changed: the default output changed (AirPods, speakers picked)
 * - tap_format_changed: the tap's format changed, typically after a route change
 * - rebuild_requested: main wrote `rebuild` (TapSystemAudio does, while system audio is unverified)
 */
export type TapRestartReason = string;

export type HelperEvent =
  /** Once per run, when the tap runs: `format` is what stdout carries. */
  | { event: 'ready'; format: HelperAudioFormat; tapFormat: TapFormat }
  | { event: 'restarted'; reason: TapRestartReason; tapFormat: TapFormat }
  /**
   * Every second, about the second since the last: `peak` the largest |sample| written (0 is
   * digital silence), `frames` the frames written, `dropped` the ms of audio its ring dropped.
   */
  | { event: 'stats'; peak: number; frames: number; dropped: number }
  /** Something degraded; the helper carries on. */
  | { event: 'warning'; code: string; message: string }
  /** The helper is about to exit with a failure; `status` is the Core Audio OSStatus, if any. */
  | { event: 'error'; code: string; message: string; status: number | null };

export type ParsedHelperLine =
  | { kind: 'event'; event: HelperEvent }
  /** A well-formed event this main does not know (a newer helper): passed over. */
  | { kind: 'unknown'; name: string }
  /** Not an event: the reason is for the log. */
  | { kind: 'malformed'; reason: string };

class Malformed extends Error {}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads one field, so each refusal names the field that broke. */
function field<T>(
  object: JsonObject,
  path: string,
  key: string,
  accepts: (value: unknown) => value is T,
  what: string,
): T {
  const value = object[key];
  if (!accepts(value)) throw new Malformed(`"${path}${key}" is not ${what}`);
  return value;
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === 'string';

const number = (object: JsonObject, key: string, path = ''): number =>
  field(object, path, key, isNumber, 'a number');
const text = (object: JsonObject, key: string, path = ''): string =>
  field(object, path, key, isString, 'a string');
const objectAt = (object: JsonObject, key: string): JsonObject =>
  field(object, '', key, isObject, 'an object');

function tapFormat(object: JsonObject): TapFormat {
  const format = objectAt(object, 'tapFormat');
  return {
    sampleRate: number(format, 'sampleRate', 'tapFormat.'),
    channels: number(format, 'channels', 'tapFormat.'),
  };
}

function readEvent(name: string, object: JsonObject): HelperEvent | null {
  switch (name) {
    case 'ready': {
      const format = objectAt(object, 'format');
      return {
        event: 'ready',
        format: {
          encoding: text(format, 'encoding', 'format.'),
          sampleRate: number(format, 'sampleRate', 'format.'),
          channels: number(format, 'channels', 'format.'),
          chunkMs: number(format, 'chunkMs', 'format.'),
        },
        tapFormat: tapFormat(object),
      };
    }
    case 'restarted':
      return { event: 'restarted', reason: text(object, 'reason'), tapFormat: tapFormat(object) };
    case 'stats':
      return {
        event: 'stats',
        peak: number(object, 'peak'),
        frames: number(object, 'frames'),
        dropped: number(object, 'dropped'),
      };
    case 'warning':
      return { event: 'warning', code: text(object, 'code'), message: text(object, 'message') };
    case 'error': {
      const status = object.status;
      return {
        event: 'error',
        code: text(object, 'code'),
        message: text(object, 'message'),
        status: isNumber(status) ? status : null,
      };
    }
    default:
      return null;
  }
}

/** Reads one stderr line of the helper. */
export function parseHelperEvent(line: string): ParsedHelperLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A crash report or a stray print, not an event. The line itself goes to no log from here.
    return { kind: 'malformed', reason: 'not a JSON object' };
  }
  if (!isObject(parsed)) return { kind: 'malformed', reason: 'not a JSON object' };
  const name = parsed.event;
  if (typeof name !== 'string') return { kind: 'malformed', reason: 'no "event" name' };
  try {
    const event = readEvent(name, parsed);
    return event === null ? { kind: 'unknown', name } : { kind: 'event', event };
  } catch (error) {
    if (error instanceof Malformed)
      return { kind: 'malformed', reason: `${name}: ${error.message}` };
    throw error;
  }
}
