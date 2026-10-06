import { type CaptureStatus, idleCaptureStatus } from '../../src/shared/capture';
import { captureChannels, type CaptureApi } from '../../src/shared/ipc/capture';
import type { FakeHub } from './hub';

/**
 * Capture's part of the preview's `window.roger`. Every status it answers or sends starts from
 * idleCaptureStatus(), so it carries every field main's does, the cost guards' `streams`
 * (`paused`, `retrying`), `streamMessages`, `meter` and `notice` included, and any field added
 * there later. A status a scenario sends on CaptureStatusChanged becomes the one
 * getCaptureStatus answers, as it would be in main.
 */
export function createCaptureFake(hub: FakeHub): CaptureApi {
  let status = idleCaptureStatus({
    state: 'idle',
    pending: 0,
    rejected: 0,
    lastError: null,
    nextAttemptAt: null,
  });
  hub.on(captureChannels.CaptureStatusChanged, (next: CaptureStatus) => {
    status = next;
  });
  const publish = (next: CaptureStatus): CaptureStatus => {
    hub.emit(captureChannels.CaptureStatusChanged, next);
    return next;
  };

  return {
    startCapture: () =>
      hub.request(captureChannels.CaptureStart, () =>
        publish({
          ...idleCaptureStatus(status.upload),
          phase: 'recording',
          meetingId: crypto.randomUUID(),
          startedAt: new Date().toISOString(),
          sttProvider: 'fake',
          streams: { mic: 'open', system: 'open' },
        }),
      ),
    // Main keeps the last meeting's meter after Stop (CaptureService.getStatus).
    stopCapture: () =>
      hub.request(captureChannels.CaptureStop, () =>
        publish({ ...idleCaptureStatus(status.upload), meter: status.meter }),
      ),
    getCaptureStatus: () => hub.request(captureChannels.CaptureGetStatus, () => status),
    // No screen source: the preview runs in a plain browser tab.
    getSystemAudioSourceId: () => hub.request(captureChannels.AudioGetSystemSource, () => null),
    // The preview has no main process to stream audio to; chunks and track states end here.
    sendAudioChunk: () => undefined,
    reportAudioSourceState: () => undefined,
    onCaptureStatus: (listener) => hub.on(captureChannels.CaptureStatusChanged, listener),
    onTranscriptSegment: (listener) => hub.on(captureChannels.TranscriptSegment, listener),
    onTranscriptInterim: (listener) => hub.on(captureChannels.TranscriptInterim, listener),
  };
}
