import { describe, expect, it } from 'vitest';
import { isSourceStateMessage, MAX_AUDIO_CHUNK_BYTES, parseAudioChunk } from './ipc-validation';

describe('parseAudioChunk', () => {
  it('accepts an ArrayBuffer or a view of even length from a known source', () => {
    expect(parseAudioChunk({ source: 'mic', pcm: new ArrayBuffer(3200) })?.pcm.byteLength).toBe(
      3200,
    );
    const view = new Uint8Array(new ArrayBuffer(10), 2, 4);
    expect(parseAudioChunk({ source: 'system', pcm: view })?.pcm.byteLength).toBe(4);
  });

  it('rejects odd lengths, empty chunks, oversized chunks, unknown sources and junk', () => {
    expect(parseAudioChunk({ source: 'mic', pcm: new ArrayBuffer(3201) })).toBeNull();
    expect(parseAudioChunk({ source: 'mic', pcm: new ArrayBuffer(0) })).toBeNull();
    expect(
      parseAudioChunk({ source: 'mic', pcm: new ArrayBuffer(MAX_AUDIO_CHUNK_BYTES + 2) }),
    ).toBeNull();
    expect(parseAudioChunk({ source: 'speaker', pcm: new ArrayBuffer(2) })).toBeNull();
    expect(parseAudioChunk({ source: 'mic', pcm: 'nope' })).toBeNull();
    expect(parseAudioChunk(null)).toBeNull();
  });
});

describe('isSourceStateMessage', () => {
  it('checks source, state and the optional message', () => {
    expect(isSourceStateMessage({ source: 'mic', state: 'active' })).toBe(true);
    expect(isSourceStateMessage({ source: 'system', state: 'error', message: 'denied' })).toBe(
      true,
    );
    expect(isSourceStateMessage({ source: 'system', state: 'paused' })).toBe(false);
    expect(isSourceStateMessage({ source: 'mic', state: 'active', message: 5 })).toBe(false);
  });
});
