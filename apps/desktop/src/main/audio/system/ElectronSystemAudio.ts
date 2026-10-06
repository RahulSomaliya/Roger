import type { StatusContext, StatusContribution } from '../../capture/CaptureService';
import type { SystemAudioSource } from './SystemAudioSource';

/**
 * Call audio through Electron's `desktopCapturer`, the fallback (M2 D1): when the helper is
 * missing, or config.json sets `systemAudioCapture` to `electron`. The renderer does the capture:
 * it asks main for a screen source (`audio:get-system-source`, ipc.ts), opens its audio and sends
 * the chunks over IPC as the `system` source, as M1 did. It needs Screen Recording, which is why
 * the helper's tap is preferred.
 *
 * So main has nothing to run here; this source only tells the renderer which path is in use.
 */
export class ElectronSystemAudio implements SystemAudioSource {
  readonly mode = 'electron';

  start(): void {
    // The renderer opens the stream when the status says `electron` (M2-T12).
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  windowFocused(): void {
    // No tap to rebuild: Screen Recording takes effect for the renderer's next stream.
  }

  rebuild(): void {
    // No tap to rebuild.
  }

  restart(): void {
    // Nothing runs in main; the renderer reopens its own streams.
  }

  status(context: StatusContext): StatusContribution {
    return { systemCapture: context.phase === 'idle' ? null : 'electron' };
  }
}
