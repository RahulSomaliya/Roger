import { describe, expect, it, vi } from 'vitest';
import type { CaptureStatus } from '../../shared/capture';
import type { TranscriptSegment } from '../../shared/transcript';
import type { ApiClient } from '../api/ApiClient';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import {
  type OpenStreamOptions,
  type SpeechToText,
  SttConnectError,
  SttEventEmitter,
  type SttEventListener,
  type SttStream,
} from '../stt/SpeechToText';
import { TranscriptUploader } from '../upload/TranscriptUploader';
import { CaptureService, defaultMeetingTitle } from './CaptureService';

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

/** A speech-to-text double the test drives by hand. */
class ScriptedStream implements SttStream {
  readonly emitter = new SttEventEmitter();
  readonly sent: Uint8Array[] = [];
  closed = false;
  send(pcm: Uint8Array): void {
    this.sent.push(pcm);
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  on(listener: SttEventListener): () => void {
    return this.emitter.on(listener);
  }
}

class ScriptedSpeechToText implements SpeechToText {
  readonly provider = 'scripted';
  readonly streams = new Map<string, ScriptedStream>();
  readonly opened: OpenStreamOptions[] = [];
  failWith: Error | null = null;
  openStream(options: OpenStreamOptions): Promise<SttStream> {
    this.opened.push(options);
    if (this.failWith) return Promise.reject(this.failWith);
    const stream = new ScriptedStream();
    this.streams.set(options.label, stream);
    return Promise.resolve(stream);
  }
}

function harness(
  overrides: {
    startupError?: string | null;
    override?: string | null;
    mic?: 'granted' | 'denied';
  } = {},
) {
  const store = new InMemoryTranscriptStore();
  const api = {
    getSttToken: vi.fn().mockResolvedValue({
      provider: 'scripted',
      access_token: 'tok',
      expires_in: 30,
      stream: { model: 'm', language: 'en', sample_rate: 16000, encoding: 'linear16' },
    }),
    createMeeting: vi.fn().mockResolvedValue({}),
    appendSegments: vi.fn().mockResolvedValue({ accepted: 1, duplicates: 0 }),
    endMeeting: vi.fn().mockResolvedValue({}),
  };
  const stt = new ScriptedSpeechToText();
  const uploader = new TranscriptUploader({ store, api: api as unknown as ApiClient, logger });
  let now = 1_000_000;
  const service = new CaptureService({
    store,
    api: api as unknown as ApiClient,
    uploader,
    createSpeechToText: () => stt,
    ensureMicrophoneAccess: () => Promise.resolve(overrides.mic ?? 'granted'),
    logger,
    sttProviderOverride: overrides.override ?? null,
    startupError: overrides.startupError ?? null,
    clock: () => now,
  });
  const statuses: CaptureStatus[] = [];
  const segments: TranscriptSegment[] = [];
  service.on('status', (status) => statuses.push(status));
  service.on('segment', (segment) => segments.push(segment));
  return { store, api, stt, service, statuses, segments, advance: (ms: number) => (now += ms) };
}

describe('CaptureService', () => {
  it('runs a full session: start, audio, final line stored and uploaded, stop', async () => {
    const h = harness();
    const started = await h.service.start();
    expect(started.phase).toBe('recording');
    expect(started.streams).toEqual({ mic: 'open', system: 'open' });
    expect(h.api.getSttToken).toHaveBeenCalledTimes(1);
    expect(h.stt.opened.map((o) => o.label).sort()).toEqual(['mic', 'system']);
    expect(h.stt.opened[0]?.accessToken).toBe('tok');

    h.advance(2_000);
    h.service.pushAudio('system', new Uint8Array(3200));
    expect(h.stt.streams.get('system')?.sent).toHaveLength(1);
    expect(h.service.getStatus().sources.system).toMatchObject({ health: 'active', chunks: 1 });

    h.stt.streams.get('system')?.emitter.emit({
      type: 'final',
      text: 'Hi Rahul',
      startMs: 500,
      endMs: 1200,
      confidence: 0.9,
      words: [{ text: 'Hi', startMs: 500, endMs: 700, confidence: 0.9 }],
    });
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0]).toMatchObject({
      source: 'system',
      speaker: 'them',
      text: 'Hi Rahul',
      startMs: 2500,
      endMs: 3200,
    });
    expect(h.segments[0]?.words?.[0]).toMatchObject({ startMs: 2500, endMs: 2700 });
    expect(h.store.countUnsyncedSegments()).toBe(1);
    expect(h.service.getStatus().segmentsStored).toBe(1);

    const stopped = await h.service.stop();
    expect(stopped.phase).toBe('idle');
    expect(h.stt.streams.get('mic')?.closed).toBe(true);
    expect(h.api.createMeeting).toHaveBeenCalledTimes(1);
    expect(h.api.appendSegments).toHaveBeenCalledTimes(1);
    expect(h.api.endMeeting).toHaveBeenCalledTimes(1);
    expect(h.store.listMeetingsNeedingSync()).toEqual([]);
    expect(h.statuses.map((s) => s.phase)).toEqual(
      expect.arrayContaining(['starting', 'recording', 'stopping', 'idle']),
    );
  });

  it('returns to idle with an error and no stray meeting when speech-to-text cannot connect', async () => {
    const h = harness();
    h.stt.failWith = new SttConnectError('rejected with HTTP 401', 401);
    const status = await h.service.start();
    expect(status.phase).toBe('idle');
    expect(status.error).toContain('401');
    expect(h.store.listMeetingsNeedingSync()).toEqual([]);
    expect(h.api.createMeeting).not.toHaveBeenCalled();
  });

  it('refuses to start without microphone access or with a startup configuration error', async () => {
    const denied = harness({ mic: 'denied' });
    expect((await denied.service.start()).error).toContain('Microphone access is denied');
    const misconfigured = harness({ startupError: 'No API token' });
    expect(await misconfigured.service.start()).toMatchObject({
      phase: 'idle',
      error: 'No API token',
    });
    expect(misconfigured.api.getSttToken).not.toHaveBeenCalled();
  });

  it('uses the fake adapter without asking the API for a token when overridden', async () => {
    const h = harness({ override: 'fake' });
    const status = await h.service.start();
    expect(status.phase).toBe('recording');
    expect(status.sttProvider).toBe('fake');
    expect(h.api.getSttToken).not.toHaveBeenCalled();
    await h.service.stop();
  });

  it('ignores audio and duplicate transitions outside of recording', async () => {
    const h = harness();
    h.service.pushAudio('mic', new Uint8Array(10));
    expect((await h.service.stop()).phase).toBe('idle');
    const [a, b] = await Promise.all([h.service.start(), h.service.start()]);
    expect(a.phase).toBe('recording');
    expect(b.phase).toBe('recording');
    expect(h.stt.opened).toHaveLength(2);
    await h.service.stop();
  });
});

describe('defaultMeetingTitle', () => {
  it('names a meeting after its start time', () => {
    expect(defaultMeetingTitle(new Date('2026-10-05T10:05:00Z'))).toMatch(
      /^Meeting 5 Oct 2026 \d\d:\d\d$/,
    );
  });
});
