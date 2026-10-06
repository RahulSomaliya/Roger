import { describe, expect, it } from 'vitest';
import { SETTINGS_PANES } from './settingsPanes';

describe('SETTINGS_PANES', () => {
  it('opens the Microphone list under Privacy & Security', () => {
    expect(SETTINGS_PANES.microphone).toEqual({
      url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      where: 'System Settings > Privacy & Security > Microphone',
    });
  });

  it('opens the System Audio Recording Only list, which the helper tap needs, not Screen Recording', () => {
    expect(SETTINGS_PANES.systemAudio).toEqual({
      url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture',
      where:
        'System Settings > Privacy & Security > Screen & System Audio Recording > System Audio Recording Only',
    });
  });

  it('opens Screen & System Audio Recording, which only the Electron fallback needs', () => {
    expect(SETTINGS_PANES.screenRecording).toEqual({
      url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      where: 'System Settings > Privacy & Security > Screen & System Audio Recording',
    });
  });

  it('gives each pane exactly one System Settings link, never a fallback chain', () => {
    for (const { url } of Object.values(SETTINGS_PANES)) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe('x-apple.systempreferences:');
      expect(parsed.pathname).toBe('com.apple.preference.security');
      expect(parsed.search).toMatch(/^\?Privacy_[A-Za-z]+$/);
    }
  });
});
