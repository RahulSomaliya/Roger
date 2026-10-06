import { describe, expect, it } from 'vitest';
import { PCM_ENCODING, PCM_SAMPLE_RATE } from '../../shared/ipc';
import type { SttStreamSettings } from './SpeechToText';
import { streamSettingsMismatch } from './streamSettings';

const settings = (overrides: Partial<SttStreamSettings>): SttStreamSettings => ({
  model: 'nova-3',
  language: 'en',
  sampleRate: PCM_SAMPLE_RATE,
  encoding: PCM_ENCODING,
  ...overrides,
});

describe('streamSettingsMismatch', () => {
  it('accepts the format the renderer captures', () => {
    expect(PCM_SAMPLE_RATE).toBe(16_000);
    expect(PCM_ENCODING).toBe('linear16');
    expect(streamSettingsMismatch(settings({}))).toBeNull();
  });

  it('accepts what the API returns for AssemblyAI (it maps linear16 to pcm_s16le itself)', () => {
    expect(
      streamSettingsMismatch({
        model: 'universal-streaming-english',
        language: 'en',
        sampleRate: 16_000,
        encoding: 'linear16',
      }),
    ).toBeNull();
  });

  it('names both values when the API asks for another sample rate', () => {
    const message = streamSettingsMismatch(settings({ sampleRate: 48_000 }));
    expect(message).toContain('48000 Hz');
    expect(message).toContain('16000 Hz');
    expect(message).toContain('STT_SAMPLE_RATE=16000');
  });

  it('names both values when the API asks for another encoding', () => {
    const message = streamSettingsMismatch(settings({ encoding: 'opus' }));
    expect(message).toContain('opus');
    expect(message).toContain('linear16');
    expect(message).toContain('STT_ENCODING=linear16');
  });
});
