import { describe, expect, it, vi } from 'vitest';
import type { CaptureStatus } from '../../shared/capture';
import type { TranscriptSegment } from '../../shared/transcript';
import type { MeetingDto, SttTokenApi, UploadApi } from '../api/ApiClient';
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

function meetingDto(id: string): MeetingDto {
  return {
    id,
    workspace_id: 'w1',
    title: 'T',
    status: 'recording',
    started_at: '2026-10-05T10:00:00Z',
    ended_at: null,
    segment_count: 0,
    created_at: '2026-10-05T10:00:00Z',
    updated_at: '2026-10-05T10:00:00Z',
  };
}

/** A speech-to-text double the test drives by hand. */
class ScriptedStream implements SttStream {
  readonly emitter = new SttEventEmitter();
  readonly sent: Uint8Array[] = [];
  closed = false;
  /** Emitted while closing, like a vendor flushing its last final after CloseStream. */
  finalOnClose: string | null = null;
  send(pcm: Uint8Array): void {
    this.sent.push(pcm);
  }
  close(): Promise<void> {
    if (this.finalOnClose !== null) {
      this.emitter.emit({
        type: 'final',
        text: this.finalOnClose,
        startMs: 0,
        endMs: 100,
        confidence: 1,
        words: [],
      });
    }
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
  /** Applied to every stream this double opens. */
  finalOnClose: string | null = null;
  openStream(options: OpenStreamOptions): Promise<SttStream> {
    this.opened.push(options);
    if (this.failWith) return Promise.reject(this.failWith);
    const stream = new ScriptedStream();
    stream.finalOnClose = this.finalOnClose;
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
  // Typed by the narrow views the services take (SttTokenApi, UploadApi), so no cast is needed.
  const api = {
    getSttToken: vi.fn<SttTokenApi['getSttToken']>().mockResolvedValue({
      provider: 'scripted',
      access_token: 'tok',
      expires_in: 30,
      stream: { model: 'm', language: 'en', sample_rate: 16000, encoding: 'linear16' },
    }),
    createMeeting: vi.fn<UploadApi['createMeeting']>((input) =>
      Promise.resolve(meetingDto(input.id)),
    ),
    appendSegments: vi.fn<UploadApi['appendSegments']>((_meetingId, segments) =>
      Promise.resolve({ accepted: segments.length, duplicates: 0 }),
    ),
    endMeeting: vi.fn<UploadApi['endMeeting']>((meetingId) =>
      Promise.resolve(meetingDto(meetingId)),
    ),
  };
  const stt = new ScriptedSpeechToText();
  const uploader = new TranscriptUploader({ store, api, logger });
  let now = 1_000_000;
  const service = new CaptureService({
    store,
    api,
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
      // The 100 ms chunk arrived 2.0 s in, so its audio started at 1.9 s; vendor offsets add to that.
      startMs: 2400,
      endMs: 3100,
    });
    expect(h.segments[0]?.words?.[0]).toMatchObject({ startMs: 2400, endMs: 2600 });
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

  it('stores finals that arrive while closing before the meeting is ended, and stop() waits for a start in flight', async () => {
    const h = harness();
    h.stt.finalOnClose = 'last words';
    const starting = h.service.start();
    const stopping = h.service.stop(); // queued behind start
    await starting;
    const stopped = await stopping;
    expect(stopped.phase).toBe('idle');
    // One final per stream, both emitted during close, both stored and uploaded before the meeting ends.
    expect(h.segments.map((s) => s.text)).toEqual(['last words', 'last words']);
    const batches = h.api.appendSegments.mock.calls.map((call) => call[1].map((s) => s.text));
    expect(batches).toEqual([['last words', 'last words']]);
    expect(h.api.endMeeting).toHaveBeenCalledTimes(1);
    expect(h.api.appendSegments.mock.invocationCallOrder[0]!).toBeLessThan(
      h.api.endMeeting.mock.invocationCallOrder[0]!,
    );
  });

  it('leaves no empty meeting behind when nothing was said and Postgres never heard of it', async () => {
    const h = harness();
    await h.service.start();
    await h.service.stop();
    expect(h.store.meetings.size).toBe(0);
    expect(h.api.createMeeting).not.toHaveBeenCalled();
    expect(h.api.endMeeting).not.toHaveBeenCalled();
  });

  it('surfaces a stream that dies mid-call as an error the user can read', async () => {
    const h = harness();
    await h.service.start();
    h.stt.streams.get('system')!.emitter.emit({ type: 'closed', code: 1011, reason: 'timeout' });
    const status = h.service.getStatus();
    expect(status.phase).toBe('recording');
    expect(status.streams.system).toBe('error');
    expect(status.error).toContain('Transcription of Them (them) stopped');
    expect(status.error).toContain('code 1011');
    await h.service.stop();
  });

  it('returns to idle with an error and no stray meeting when speech-to-text cannot connect', async () => {
    const h = harness();
    h.stt.failWith = new SttConnectError('rejected with HTTP 401', 401);
    const status = await h.service.start();
    expect(status.phase).toBe('idle');
    expect(status.error).toContain('401');
    expect(h.store.meetings.size).toBe(0);
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

  it('refuses to start when the API asks for audio the renderer does not send', async () => {
    const h = harness();
    h.api.getSttToken.mockResolvedValueOnce({
      provider: 'scripted',
      access_token: 'tok',
      expires_in: 30,
      stream: { model: 'm', language: 'en', sample_rate: 48000, encoding: 'linear16' },
    });
    const status = await h.service.start();
    expect(status.phase).toBe('idle');
    expect(status.error).toContain('48000 Hz');
    expect(status.error).toContain('16000 Hz');
    expect(h.stt.opened).toHaveLength(0);
    expect(h.store.meetings.size).toBe(0);
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
