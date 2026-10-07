import { describe, expect, it, vi } from 'vitest';
import type { CapturePhase } from '../../../../shared/capture';
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

/** What the banner reads of the capture view: main's error and phase, and whether a press runs. */
function view(error: string | null, busy: boolean, phase: CapturePhase | null = 'idle') {
  return { error, busy, phase };
}

describe('SetupRedirect.captureChanged', () => {
  it('opens setup when a Start fails while the microphone is refused or blocked', async () => {
    for (const state of ['denied', 'restricted'] as const) {
      const { redirect, open } = harness(state);
      await redirect.captureChanged(view(null, false), open);
      await redirect.captureChanged(view(null, true), open);
      await redirect.captureChanged(view(REFUSED, false), open);
      expect(open).toHaveBeenCalledTimes(1);
    }
  });

  it('leaves other failures to the banner: the microphone is not why', async () => {
    const { redirect, open } = harness('granted');
    await redirect.captureChanged(
      view('POST /v1/stt/token failed: connect ECONNREFUSED', false),
      open,
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('acts only when the error turns non-null, not on every status that still carries it', async () => {
    const { redirect, open, getStatus } = harness('denied');
    await redirect.captureChanged(view(REFUSED, false), open);
    await redirect.captureChanged(view(REFUSED, false), open);
    await redirect.captureChanged(
      view('Mic stopped: the audio track ended. Press Stop, then Start again.', false, 'recording'),
      open,
    );
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    await redirect.captureChanged(view(null, false), open);
    await redirect.captureChanged(view(REFUSED, false), open);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('opens setup again when the next Start is refused in the same words', async () => {
    // Main sends `starting` (error null) and the refusal back to back (CaptureService.doStart), and
    // React draws both in one render: the page sees the old refusal turn into the same text, and
    // only the press itself (`busy`) says a new Start ran.
    const { redirect, open } = harness('denied');
    await redirect.captureChanged(view(null, true), open);
    await redirect.captureChanged(view(REFUSED, false), open);
    expect(open).toHaveBeenCalledTimes(1);
    // Done, then New note, without turning the microphone on.
    await redirect.captureChanged(view(REFUSED, true), open);
    await redirect.captureChanged(view(REFUSED, false), open);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('waits for the Start to end before it reads the error', async () => {
    const { redirect, open, getStatus } = harness('denied');
    await redirect.captureChanged(view(null, true), open);
    // The refusal's status can come before the Start's own answer clears `busy`.
    await redirect.captureChanged(view(REFUSED, true), open);
    expect(getStatus).not.toHaveBeenCalled();
    await redirect.captureChanged(view(REFUSED, false), open);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('takes no Stop for a new Start: the recording error it ends with was already seen', async () => {
    const { redirect, open, getStatus } = harness('denied');
    const stopped = 'Mic stopped: the audio track ended. Press Stop, then Start again.';
    await redirect.captureChanged(view(stopped, false, 'recording'), open);
    await redirect.captureChanged(view(stopped, true, 'recording'), open);
    await redirect.captureChanged(view(stopped, true, 'idle'), open);
    await redirect.captureChanged(view(stopped, false, 'idle'), open);
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('passes a failed status read to its caller, which shows it', async () => {
    const redirect = new SetupRedirect(() =>
      Promise.reject(new Error('no handler for setup:get-status')),
    );
    await expect(redirect.captureChanged(view(REFUSED, false), vi.fn())).rejects.toThrow(
      'no handler',
    );
  });
});
