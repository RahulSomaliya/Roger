import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger';
import { AssemblyAiSpeechToText } from './assemblyai/AssemblyAiSpeechToText';
import { createSpeechToText, UnsupportedSttProviderError } from './createSpeechToText';
import { DeepgramSpeechToText } from './deepgram/DeepgramSpeechToText';
import { FakeSpeechToText } from './fake/FakeSpeechToText';

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

describe('createSpeechToText', () => {
  it.each([
    ['assemblyai', AssemblyAiSpeechToText],
    ['deepgram', DeepgramSpeechToText],
    ['fake', FakeSpeechToText],
  ])('picks the %s adapter for the provider the API names', (provider, adapter) => {
    const stt = createSpeechToText(provider, { logger });
    expect(stt).toBeInstanceOf(adapter);
    expect(stt.provider).toBe(provider);
  });

  it('refuses a provider it has no adapter for', () => {
    expect(() => createSpeechToText('whisper', { logger })).toThrow(UnsupportedSttProviderError);
  });

  it('refuses a provider id that only looks like a key of a plain object', () => {
    expect(() => createSpeechToText('constructor', { logger })).toThrow(
      UnsupportedSttProviderError,
    );
  });
});
