import type { AudioSourceStateMessage } from '../shared/ipc';
import { isAudioSource, type AudioSource } from '../shared/transcript';

/** Renderer payloads are untrusted input: validated here, without any Electron import so tests run under Node. */

/** 100 ms chunks are 3200 bytes; anything near a megabyte is not audio from our worklet. */
export const MAX_AUDIO_CHUNK_BYTES = 1_048_576;

export interface ParsedAudioChunk {
  source: AudioSource;
  pcm: Uint8Array;
}

export function parseAudioChunk(message: unknown): ParsedAudioChunk | null {
  if (typeof message !== 'object' || message === null) return null;
  const { source, pcm } = message as { source?: unknown; pcm?: unknown };
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
  return { source, pcm: bytes };
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
