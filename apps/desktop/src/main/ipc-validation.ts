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
 * How far a chunk's capture time may be from main's clock. Renderer and main read the same wall
 * clock, so real chunks are milliseconds off; a time further than this is junk or a forged
 * payload, and would put the chunk's lines hours away on the meeting timeline.
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
  // that sends one is broken or not ours, and its audio cannot be placed on the timeline either.
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
