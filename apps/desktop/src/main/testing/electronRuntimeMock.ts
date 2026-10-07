import { vi } from 'vitest';

/**
 * The stand-in for the `electron` module in every test that builds `createCaptureRuntime`. Use it
 * as `vi.mock('electron', async () => (await import('../testing/electronRuntimeMock')).electronRuntimeMock({ ... }))`
 * and pass only what the test asserts on or fakes itself. Never a hand-written copy: the runtime
 * reads a new Electron field whenever a slot lands, and each copy broke only after the branches
 * merged (`app.getAppPath is not a function` after M2-T10, `No "powerMonitor" export` after M2-T18).
 * Vitest throws for a missing export only when code reads it, never at import. A slot that reads
 * another Electron field adds it HERE, and every runtime test has it at once.
 */
export function electronRuntimeMock(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    // ipc.ts asks it for the screen source; nothing calls it in a test.
    desktopCapturer: { getSources: vi.fn() },
    app: {
      isPackaged: false,
      // The M2-T10 slot looks for the audio helper here: a folder with none, so call audio takes
      // Electron's path and no test runs a helper. Never the real apps/desktop: on a Mac that ran
      // `make check` its dev build exists, and a Start would build a real tap (a privacy prompt).
      getAppPath: () => '/nonexistent/roger-app',
      on: vi.fn(),
      relaunch: vi.fn(),
      quit: vi.fn(),
    },
    // The M2-T6 slot asks net.isOnline() every second while a recording runs. Left out, each poll
    // logs "network check failed" (the throw is caught) and the test still passes.
    net: { isOnline: () => true },
    // A focused window: M2-T11's Notifier posts only while Roger is not focused, so no test posts.
    BrowserWindow: { getFocusedWindow: () => ({ webContents: { id: 7 } }) },
    // M2-T18: the PowerCoordinator listens for sleep and wake and holds a blocker while recording.
    powerMonitor: { on: () => undefined },
    powerSaveBlocker: { start: () => 1, stop: () => undefined },
    // M2-T19's setup ports: all fakes, so no test asks macOS for anything or opens System Settings.
    shell: { openExternal: vi.fn(() => Promise.resolve()) },
    systemPreferences: {
      getMediaAccessStatus: vi.fn(() => 'granted'),
      askForMediaAccess: vi.fn(() => Promise.resolve(true)),
    },
    Notification: { isSupported: () => false },
    ...overrides,
  };
}
