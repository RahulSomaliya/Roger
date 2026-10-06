// Stub from P2-F1; owned by M5-T9b.
// The prompt panel's channels and its API. The panel is not part of `window.roger` (RogerApi): its
// own preload (src/preload/prompt.ts, M5-T10) exposes only `window.rogerPrompt`, and promptIpc
// accepts the panel as the only sender. Its channels still go into IpcChannel (src/shared/ipc.ts)
// and its uniqueness test, because they share ipcMain's one namespace with every other channel.

export const promptChannels = {} as const;

/** Empty until M5-T9b adds the first member; make it an interface then. */
export type PromptApi = object;
