import { describe, expect, it } from 'vitest';
import { type CaptureStatus, idleCaptureStatus } from '../src/shared/capture';
import { IpcChannel } from '../src/shared/ipc';
import { createFakeRoger, featureFakes } from './fakeRoger';
import { FakeHub } from './fakes/hub';

const IDLE_FIELDS = Object.keys(
  idleCaptureStatus({
    state: 'idle',
    pending: 0,
    rejected: 0,
    lastError: null,
    nextAttemptAt: null,
  }),
).sort();

describe('the preview fake of window.roger', () => {
  // The preload spreads the bridges the same way: a member two features share would silently
  // replace the other feature's there too, so this test guards both.
  it('gives every feature its own member names', () => {
    const owners = new Map<string, string[]>();
    for (const [feature, create] of Object.entries(featureFakes)) {
      for (const member of Object.keys(create(new FakeHub()))) {
        owners.set(member, [...(owners.get(member) ?? []), feature]);
      }
    }
    expect([...owners].filter(([, features]) => features.length > 1)).toEqual([]);
    expect(Object.keys(createFakeRoger(new FakeHub())).sort()).toEqual([...owners.keys()].sort());
  });

  it('builds every capture status from idleCaptureStatus, with every landed field', async () => {
    const roger = createFakeRoger(new FakeHub());
    const seen: CaptureStatus[] = [];
    roger.onCaptureStatus((status) => seen.push(status));

    const idle = await roger.getCaptureStatus();
    const recording = await roger.startCapture();
    const stopped = await roger.stopCapture();

    for (const status of [idle, recording, stopped]) {
      expect(Object.keys(status).sort()).toEqual(IDLE_FIELDS);
    }
    expect(recording).toMatchObject({
      phase: 'recording',
      streams: { mic: 'open', system: 'open' },
    });
    expect(stopped.phase).toBe('idle');
    expect(seen).toEqual([recording, stopped]);
  });

  it('answers getCaptureStatus with the status a scenario last sent', async () => {
    const hub = new FakeHub();
    const roger = createFakeRoger(hub);
    const pushed: CaptureStatus = {
      ...idleCaptureStatus({
        state: 'backoff',
        pending: 12,
        rejected: 0,
        lastError: 'offline',
        nextAttemptAt: 0,
      }),
      notice: 'Stopped: no speech for 15 minutes.',
    };
    hub.emit(IpcChannel.CaptureStatusChanged, pushed);
    await expect(roger.getCaptureStatus()).resolves.toEqual(pushed);
  });
});

describe('FakeHub', () => {
  it('fails only the next request, as a failed ipcRenderer.invoke rejects', async () => {
    const hub = new FakeHub();
    const roger = createFakeRoger(hub);
    hub.failNextRequest('the API is offline');
    await expect(roger.startCapture()).rejects.toThrow(
      "Error invoking remote method 'capture:start': Error: the API is offline",
    );
    await expect(roger.startCapture()).resolves.toMatchObject({ phase: 'recording' });
  });

  it('delivers an event to each listener until that listener unsubscribes', () => {
    const hub = new FakeHub();
    const first: unknown[] = [];
    const second: unknown[] = [];
    const stopFirst = hub.on('transcript:segment', (payload: unknown) => first.push(payload));
    hub.on('transcript:segment', (payload: unknown) => second.push(payload));
    hub.emit('transcript:segment', 'one');
    stopFirst();
    hub.emit('transcript:segment', 'two');
    expect(first).toEqual(['one']);
    expect(second).toEqual(['one', 'two']);
  });
});
