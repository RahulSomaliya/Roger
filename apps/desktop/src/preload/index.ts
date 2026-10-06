import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannel, type RogerApi, type Unsubscribe } from '../shared/ipc';

/**
 * The only bridge between renderer and main. Everything here is typed by the shared contract;
 * nothing else from Node or Electron is exposed to the page.
 */

function invoke<T>(channel: string): Promise<T> {
  return ipcRenderer.invoke(channel) as Promise<T>;
}

function subscribe(channel: string, listener: (payload: never) => void): Unsubscribe {
  // Payload types are fixed by the RogerApi signatures below; main only sends what the contract says.
  const handler = (_event: IpcRendererEvent, payload: unknown): void => {
    listener(payload as never);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: RogerApi = {
  startCapture: () => invoke(IpcChannel.CaptureStart),
  stopCapture: () => invoke(IpcChannel.CaptureStop),
  getCaptureStatus: () => invoke(IpcChannel.CaptureGetStatus),
  getSystemAudioSourceId: () => invoke(IpcChannel.AudioGetSystemSource),
  sendAudioChunk: (message) => {
    ipcRenderer.send(IpcChannel.AudioChunk, message);
  },
  reportAudioSourceState: (message) => {
    ipcRenderer.send(IpcChannel.AudioSourceState, message);
  },
  onCaptureStatus: (listener) => subscribe(IpcChannel.CaptureStatusChanged, listener),
  onTranscriptSegment: (listener) => subscribe(IpcChannel.TranscriptSegment, listener),
  onTranscriptInterim: (listener) => subscribe(IpcChannel.TranscriptInterim, listener),
};

contextBridge.exposeInMainWorld('roger', api);
