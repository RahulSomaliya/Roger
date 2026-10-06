import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureStatus } from '../../../shared/capture';
import type { AudioSource, InterimTranscript, TranscriptSegment } from '../../../shared/transcript';
import { AudioCaptureController, browserCaptureDevices } from '../audio/AudioCaptureController';
import { describeMediaError } from '../audio/sources';

export interface CaptureView {
  status: CaptureStatus | null;
  segments: TranscriptSegment[];
  interim: Record<AudioSource, InterimTranscript | null>;
  /** An error raised on this side (device access), as opposed to `status.error` from main. */
  localError: string | null;
  busy: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

const NO_INTERIM: Record<AudioSource, InterimTranscript | null> = { mic: null, system: null };

/** Binds the UI to main's capture state machine and runs the renderer-side audio capture. */
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

  const start = useCallback(async () => {
    setBusy(true);
    setLocalError(null);
    try {
      const started = await roger.startCapture();
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
  }, [roger, controller]);

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
