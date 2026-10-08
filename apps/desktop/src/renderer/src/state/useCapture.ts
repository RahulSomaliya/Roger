import { useCallback, useEffect, useState } from 'react';
import type { CaptureStatus, StartCaptureRequest } from '../../../shared/capture';
import type { CaptureApi } from '../../../shared/ipc/capture';
import type { Unsubscribe } from '../../../shared/ipc/unsubscribe';
import { AudioCaptureController, browserCaptureDevices } from '../audio/AudioCaptureController';
import { describeMicrophoneFailure } from '../audio/sources';

export interface CaptureView {
  status: CaptureStatus | null;
  /**
   * The meeting main's status named last: the one recording, and after Stop the one it stopped,
   * until main names the next (lastNamedMeeting). Null until main names one. Taken from every
   * status main sends, rendered or not, so a recording that starts and stops between two renders
   * still shows here, where `status` alone misses it (meeting/recentMeetingsKey.ts).
   */
  lastMeetingId: string | null;
  /**
   * An error raised on this side (device access), as opposed to `status.error` from main: a plain
   * sentence, as main's is. The raw error goes to `reportError`, since the renderer has no logger.
   */
  localError: string | null;
  busy: boolean;
  /**
   * Starts a recording, and its audio capture once main records. `request` says how it was
   * started, its title and its calendar event (M5); left out, a plain manual Start. A title taken
   * from a calendar event is cut with fitMeetingTitle first: an event's title has no length limit,
   * and main refuses a request whose title is longer than the API stores.
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

/**
 * The meeting `status` leaves CaptureView's `lastMeetingId` at: the one it names, else `previous`.
 * Main names none while idle, and none while the next recording starts.
 */
export function lastNamedMeeting(previous: string | null, status: CaptureStatus): string | null {
  return status.meetingId ?? previous;
}

/**
 * Binds the UI to main's capture state machine and runs the renderer-side audio capture, for a
 * Start pressed here and for one main asks for (runStartRequests). It keeps no transcript: the
 * live transcript panel (transcript/useLiveTranscript.ts) subscribes to main's lines itself, so
 * this view, which every page of the shell shares, renders nothing per line.
 */
export function useCapture(): CaptureView {
  const roger = window.roger;
  // Made once: it holds the running capture, and a render must never make a second.
  const [controller] = useState(() => new AudioCaptureController(roger, browserCaptureDevices()));
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [lastMeetingId, setLastMeetingId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Every status main sends or answers goes through here, so lastMeetingId misses none.
  const show = useCallback((next: CaptureStatus): void => {
    setStatus(next);
    setLastMeetingId((previous) => lastNamedMeeting(previous, next));
  }, []);

  useEffect(() => {
    const follow = (next: CaptureStatus): void => {
      show(next);
      // Main stopped on its own (no speech, the length cap, sleep): stop capturing too, a source
      // still starting included, or the microphone stays on with nothing listening. Never gate
      // this on `running`: it is false while the mic starts (see followMain). And while main
      // records, the mic captures: a page loaded mid-recording opens it here.
      controller.followMain(next);
    };
    const unsubscribe = roger.onCaptureStatus(follow);
    // Followed, not only shown: a page loaded mid-recording (a reload, the reload after a renderer
    // crash, a resume at launch) opens the mic at once, not at main's next status a second later.
    void roger.getCaptureStatus().then(follow);
    // A notice about a recording Roger stopped while the window was away is shown on next focus.
    const refresh = (): void => {
      void roger.getCaptureStatus().then(follow);
    };
    window.addEventListener('focus', refresh);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', refresh);
    };
  }, [roger, controller, show]);

  const start = useCallback(
    async (request?: StartCaptureRequest) => {
      setBusy(true);
      setLocalError(null);
      try {
        const started = await roger.startCapture(request);
        show(started);
        if (started.phase !== 'recording') return;
        try {
          // Joins the start main's own status may have begun already (followMain).
          await controller.start(started);
        } catch (error) {
          setLocalError(describeMicrophoneFailure(error));
          reportError(error);
          await controller.stop();
          show(await roger.stopCapture());
        }
      } finally {
        setBusy(false);
      }
    },
    [roger, controller, show],
  );

  // A start main asks for runs the same path as a pressed Start. Shown like a microphone error:
  // nobody pressed anything here to see a rejection.
  useEffect(
    () =>
      runStartRequests(roger, start, (error) => {
        // An IPC failure or a request main refused: its text is main's, for the log alone.
        setLocalError('Roger could not start the notes it was asked to. Start notes again.');
        reportError(error);
      }),
    [roger, start],
  );

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await controller.stop();
      show(await roger.stopCapture());
    } finally {
      setBusy(false);
    }
  }, [roger, controller, show]);

  return { status, lastMeetingId, localError, busy, start, stop };
}
