import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttStreamState } from '../../shared/capture';
import { CaptureSession } from '../capture/CaptureSession';
import { SttOpenBudget } from '../capture/SttOpenBudget';
import { createLogger, type Logger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import { NETWORK_POLL_MS, type NetworkFollower, NetworkStatus } from './networkStatus';
import {
  type SpeechToText,
  SttEventEmitter,
  type SttEventListener,
  type SttStream,
} from './SpeechToText';
import type { SttUsage } from './usage';

/** A logger whose lines the test reads back, without their time. */
function recordingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    logger: createLogger({
      level: 'info',
      format: 'json',
      sink: (line) => {
        const entry = JSON.parse(line) as Record<string, unknown>;
        delete entry.time;
        lines.push(entry);
      },
    }),
  };
}

function follower(): NetworkFollower & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    suspendStreams: (reason) => {
      calls.push(`suspend:${reason}`);
    },
    resumeStreams: (reason) => {
      calls.push(`resume:${reason}`);
    },
  };
}

describe('NetworkStatus', () => {
  let online: boolean;
  let reads: number;
  let log: ReturnType<typeof recordingLogger>;
  let network: NetworkStatus;

  beforeEach(() => {
    vi.useFakeTimers();
    online = true;
    reads = 0;
    log = recordingLogger();
    network = new NetworkStatus({
      isOnline: () => {
        reads += 1;
        return online;
      },
      logger: log.logger,
    });
  });

  afterEach(() => {
    network.stop();
    vi.useRealTimers();
  });

  it('asks every second, so the session hears the Mac went offline within 1 s', () => {
    const session = follower();
    network.follow(session);
    vi.advanceTimersByTime(2_400); // reads at 0, 1 s and 2 s: online
    expect(session.calls).toEqual([]);

    online = false;
    vi.advanceTimersByTime(NETWORK_POLL_MS - 400); // the 3 s read
    expect(session.calls).toEqual(['suspend:offline']);
    expect(NETWORK_POLL_MS).toBe(1_000);
  });

  it('tells the session once per change, and when the network is back', () => {
    const session = follower();
    network.follow(session);
    online = false;
    vi.advanceTimersByTime(5_000);
    online = true;
    vi.advanceTimersByTime(5_000);

    expect(session.calls).toEqual(['suspend:offline', 'resume:offline']);
    expect(log.lines.map((line) => line.message)).toEqual([
      'network offline: speech-to-text suspended',
      'network back: speech-to-text resumes',
    ]);
  });

  it('reads at once when it starts following: a Mac already offline suspends at once', () => {
    online = false;
    const session = follower();
    network.follow(session);
    expect(session.calls).toEqual(['suspend:offline']);
  });

  it('polls only while it follows a recording', () => {
    network.follow(follower());
    network.stop();
    const before = reads;
    vi.advanceTimersByTime(10_000);
    expect(reads).toBe(before);
  });

  it('follows the next recording from scratch, never the last one', () => {
    const first = follower();
    network.follow(first);
    online = false;
    vi.advanceTimersByTime(1_000);
    network.stop();

    // A new Start: its session opened, so it begins online, whatever the last one heard.
    online = true;
    const second = follower();
    network.follow(second);
    vi.advanceTimersByTime(3_000);
    expect(first.calls).toEqual(['suspend:offline']);
    expect(second.calls).toEqual([]);
  });

  it('keeps its last reading when the check throws, logs it, and goes on polling', () => {
    const session = follower();
    let broken = true;
    network = new NetworkStatus({
      isOnline: () => {
        if (broken) throw new Error('net is not ready');
        return false;
      },
      logger: log.logger,
    });
    network.follow(session);
    vi.advanceTimersByTime(1_000);
    expect(session.calls).toEqual([]);
    expect(log.lines).toContainEqual({
      level: 'error',
      message: 'network check failed',
      error: 'net is not ready',
    });

    broken = false;
    vi.advanceTimersByTime(1_000);
    expect(session.calls).toEqual(['suspend:offline']);
  });

  it('logs a session that throws, and goes on polling', () => {
    const calls: string[] = [];
    network.follow({
      suspendStreams: () => {
        throw new Error('session gone');
      },
      resumeStreams: (reason) => {
        calls.push(`resume:${reason}`);
      },
    });
    online = false;
    vi.advanceTimersByTime(1_000);
    online = true;
    vi.advanceTimersByTime(1_000);

    expect(calls).toEqual(['resume:offline']);
    expect(log.lines).toContainEqual({
      level: 'error',
      message: 'network change not applied',
      online: false,
      error: 'session gone',
    });
  });
});

/** A vendor stream that only records how it was ended. */
class EndedStream implements SttStream {
  private readonly emitter = new SttEventEmitter();
  closed = false;
  terminated = false;
  send(): void {
    // The vendor's side of the audio is not under test here.
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  terminate(): Promise<void> {
    this.terminated = true;
    return this.close();
  }
  on(listener: SttEventListener): () => void {
    return this.emitter.on(listener);
  }
}

class OpenAtOnce implements SpeechToText {
  readonly provider = 'scripted';
  readonly vendorName = 'Scripted';
  readonly credentialUse = 'reusable';
  readonly streams: EndedStream[] = [];
  openStream(): Promise<SttStream> {
    const stream = new EndedStream();
    this.streams.push(stream);
    return Promise.resolve(stream);
  }
  usage(): SttUsage {
    return {
      sessionsOpened: 0,
      connectedMs: 0,
      audioSentMs: 0,
      droppedChunks: 0,
      estimatedCostUsd: 0,
    };
  }
}

describe('NetworkStatus with a live CaptureSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves both sources offline within 1 s, terminating their sockets, and back', async () => {
    const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
    const stt = new OpenAtOnce();
    const states: Record<string, SttStreamState> = {};
    let tokens = 0;
    const budget = new SttOpenBudget({ perMinute: 100, perMeeting: 100 }, () => Date.now());
    budget.beginMeeting();
    const settings = {
      model: 'm',
      language: 'en',
      sampleRate: 16_000,
      encoding: 'linear16',
      pricePerHourUsd: null,
    };
    const session = new CaptureSession({
      meetingId: 'm1',
      meetingStartedAtMs: 0,
      stt,
      accessToken: 't',
      settings,
      refreshCredentials: () => {
        tokens += 1;
        return Promise.resolve({ accessToken: 'fresh', settings });
      },
      reopenBufferMs: 3_000,
      budget,
      reopenBackoffMs: 2_000,
      reopenBackoffMaxMs: 60_000,
      store: new InMemoryTranscriptStore(),
      logger,
      listeners: {
        onSegment: () => undefined,
        onInterim: () => undefined,
        onStreamState: (source, state) => {
          states[source] = state;
        },
        onStreamFailure: () => undefined,
        onSaveFailure: () => undefined,
        onStreamClosed: () => undefined,
      },
    });
    await session.open();
    vi.useFakeTimers();
    let online = true;
    const network = new NetworkStatus({ isOnline: () => online, logger });
    network.follow(session);

    online = false;
    vi.advanceTimersByTime(NETWORK_POLL_MS);
    expect(states).toEqual({ mic: 'offline', system: 'offline' });
    expect(stt.streams.map((stream) => stream.terminated)).toEqual([true, true]);

    online = true;
    vi.advanceTimersByTime(NETWORK_POLL_MS);
    expect(states).toEqual({ mic: 'paused', system: 'paused' });
    network.stop();
    vi.useRealTimers();
    expect(tokens).toBe(0); // nothing reopens before its next chunk
    await session.close();
  });
});
