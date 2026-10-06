import type { BrowserWindow, IpcMain } from 'electron';
import { desktopCapturer } from 'electron';
import { IpcChannel } from '../shared/ipc';
import type { CaptureService } from './capture/CaptureService';
import { handleTrusted, onTrusted, type IpcTrust } from './ipc/trust';
import { isSourceStateMessage, parseAudioChunk } from './ipc-validation';
import { errorMessage, type Logger } from './logger';

export interface IpcDeps {
  ipcMain: IpcMain;
  capture: CaptureService;
  getWindow: () => BrowserWindow | null;
  logger: Logger;
}

/**
 * Wires the capture channels (src/shared/ipc/capture.ts) to the capture service, for the main
 * window's page only (ipc/trust.ts). Payloads from the renderer are validated.
 */
export function registerIpcHandlers({ ipcMain, capture, getWindow, logger }: IpcDeps): void {
  const trust: IpcTrust = { ipcMain, getWindow, logger };

  handleTrusted(trust, IpcChannel.CaptureStart, () => capture.start());
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

  onTrusted(trust, IpcChannel.AudioChunk, (message) => {
    const chunk = parseAudioChunk(message);
    if (!chunk) {
      logger.warn('malformed audio chunk ignored');
      return;
    }
    capture.pushAudio(chunk.source, chunk.pcm);
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
}
