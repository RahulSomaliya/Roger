import { describe, expect, it } from 'vitest';
import { ElectronSystemAudio } from './ElectronSystemAudio';
import type { SystemAudioSource } from './SystemAudioSource';

const MEETING = '6f1d2b7e-8a4c-4f0e-9b1a-2c3d4e5f6a7b';

describe('ElectronSystemAudio', () => {
  // The renderer captures call audio on this path; the status is how it knows to (M2-T12).
  it('tells the renderer to capture call audio from the moment a Start begins', () => {
    const electron = new ElectronSystemAudio();
    expect(electron.mode).toBe('electron');
    for (const phase of ['starting', 'recording', 'stopping'] as const) {
      expect(electron.status({ phase, meetingId: MEETING })).toEqual({ systemCapture: 'electron' });
    }
    expect(electron.status({ phase: 'idle', meetingId: null })).toEqual({ systemCapture: null });
  });

  it('runs nothing in main', async () => {
    // Called through the seam, as createSystemAudio.ts does.
    const electron: SystemAudioSource = new ElectronSystemAudio();
    electron.start({ meetingId: MEETING, meetingStartedAtMs: 0 });
    electron.windowFocused();
    electron.rebuild('the person allowed System Audio Recording');
    electron.restart('the Mac woke up');
    await expect(electron.stop()).resolves.toBeUndefined();
  });
});
