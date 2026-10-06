import { desktopCapturer } from 'electron';
import type { CaptureReport } from '../shared/capture';
import { IpcChannel } from '../shared/ipc';
import type { MeetingRequest, SegmentRequest } from '../shared/ipc/capture';
import type { CaptureService } from './capture/CaptureService';
import { handleTrusted, onTrusted, type IpcMainLike, type IpcTrust } from './ipc/trust';
import {
  isSourceStateMessage,
  parseAudioChunk,
  parseMeetingRequest,
  parseSegmentRequest,
  parseStartCaptureRequest,
} from './ipc-validation';
import { errorMessage, type Logger } from './logger';

/** The parts of CaptureService the capture channels drive. */
export type CaptureIpcTarget = Pick<
  CaptureService,
  'start' | 'stop' | 'getStatus' | 'pushAudio' | 'reportSourceState' | 'on' | 'takePendingStart'
>;

/**
 * What the meeting-scoped capture channels answer, once ipc.ts has checked the ids
 * (createCaptureRuntime.ts builds it; the M2 features fill their parts there). A refusal throws,
 * and the page's invoke rejects with its message.
 */
export interface CaptureRequests {
  getReport(meetingId: string): CaptureReport;
  /** Re-runs the meeting's gaps (M2-T16), then answers the report as it is after. */
  rerunGaps(meetingId: string): Promise<CaptureReport>;
  /** Deletes the meeting's audio backup (M2-T15), then answers the report as it is after. */
  deleteMeetingAudio(meetingId: string): Promise<CaptureReport>;
  /** Shows a hidden echo line again (M2-T14b); refuses a line that is not hidden. */
  unhideSegment(request: SegmentRequest): void;
}

/** The main window, as the capture channels use it. */
export interface CaptureWindow {
  readonly webContents: { readonly id: number; send(channel: string, payload: unknown): void };
  isDestroyed(): boolean;
}

export interface IpcDeps {
  ipcMain: IpcMainLike;
  capture: CaptureIpcTarget;
  requests: CaptureRequests;
  getWindow: () => CaptureWindow | null;
  logger: Logger;
}

/**
 * Wires the capture channels (src/shared/ipc/capture.ts) to the capture service, for the main
 * window's page only (ipc/trust.ts). Payloads from the renderer are validated.
 */
export function registerIpcHandlers({
  ipcMain,
  capture,
  requests,
  getWindow,
  logger,
}: IpcDeps): void {
  const trust: IpcTrust = { ipcMain, getWindow, logger };

  // Rebuilt from the fields it checked: whatever else the page sends, a `resume` included (only
  // main resumes a meeting, M2-T23), never reaches start().
  handleTrusted(trust, IpcChannel.CaptureStart, (payload) =>
    capture.start(parseStartCaptureRequest(payload)),
  );
  handleTrusted(trust, IpcChannel.CaptureTakePendingStart, () => capture.takePendingStart());
  handleTrusted(trust, IpcChannel.CaptureStop, () => capture.stop());
  handleTrusted(trust, IpcChannel.CaptureGetStatus, () => capture.getStatus());
  handleTrusted(trust, IpcChannel.AudioGetSystemSource, async () => {
    try {
      // A screen source is what Chromium attaches system audio to; we never render its video.
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      return sources[0]?.id ?? null;
    } catch (error) {
      logger.warn('desktopCapturer.getSources failed', { error: errorMessage(error) });
      return null;
    }
  });

  // Meeting ids name folders on disk (userData/audio/<id>): checked here before anything runs,
  // so a renderer's `../x` never reaches a handler that deletes.
  handleTrusted(trust, IpcChannel.CaptureGetReport, (payload) =>
    requests.getReport(meetingRequest(payload).meetingId),
  );
  handleTrusted(trust, IpcChannel.CaptureRerunGaps, (payload) =>
    requests.rerunGaps(meetingRequest(payload).meetingId),
  );
  handleTrusted(trust, IpcChannel.AudioDeleteMeeting, (payload) =>
    requests.deleteMeetingAudio(meetingRequest(payload).meetingId),
  );
  handleTrusted(trust, IpcChannel.TranscriptUnhideSegment, (payload) => {
    const request = parseSegmentRequest(payload);
    if (request === null) throw new Error('invalid segment request');
    requests.unhideSegment(request);
  });

  onTrusted(trust, IpcChannel.AudioChunk, (message) => {
    const chunk = parseAudioChunk(message);
    if (!chunk) {
      logger.warn('malformed audio chunk ignored');
      return;
    }
    capture.pushAudio(chunk.source, chunk.pcm, chunk.capturedAtMs);
  });

  onTrusted(trust, IpcChannel.AudioSourceState, (message) => {
    if (!isSourceStateMessage(message)) {
      logger.warn('malformed source state ignored');
      return;
    }
    capture.reportSourceState(message.source, message.state, message.message ?? null);
  });

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };
  capture.on('status', (status) => {
    send(IpcChannel.CaptureStatusChanged, status);
  });
  capture.on('segment', (segment) => {
    send(IpcChannel.TranscriptSegment, segment);
  });
  capture.on('interim', (interim) => {
    send(IpcChannel.TranscriptInterim, interim);
  });
  // A nudge, not the request: the page takes it (CaptureTakePendingStart), so it runs once.
  capture.on('start-requested', () => {
    send(IpcChannel.CaptureStartRequested, undefined);
  });
}

function meetingRequest(payload: unknown): MeetingRequest {
  const request = parseMeetingRequest(payload);
  if (request === null) throw new Error('invalid meeting request');
  return request;
}
