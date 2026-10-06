import type { SystemCaptureMode } from '../../../shared/capture';
import type {
  RecordingStarted,
  StatusContext,
  StatusContribution,
} from '../../capture/CaptureService';

/**
 * Where call audio ("them", house rule 6) comes from, chosen once at startup
 * (selectSystemAudio.ts, M2 D1):
 * - TapSystemAudio: `roger-audio tap` through HelperProcess; main feeds its frames to capture.
 * - ElectronSystemAudio: Electron's desktopCapturer; the renderer captures and sends the chunks
 *   over IPC as before, and main has nothing to run.
 *
 * The status says which (`CaptureStatus.systemCapture`) from the moment a Start begins: the
 * renderer opens its own system stream only for `electron` (M2-T12), or the two paths would both
 * push call audio into one source.
 */
export interface SystemAudioSource {
  readonly mode: SystemCaptureMode;
  /** A recording began (`CaptureService.onRecording`): capture its call audio. */
  start(recording: Pick<RecordingStarted, 'meetingId' | 'meetingStartedAtMs'>): void;
  /** The recording ended: stop capturing. Resolves once nothing runs; never rejects. */
  stop(): Promise<void>;
  /** Roger's window regained focus (it may come back from the System Audio Recording dialog). */
  windowFocused(): void;
  /**
   * Rebuild the tap now, during a recording: the person just allowed System Audio Recording, and
   * a tap built while the macOS dialog was up stays silent (M2-T19's "I allowed it").
   */
  rebuild(reason: string): void;
  /** Start the capture afresh, during a recording, outside any restart count (wake, M2-T18). */
  restart(reason: string): void;
  /** Its part of every capture status (`CaptureService.addStatusContributor`). */
  status(context: StatusContext): StatusContribution;
}
