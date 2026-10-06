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
  const controller = useRef<AudioCaptureController>(
    new AudioCaptureController(roger, browserCaptureDevices()),
  );
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interim, setInterim] = useState(NO_INTERIM);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const meetingId = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = [
      roger.onCaptureStatus((next) => {
        if (next.meetingId !== null && next.meetingId !== meetingId.current) {
          meetingId.current = next.meetingId;
          setSegments([]);
          setInterim(NO_INTERIM);
        }
        setStatus(next);
        // Main stopped on its own (no speech, the length cap, sleep, a reload): stop capturing too,
        // a source still starting included, or the microphone stays on with nothing listening.
        // Never gate this on `running`: it is false while the mic starts (see followMain).
        controller.current.followMain(next.phase);
      }),
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
    void roger.getCaptureStatus().then(setStatus);
    // A notice about a recording Roger stopped while the window was away is shown on next focus.
    const refresh = (): void => {
      void roger.getCaptureStatus().then(setStatus);
    };
    window.addEventListener('focus', refresh);
    return () => {
      for (const off of unsubscribe) off();
      window.removeEventListener('focus', refresh);
    };
  }, [roger]);

  const start = useCallback(async () => {
    setBusy(true);
    setLocalError(null);
    try {
      const started = await roger.startCapture();
      setStatus(started);
      if (started.phase !== 'recording') return;
      try {
        await controller.current.start();
      } catch (error) {
        setLocalError(`Microphone: ${describeMediaError(error)}`);
        await controller.current.stop();
        setStatus(await roger.stopCapture());
      }
    } finally {
      setBusy(false);
    }
  }, [roger]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await controller.current.stop();
      setStatus(await roger.stopCapture());
      setInterim(NO_INTERIM);
    } finally {
      setBusy(false);
    }
  }, [roger]);

  return { status, segments, interim, localError, busy, start, stop };
}
