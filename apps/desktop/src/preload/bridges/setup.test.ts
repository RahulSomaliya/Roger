import { describe, expect, it, vi } from 'vitest';
import { setupBridge } from './setup';

// Electron's ipcRenderer, as far as the bridge helpers (../bridge.ts) use it. Hoisted, because
// vi.mock runs before the imports.
const ipc = vi.hoisted(() => {
  const invoked: unknown[][] = [];
  return {
    invoked,
    renderer: {
      invoke: (...args: unknown[]): Promise<unknown> => {
        invoked.push(args);
        return Promise.resolve(undefined);
      },
    },
  };
});
vi.mock('electron', () => ({ ipcRenderer: ipc.renderer }));

describe('the setup bridge', () => {
  it('asks main on one channel per setup action, with the pane as its one payload', async () => {
    await setupBridge.getSetupStatus();
    await setupBridge.requestMicrophoneAccess();
    await setupBridge.testSystemAudio();
    await setupBridge.confirmSystemAudioAllowed();
    await setupBridge.testNotification();
    await setupBridge.openSettingsPane({ pane: 'systemAudio' });
    await setupBridge.relaunchRoger();
    expect(ipc.invoked).toEqual([
      ['setup:get-status', undefined],
      ['setup:request-microphone', undefined],
      ['setup:test-system-audio', undefined],
      ['setup:confirm-system-audio', undefined],
      ['setup:test-notification', undefined],
      ['setup:open-settings-pane', { pane: 'systemAudio' }],
      ['setup:relaunch', undefined],
    ]);
  });
});
