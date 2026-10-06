import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureStatus, StartCaptureRequest } from '../../../shared/capture';
import type { CaptureApi } from '../../../shared/ipc/capture';
import type { Unsubscribe } from '../../../shared/ipc/unsubscribe';
import type { AudioSource, InterimTranscript, TranscriptSegment } from '../../../shared/transcript';
import { describeError } from '../app/describeError';
import { AudioCaptureController, browserCaptureDevices } from '../audio/AudioCaptureController';
import { describeMediaError } from '../audio/sources';

export interface CaptureView {
  status: CaptureStatus | null;
  segments: TranscriptSegment[];
  interim: Record<AudioSource, InterimTranscript | null>;
  /** An error raised on this side (device access), as opposed to `status.error` from main. */
  localError: string | null;
  busy: boolean;
  /**
   * Starts a recording, and its audio capture once main records. `request` says how it was
   * started, its title and its calendar event (M5); left out, a plain manual Start.
   */
  start: (request?: StartCaptureRequest) => Promise<void>;
  stop: () => Promise<void>;
}

/** The part of `window.roger` that hands this window main's start requests. */
export type StartRequestsApi = Pick<CaptureApi, 'onStartRequested' | 'takePendingStart'>;

/**
 * Runs the start requests main has for this window (a click on the prompt panel, M5): the one
 * waiting as the page loads, and each one main announces later. Each is taken from main first,
 * which answers it once, so it runs once however many pages or mounts ask. A take or a start that
 * fails goes to `failed`. Returns the stop.
 */
export function runStartRequests(
  roger: StartRequestsApi,
  start: (request: StartCaptureRequest) => Promise<void>,
  failed: (error: unknown) => void,
): Unsubscribe {
  const take = (): void => {
    roger
      .takePendingStart()
      .then((request) => (request === null ? undefined : start(request)))
      .catch(failed);
  };
  // Listening first: a request announced while the first take is on its way is not missed.
  const stop = roger.onStartRequested(take);
  take();
  return stop;
}

const NO_INTERIM: Record<AudioSource, InterimTranscript | null> = { mic: null, system: null };

/**
 * Binds the UI to main's capture state machine and runs the renderer-side audio capture, for a
 * Start pressed here and for one main asks for (runStartRequests).
 */
export function useCapture(): CaptureView {
  const roger = window.roger;
  // Made once: it holds the running capture, and a render must never make a second.
  const [controller] = useState(() => new AudioCaptureController(roger, browserCaptureDevices()));
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interim, setInterim] = useState(NO_INTERIM);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const meetingId = useRef<string | null>(null);

  useEffect(() => {
    const follow = (next: CaptureStatus): void => {
      if (next.meetingId !== null && next.meetingId !== meetingId.current) {
        meetingId.current = next.meetingId;
        setSegments([]);
        setInterim(NO_INTERIM);
      }
      setStatus(next);
      // Main stopped on its own (no speech, the length cap, sleep): stop capturing too, a source
      // still starting included, or the microphone stays on with nothing listening. Never gate
      // this on `running`: it is false while the mic starts (see followMain). And while main
      // records, the mic captures: a page loaded mid-recording opens it here.
      controller.followMain(next);
    };
    const unsubscribe = [
      roger.onCaptureStatus(follow),
      roger.onTranscriptSegment((segment) => {
        setSegments((previous) =>
          previous.some((s) => s.id === segment.id) ? previous : [...previous, segment],
        );
        setInterim((previous) => ({ ...previous, [segment.source]: null }));
      }),
      roger.onTranscriptInterim((next) => {
        setInterim((previous) => ({ ...previous, [next.source]: next }));
      }),
    ];
    // Followed, not only shown: a page loaded mid-recording (a reload, the reload after a renderer
    // crash, a resume at launch) opens the mic at once, not at main's next status a second later.
    void roger.getCaptureStatus().then(follow);
    // A notice about a recording Roger stopped while the window was away is shown on next focus.
    const refresh = (): void => {
      void roger.getCaptureStatus().then(follow);
    };
    window.addEventListener('focus', refresh);
    return () => {
      for (const off of unsubscribe) off();
      window.removeEventListener('focus', refresh);
    };
  }, [roger, controller]);

  const start = useCallback(
    async (request?: StartCaptureRequest) => {
      setBusy(true);
      setLocalError(null);
      try {
        const started = await roger.startCapture(request);
        setStatus(started);
        if (started.phase !== 'recording') return;
        try {
          // Joins the start main's own status may have begun already (followMain).
          await controller.start(started);
        } catch (error) {
          setLocalError(`Microphone: ${describeMediaError(error)}`);
          await controller.stop();
          setStatus(await roger.stopCapture());
        }
      } finally {
        setBusy(false);
      }
    },
    [roger, controller],
  );

  // A start main asks for runs the same path as a pressed Start. Shown like a microphone error:
  // nobody pressed anything here to see a rejection.
  useEffect(
    () =>
      runStartRequests(roger, start, (error) => {
        setLocalError(`Roger could not start the note it was asked to: ${describeError(error)}`);
      }),
    [roger, start],
  );

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await controller.stop();
      setStatus(await roger.stopCapture());
      setInterim(NO_INTERIM);
    } finally {
      setBusy(false);
    }
  }, [roger, controller]);

  return { status, segments, interim, localError, busy, start, stop };
}
