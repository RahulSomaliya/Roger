import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { promptChannels, type PromptApi, type PromptPanelState } from '../shared/ipc/prompt';

/**
 * The prompt panel's preload (M5-T10): exposes `window.rogerPrompt` and nothing else. The panel
 * page never gets `window.roger`: that is the whole of the main window's IPC, and the panel only
 * draws the cards main sends and reports clicks. Main answers these channels for the panel's page
 * as the only sender (main/prompt/promptIpc.ts), so even a page that got hold of another channel
 * name would be refused. The request is validated in main (parsePromptActionRequest), never here:
 * this file is the page's side of the wire and the page is not trusted.
 *
 * Trap: this file imports NOTHING that preload/index.ts also imports, so it does not use
 * ./bridge.ts's `invoke` and `subscribe` (three lines, written out below). electron-vite builds
 * both preloads in one pass, and a module two entries share becomes a separate chunk that the
 * entry loads with `require('./chunks/…')`. A sandboxed preload cannot require a file: both
 * preloads would fail to load and the app would have no `window.roger` at all, with no build error.
 * prompt.test.ts fails on a shared import.
 */
const rogerPrompt: PromptApi = {
  getState: () => ipcRenderer.invoke(promptChannels.PromptGetState) as Promise<PromptPanelState>,
  onStateChanged: (listener) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      // Main sends only a PromptPanelState on this channel (promptIpc.ts).
      listener(state as PromptPanelState);
    };
    ipcRenderer.on(promptChannels.PromptStateChanged, handler);
    return () => {
      ipcRenderer.removeListener(promptChannels.PromptStateChanged, handler);
    };
  },
  act: (request) => ipcRenderer.invoke(promptChannels.PromptAct, request) as Promise<void>,
};

contextBridge.exposeInMainWorld('rogerPrompt', rogerPrompt);
