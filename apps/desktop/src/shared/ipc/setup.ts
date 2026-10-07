import type { SystemCaptureMode } from '../capture';

/**
 * The permission setup screen's channels (M2-T19 builds the screen and main's handlers). Main
 * registers them through src/main/ipc/trust.ts and validates the one payload, the pane, in
 * src/main/ipc-validation.ts first.
 */
export const setupChannels = {
  /** renderer → main, invoke */
  SetupGetStatus: 'setup:get-status',
  SetupRequestMicrophone: 'setup:request-microphone',
  SetupTestSystemAudio: 'setup:test-system-audio',
  SetupConfirmSystemAudio: 'setup:confirm-system-audio',
  SetupTestNotification: 'setup:test-notification',
  SetupOpenSettingsPane: 'setup:open-settings-pane',
  SetupRelaunch: 'setup:relaunch',
} as const;

/**
 * The System Settings panes Roger sends people to. Main holds their links (SETTINGS_PANES in
 * src/main/settingsPanes.ts, M2-T1); ipc-validation.test.ts fails when the two lists differ.
 */
export const SETTINGS_PANE_IDS = ['microphone', 'systemAudio', 'screenRecording'] as const;

export type SettingsPaneId = (typeof SETTINGS_PANE_IDS)[number];

/** A privacy permission as macOS reports it (`systemPreferences.getMediaAccessStatus`). */
export type MediaAccessState = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

/**
 * No public API reads the System Audio Recording permission, and a refused or still-pending tap
 * records silence with no error. So Roger plays a system sound and listens through the helper
 * (`roger-audio probe`): heard means allowed.
 * - unknown: not probed yet for this signing identity
 * - pending: the first probe for this identity heard nothing: macOS may still be asking (answer
 *   the dialog, then "I allowed it")
 * - not-heard: a later probe heard nothing: not allowed, or the Mac is muted (no API tells which)
 * - verified: heard, by a probe or by call audio, for this signing identity; a new identity resets
 *   it, as it resets the grant
 */
export type SystemAudioSetupState = 'unknown' | 'pending' | 'not-heard' | 'verified';

/**
 * The test notification: `shown`, or `failed` (Electron's Notification emitted `failed`, as it
 * does on a build macOS does not trust: warnings then fall back to the dock).
 */
export type NotificationSetupState = 'unknown' | 'shown' | 'failed';

/**
 * How this copy of Roger is signed (`SigningKind` in src/main/signing.ts, M2-T1), or `unknown`
 * when codesign could not tell. Only `local-identity` and `developer-id` keep their grants across
 * rebuilds.
 */
export type SigningSetupState =
  'local-identity' | 'developer-id' | 'adhoc' | 'unsigned' | 'unknown';

/** The API's health, or a speech-to-text token fetch, as checked last. */
export type ConnectionSetupState = 'unknown' | 'ok' | 'failed';

/** One row of the setup screen. */
export interface SetupCheck<State extends string> {
  state: State;
  /**
   * For people, or null when all is well: what is wrong, and for a permission the pane and the
   * switch that fix it (`SETTINGS_PANES[pane].where`).
   */
  message: string | null;
  /** macOS applies the fix only to a new process: the row offers "Relaunch Roger". */
  relaunchNeeded: boolean;
}

export interface SetupStatus {
  microphone: SetupCheck<MediaAccessState>;
  systemAudio: SetupCheck<SystemAudioSetupState>;
  /** Which path call audio takes (config.json `systemAudioCapture`, or the helper's presence). */
  systemCapture: SystemCaptureMode;
  /** Only Electron's fallback for call audio needs Screen Recording: null on the helper's tap. */
  screenRecording: SetupCheck<MediaAccessState> | null;
  notifications: SetupCheck<NotificationSetupState>;
  signing: SetupCheck<SigningSetupState>;
  api: SetupCheck<ConnectionSetupState>;
  /**
   * A speech-to-text token fetch only. It never opens a vendor session: every open is billed and
   * spends the per-minute open budget.
   */
  stt: SetupCheck<ConnectionSetupState>;
}

export interface SettingsPaneRequest {
  pane: SettingsPaneId;
}

/** The setup feature's part of `window.roger`. Each action answers the status after it. */
export interface SetupApi {
  getSetupStatus(): Promise<SetupStatus>;
  /** Asks macOS for the mic; its dialog shows only while the state is `not-determined`. */
  requestMicrophoneAccess(): Promise<SetupStatus>;
  /** Plays a system sound and listens for it through the helper. */
  testSystemAudio(): Promise<SetupStatus>;
  /**
   * "I allowed it": rebuilds the tap, then probes again. A tap built while the macOS dialog was up
   * stays silent even after the grant.
   */
  confirmSystemAudioAllowed(): Promise<SetupStatus>;
  testNotification(): Promise<SetupStatus>;
  openSettingsPane(request: SettingsPaneRequest): Promise<void>;
  /** Quits and reopens Roger: some grants only reach a new process. */
  relaunchRoger(): Promise<void>;
}
