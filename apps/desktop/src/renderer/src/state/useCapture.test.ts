import { describe, expect, it, vi } from 'vitest';
import {
  type CaptureStatus,
  idleCaptureStatus,
  type StartCaptureRequest,
} from '../../../shared/capture';
import { lastNamedMeeting, runStartRequests, type StartRequestsApi } from './useCapture';

const STANDUP: StartCaptureRequest = { source: 'notification', title: 'Standup' };

/** Main's side, as CaptureService answers it: one waiting request, taken once. */
function fakeMain(waiting: StartCaptureRequest | null = null) {
  let pending = waiting;
  const listeners = new Set<() => void>();
  const api: StartRequestsApi = {
    onStartRequested: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    takePendingStart: () => {
      const request = pending;
      pending = null;
      return Promise.resolve(request);
    },
  };
  return {
    api,
    listeners,
    /** CaptureService.requestStart: the request waits, and the page hears the nudge. */
    requestStart: (request: StartCaptureRequest) => {
      pending = request;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('runStartRequests', () => {
  it('starts the request that waited while the page loaded, once, however many mounts ask', async () => {
    const main = fakeMain(STANDUP);
    const start = vi.fn(() => Promise.resolve());
    const failed = vi.fn();
    // React's development mode mounts an effect twice: both ask, one gets the request.
    runStartRequests(main.api, start, failed)();
    runStartRequests(main.api, start, failed);
    await settle();
    expect(start.mock.calls).toEqual([[STANDUP]]);
    expect(failed).not.toHaveBeenCalled();
  });

  it('starts each request main announces later, and none once it stops listening', async () => {
    const main = fakeMain();
    const start = vi.fn(() => Promise.resolve());
    const stop = runStartRequests(main.api, start, vi.fn());
    await settle();
    expect(start).not.toHaveBeenCalled(); // nothing waited

    main.requestStart(STANDUP);
    await settle();
    expect(start.mock.calls).toEqual([[STANDUP]]);

    stop();
    expect(main.listeners.size).toBe(0);
    main.requestStart({ source: 'call_detected' });
    await settle();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('hands a take or a start that fails to the error handler, never to an unhandled rejection', async () => {
    const main = fakeMain(STANDUP);
    const failed = vi.fn();
    runStartRequests(main.api, () => Promise.reject(new Error('microphone denied')), failed);
    await settle();
    main.api.takePendingStart = () => Promise.reject(new Error('No handler registered'));
    main.requestStart(STANDUP);
    await settle();
    expect(failed.mock.calls).toEqual([
      [new Error('microphone denied')],
      [new Error('No handler registered')],
    ]);
  });
});

describe('lastNamedMeeting', () => {
  const X = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';
  const Y = '9b2e6f10-7c4d-4a5b-8e3f-61a0c2d9e874';
  const idle = idleCaptureStatus({
    state: 'idle',
    pending: 0,
    rejected: 0,
    lastError: null,
    nextAttemptAt: null,
  });
  const named = (meetingId: string, phase: CaptureStatus['phase']): CaptureStatus => ({
    ...idle,
    phase,
    meetingId,
    startedAt: '2026-10-07T09:00:00.000Z',
  });

  it('is null until main names a meeting', () => {
    expect(lastNamedMeeting(null, idle)).toBeNull();
    expect(lastNamedMeeting(null, { ...idle, phase: 'starting' })).toBeNull();
  });

  it('takes the meeting a status names, and keeps it while statuses name none', () => {
    const recording = lastNamedMeeting(null, named(X, 'recording'));
    expect(recording).toBe(X);
    expect(lastNamedMeeting(recording, named(X, 'stopping'))).toBe(X);
    // After Stop, and while the next recording starts, main names no meeting.
    expect(lastNamedMeeting(recording, idle)).toBe(X);
    expect(lastNamedMeeting(recording, { ...idle, phase: 'starting' })).toBe(X);
  });

  it('moves to the next meeting once main names it', () => {
    expect(lastNamedMeeting(X, named(Y, 'recording'))).toBe(Y);
  });
});
