import { captureChannels, type CaptureApi } from '../../shared/ipc/capture';
import { invoke, send, subscribe } from '../bridge';

/** Capture's part of `window.roger`. */
export const captureBridge: CaptureApi = {
  startCapture: () => invoke(captureChannels.CaptureStart),
  stopCapture: () => invoke(captureChannels.CaptureStop),
  getCaptureStatus: () => invoke(captureChannels.CaptureGetStatus),
  getSystemAudioSourceId: () => invoke(captureChannels.AudioGetSystemSource),
  sendAudioChunk: (message) => {
    send(captureChannels.AudioChunk, message);
  },
  reportAudioSourceState: (message) => {
    send(captureChannels.AudioSourceState, message);
  },
  onCaptureStatus: (listener) => subscribe(captureChannels.CaptureStatusChanged, listener),
  onTranscriptSegment: (listener) => subscribe(captureChannels.TranscriptSegment, listener),
  onTranscriptInterim: (listener) => subscribe(captureChannels.TranscriptInterim, listener),
  onTranscriptSegmentChanged: (listener) =>
    subscribe(captureChannels.TranscriptSegmentChanged, listener),
  getCaptureReport: (request) => invoke(captureChannels.CaptureGetReport, request),
  rerunGaps: (request) => invoke(captureChannels.CaptureRerunGaps, request),
  deleteMeetingAudio: (request) => invoke(captureChannels.AudioDeleteMeeting, request),
  unhideSegment: (request) => invoke(captureChannels.TranscriptUnhideSegment, request),
};
