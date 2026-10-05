import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { desktopCapturer } from 'electron';
import { IpcChannel } from '../shared/ipc';
import type { CaptureService } from './capture/CaptureService';
import { isSourceStateMessage, parseAudioChunk } from './ipc-validation';
import { errorMessage, type Logger } from './logger';

export interface IpcDeps {
  ipcMain: IpcMain;
  capture: CaptureService;
  getWindow: () => BrowserWindow | null;
  logger: Logger;
}

/** Wires the IPC contract (src/shared/ipc.ts) to the capture service. Payloads from the renderer are validated. */
export function registerIpcHandlers({ ipcMain, capture, getWindow, logger }: IpcDeps): void {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const window = getWindow();
    const ok = window !== null && event.sender.id === window.webContents.id;
    if (!ok)
      logger.warn('ipc message from unexpected sender ignored', { senderId: event.sender.id });
    return ok;
  };
  const handle = <T>(channel: string, run: () => Promise<T> | T): void => {
    ipcMain.handle(channel, (event) => {
      if (!trusted(event)) throw new Error('untrusted sender');
      return run();
    });
  };

  handle(IpcChannel.CaptureStart, () => capture.start());
  handle(IpcChannel.CaptureStop, () => capture.stop());
  handle(IpcChannel.CaptureGetStatus, () => capture.getStatus());
  handle(IpcChannel.AudioGetSystemSource, async () => {
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

  ipcMain.on(IpcChannel.AudioChunk, (event, message: unknown) => {
    if (!trusted(event)) return;
    const chunk = parseAudioChunk(message);
    if (!chunk) {
      logger.warn('malformed audio chunk ignored');
      return;
    }
    capture.pushAudio(chunk.source, chunk.pcm);
  });

  ipcMain.on(IpcChannel.AudioSourceState, (event, message: unknown) => {
    if (!trusted(event)) return;
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
