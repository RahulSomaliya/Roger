import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { StartCaptureRequest } from '../../../shared/capture';
import { useCapture, type CaptureView } from '../state/useCapture';
import { captureMeetingAfter, type CaptureMeeting } from './captureMeeting';
import { describeError } from './describeError';
import type { Route } from './router';

/** What every part of the shell reads: the route, and the window's one capture view. */
export interface Shell {
  readonly route: Route;
  readonly navigate: (route: Route) => void;
  /**
   * The capture view (useCapture), made once here for the whole window: it owns the microphone
   * and the call audio, so it must outlive every page. Never call useCapture anywhere else.
   */
  readonly capture: CaptureView;
  /**
   * The meeting `capture` describes: recording, or the last one after Stop and while the next one
   * starts. Whether it is recording: meetingPhase (captureMeeting.ts), never main's phase alone.
   */
  readonly captureMeeting: CaptureMeeting | null;
  /**
   * Start notes: starts a recording and, once it records, opens its meeting. With a `request`
   * (a calendar meeting's title and event, startRequestForEvent) it starts that meeting's notes;
   * without, a blank note. Home's hero button and each Today row call this one function, so a
   * start that fails reaches the user the same way from both (`actionError`, in the banner).
   */
  readonly startNewNote: (request?: StartCaptureRequest) => void;
  /** Stops the recording. */
  readonly stopRecording: () => void;
  /**
   * Why the last Start notes or Stop failed before main could answer (an IPC rejection), or null.
   * Errors main reports are in `capture.status.error`; BannerSlot shows both.
   */
  readonly actionError: string | null;
}

const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (shell === null) throw new Error('useShell needs a <ShellProvider> above it');
  return shell;
}

interface ShellProviderProps {
  route: Route;
  navigate: (route: Route) => void;
  children: ReactNode;
}

export function ShellProvider({ route, navigate, children }: ShellProviderProps) {
  const capture = useCapture();
  const { start, stop, status } = capture;

  // Adjusted during render rather than in an effect, so no frame shows the wrong meeting;
  // captureMeetingAfter returns the same object when nothing changed, which ends the loop.
  const [captureMeeting, setCaptureMeeting] = useState<CaptureMeeting | null>(null);
  const seen = captureMeetingAfter(captureMeeting, status);
  if (seen !== captureMeeting) setCaptureMeeting(seen);

  const [actionError, setActionError] = useState<string | null>(null);

  const startNewNote = useCallback(
    (request?: StartCaptureRequest) => {
      setActionError(null);
      const run = async (): Promise<void> => {
        await start(request);
        // start() resolves after the microphone started, or after main refused or the microphone
        // failed (both shown by the banner); only a recording opens the meeting.
        const now = await window.roger.getCaptureStatus();
        if (now.phase === 'recording' && now.meetingId !== null) {
          navigate({ name: 'meeting', meetingId: now.meetingId });
        }
      };
      run().catch((error: unknown) => {
        setActionError(`Roger could not start notes: ${describeError(error)}`);
      });
    },
    [start, navigate],
  );

  const stopRecording = useCallback(() => {
    setActionError(null);
    stop().catch((error: unknown) => {
      setActionError(`Roger could not stop recording: ${describeError(error)}`);
    });
  }, [stop]);

  const shell = useMemo<Shell>(
    () => ({
      route,
      navigate,
      capture,
      captureMeeting,
      startNewNote,
      stopRecording,
      actionError,
    }),
    [route, navigate, capture, captureMeeting, startNewNote, stopRecording, actionError],
  );
  return <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>;
}
