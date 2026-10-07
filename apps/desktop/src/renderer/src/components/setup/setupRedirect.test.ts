import { describe, expect, it, vi } from 'vitest';
import type { MediaAccessState, SetupStatus } from '../../../../shared/ipc/setup';
import { SetupRedirect } from './setupRedirect';
import { readyMac } from './setupTesting';

/** CaptureService's refusal at Start (the arrows are its own). */
const REFUSED =
  'Microphone access is denied. Allow Roger under System Settings \u2192 Privacy & Security \u2192 Microphone.';

function withMicrophone(state: MediaAccessState): SetupStatus {
  return { ...readyMac(), microphone: { state, message: null, relaunchNeeded: false } };
}

function harness(state: MediaAccessState) {
  const getStatus = vi.fn(() => Promise.resolve(withMicrophone(state)));
  const open = vi.fn();
  return { redirect: new SetupRedirect(getStatus), getStatus, open };
}

describe('SetupRedirect.firstRun', () => {
  it('opens setup on a Mac where Roger never asked for the microphone', async () => {
    const { redirect, open } = harness('not-determined');
    await redirect.firstRun(open);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('leaves a Mac that answered alone, whatever the answer', async () => {
    for (const state of ['granted', 'denied', 'restricted', 'unknown'] as const) {
      const { redirect, open } = harness(state);
      await redirect.firstRun(open);
      expect(open).not.toHaveBeenCalled();
    }
  });

  it('asks once per page load: StrictMode runs effects twice, and Done must stay done', async () => {
    const { redirect, open, getStatus } = harness('not-determined');
    await Promise.all([redirect.firstRun(open), redirect.firstRun(open)]);
    await redirect.firstRun(open);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('SetupRedirect.captureError', () => {
  it('opens setup when a Start fails while the microphone is refused or blocked', async () => {
    for (const state of ['denied', 'restricted'] as const) {
      const { redirect, open } = harness(state);
      await redirect.captureError(null, open);
      await redirect.captureError(REFUSED, open);
      expect(open).toHaveBeenCalledTimes(1);
    }
  });

  it('leaves other failures to the banner: the microphone is not why', async () => {
    const { redirect, open } = harness('granted');
    await redirect.captureError('POST /v1/stt/token failed: connect ECONNREFUSED', open);
    expect(open).not.toHaveBeenCalled();
  });

  it('acts only when the error turns non-null, not on every status that still carries it', async () => {
    const { redirect, open, getStatus } = harness('denied');
    await redirect.captureError(REFUSED, open);
    await redirect.captureError(REFUSED, open);
    await redirect.captureError(
      'Mic stopped: the audio track ended. Press Stop, then Start again.',
      open,
    );
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    await redirect.captureError(null, open);
    await redirect.captureError(REFUSED, open);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('passes a failed status read to its caller, which shows it', async () => {
    const redirect = new SetupRedirect(() =>
      Promise.reject(new Error('no handler for setup:get-status')),
    );
    await expect(redirect.captureError(REFUSED, vi.fn())).rejects.toThrow('no handler');
  });
});
