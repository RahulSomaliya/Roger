import { describe, expect, it } from 'vitest';
import { FakeSpeechToText } from './FakeSpeechToText';

const settings = {
  model: 'fake',
  language: 'en',
  sampleRate: 16000,
  encoding: 'linear16',
  pricePerHourUsd: 0,
};

describe('FakeSpeechToText', () => {
  it('meters its streams like a vendor, per source and in total, at no cost', async () => {
    let now = 0;
    const stt = new FakeSpeechToText({ clock: () => now });
    const mic = await stt.openStream({ accessToken: '', settings, label: 'mic' });
    await stt.openStream({ accessToken: '', settings, label: 'system' });
    mic.send(new Uint8Array(3200));
    now = 30_000;
    await mic.close();
    now = 45_000;

    expect(stt.vendorName).toBe('Fake');
    expect(stt.usage('mic')).toEqual({
      sessionsOpened: 1,
      connectedMs: 30_000,
      audioSentMs: 100,
      droppedChunks: 0,
      estimatedCostUsd: 0,
    });
    expect(stt.usage()).toMatchObject({ sessionsOpened: 2, connectedMs: 75_000 });
  });
});
