/**
 * The System Settings panes Roger sends the user to when a permission is missing, as
 * `x-apple.systempreferences:` deep links for `shell.openExternal`. Pure, so it is tested under Node.
 *
 * One link per pane, never a fallback chain: `shell.openExternal` resolves even for an anchor System
 * Settings does not know (it opens on some other page), so a chain cannot tell that its first link
 * failed and would never reach the second.
 *
 * HAND CHECK ON macOS 26 PENDING (M2-T1's Mac check): open each link on the installed app and
 * confirm it lands on the list `where` names. Record the result in the M2 exit check log and update
 * this comment. Until then the anchors rest on this evidence:
 * - The Privacy & Security extension of macOS 26.6.2 (`SecurityPrivacyExtension.appex`, bundle
 *   `com.apple.settings.PrivacySecurity.extension`) declares `com.apple.preference.security` as its
 *   legacy id and accepts this URL scheme. Its binary contains `Privacy_Microphone`,
 *   `Privacy_ScreenCapture` and `Privacy_AudioCapture` (a `TCCServiceAudioCapture` section titled
 *   "System Audio Recording Only" in its strings).
 * - openwhispr (`src/helpers/ipcHandlers.js`), anarlog (`plugins/permissions/src/guidance.rs`) and
 *   meetily open `com.apple.preference.security?Privacy_Microphone` and `?Privacy_ScreenCapture`.
 *   Both openwhispr and anarlog send system audio to `Privacy_ScreenCapture`, the combined pane;
 *   Roger's helper needs only the "System Audio Recording Only" list, hence `Privacy_AudioCapture`.
 *   If that anchor turns out to open the wrong page, fall back to `Privacy_ScreenCapture`, whose
 *   pane holds the same list further down.
 */

export type SettingsPane = 'microphone' | 'systemAudio' | 'screenRecording';

export interface SettingsPaneLink {
  /** The deep link. */
  url: string;
  /**
   * Where the link lands, in System Settings' own English words, so an error can name the pane and
   * the list the switch is in. Keep it in step with `url`.
   */
  where: string;
}

const PRIVACY = 'x-apple.systempreferences:com.apple.preference.security';

export const SETTINGS_PANES: Readonly<Record<SettingsPane, Readonly<SettingsPaneLink>>> = {
  microphone: {
    url: `${PRIVACY}?Privacy_Microphone`,
    where: 'System Settings > Privacy & Security > Microphone',
  },
  /** Call audio through the `roger-audio` helper's Core Audio tap. */
  systemAudio: {
    url: `${PRIVACY}?Privacy_AudioCapture`,
    where:
      'System Settings > Privacy & Security > Screen & System Audio Recording > System Audio Recording Only',
  },
  /** Only the Electron `desktopCapturer` fallback for call audio needs Screen Recording. */
  screenRecording: {
    url: `${PRIVACY}?Privacy_ScreenCapture`,
    where: 'System Settings > Privacy & Security > Screen & System Audio Recording',
  },
};
