import type { SystemCaptureMode } from '../../shared/capture';
import type {
  MediaAccessState,
  NotificationSetupState,
  SettingsPaneId,
  SetupCheck,
  SetupStatus,
  SigningSetupState,
  SystemAudioSetupState,
} from '../../shared/ipc/setup';
import type { SystemAudioSource } from '../audio/system/SystemAudioSource';
import type { SystemAudioVerification } from '../audio/system/systemAudioVerification';
import { errorMessage, type Logger } from '../logger';
import type { HelperLocation, HelperLookup } from '../native/helperPath';
import type { NotificationContent } from '../notify/Notifier';
import { SETTINGS_PANES } from '../settingsPanes';
import type { SigningIdentity } from '../signing';
import type { TranscriptStore } from '../store/TranscriptStore';
import type { ConnectionResults } from './connectionChecks';
import type { ProbeOutcome } from './systemAudioProbe';

/**
 * The `app_state` key holding the signing requirement hash a probe last heard silence under. Its
 * one job: the first silent probe for an identity says `pending` ("answer the macOS dialog"), and
 * every later one `not-heard`. One key, one identity: a build signed another way is asked afresh
 * by macOS, so its first silence is `pending` again. Beside SYSTEM_AUDIO_VERIFIED_KEY
 * (audio/system/systemAudioVerification.ts), which says it was heard.
 */
export const SYSTEM_AUDIO_SILENT_KEY = 'setup.system-audio-silent-for';

/** What the test notification did: macOS showed it, refused it, or neither within the wait. */
export type NotificationTestOutcome =
  { kind: 'shown' } | { kind: 'failed'; error: string } | { kind: 'no-answer' };

/** The macOS and process calls the setup screen makes (electronSetupPorts.ts); tests pass fakes. */
export interface SetupPorts {
  /** `systemPreferences.getMediaAccessStatus`: macOS's answer now. It asks nothing. */
  mediaAccess(type: 'microphone' | 'screen'): MediaAccessState;
  /** `systemPreferences.askForMediaAccess('microphone')`: the dialog, only while not determined. */
  askForMicrophone(): Promise<boolean>;
  /** How this copy of Roger is signed (signing.ts); rejects when codesign cannot tell. */
  readSigningIdentity(): Promise<SigningIdentity>;
  /** Where the call audio helper is now (native/helperPath.ts `findHelper`); may throw. */
  findHelper(): HelperLookup;
  /** One probe: the helper listens while the test sound plays (systemAudioProbe.ts). */
  probe(helper: HelperLocation): Promise<ProbeOutcome>;
  postTestNotification(content: NotificationContent): Promise<NotificationTestOutcome>;
  /** The API and token checks (connectionChecks.ts). */
  checkConnections(): Promise<ConnectionResults>;
  /** `shell.openExternal`. */
  openExternal(url: string): Promise<void>;
  /** Quits and starts Roger again. */
  relaunch(): void;
}

export interface PermissionServiceOptions {
  ports: SetupPorts;
  /**
   * Call audio as `[slot M2-T10]` chose it: its mode, its tap rebuild, and the tap's "verified"
   * proof, which a heard probe adds to (null on Electron's path).
   */
  systemAudio: {
    source: Pick<SystemAudioSource, 'mode' | 'rebuild'>;
    verification: Pick<SystemAudioVerification, 'ready' | 'verified' | 'markHeard'> | null;
  };
  store: Pick<TranscriptStore, 'getAppState' | 'setAppState'>;
  /** `app.isPackaged`: a development build's grants belong to the terminal that started it. */
  isPackaged: boolean;
  logger: Logger;
  clock?: () => number;
}

type Check<State extends string> = SetupCheck<State>;

const check = <State extends string>(
  state: State,
  message: string | null = null,
  relaunchNeeded = false,
): Check<State> => ({ state, message, relaunchNeeded });

/** The signing identity as read once: codesign's answer, or why it gave none. */
type IdentityRead = { identity: SigningIdentity } | { error: unknown };

const TEST_NOTIFICATION: NotificationContent = {
  title: 'Roger can reach you',
  body: 'This is how Roger tells you when a recording stops hearing you.',
};

/**
 * The permission setup screen's checks and actions (M2-T19; the channels in shared/ipc/setup.ts):
 * microphone, call audio (System Audio Recording through the helper's probe, or Screen Recording
 * on Electron's fallback path), notifications, how this copy is signed, the Roger API and a
 * speech-to-text token. Every message is for people: what is wrong, and for a permission the pane
 * and the switch that fix it (SETTINGS_PANES). Each action answers the whole status after it.
 */
export class PermissionService {
  private readonly clock: () => number;
  private identity: Promise<IdentityRead> | null = null;
  private connections: Promise<ConnectionResults> | null = null;
  private probing: Promise<void> | null = null;
  /** What this run's last answered probe heard; null until one answered. */
  private lastProbe: 'heard' | 'silent' | null = null;
  /** After a silent probe: whether it was the first for this identity. */
  private silentState: 'pending' | 'not-heard' = 'pending';
  /** A silent probe this run, for an identity with no hash to store it under. */
  private silentThisRun = false;
  /** Why the last test gave no answer, until the next one does. */
  private probeProblem: string | null = null;
  private notification: Check<NotificationSetupState> = check('unknown');

  constructor(private readonly options: PermissionServiceOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  private get mode(): SystemCaptureMode {
    return this.options.systemAudio.source.mode;
  }

  async status(): Promise<SetupStatus> {
    const [signing, connections] = await Promise.all([
      this.signingCheck(),
      this.checkConnections(),
    ]);
    await this.options.systemAudio.verification?.ready;
    return {
      microphone: this.microphoneCheck(),
      systemAudio: this.systemAudioCheck(),
      systemCapture: this.mode,
      screenRecording: this.mode === 'electron' ? this.screenCheck() : null,
      notifications: this.notification,
      signing,
      api: connections.api,
      stt: connections.stt,
    };
  }

  async requestMicrophone(): Promise<SetupStatus> {
    const { ports, logger } = this.options;
    // macOS shows its dialog once per signing identity; after an answer the call shows nothing and
    // the person must use System Settings, which the row then says.
    if (ports.mediaAccess('microphone') === 'not-determined') {
      let granted: boolean;
      try {
        granted = await ports.askForMicrophone();
      } catch (error) {
        throw new Error(`Roger could not ask macOS for the microphone: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      logger.info('microphone asked for', { granted });
    }
    return this.status();
  }

  async testSystemAudio(): Promise<SetupStatus> {
    if (this.mode === 'electron') {
      throw new Error(
        'Roger records call audio through Screen Recording on this Mac, not through its audio helper, so there is no sound test to run.',
      );
    }
    this.probing ??= this.probe().finally(() => {
      this.probing = null;
    });
    await this.probing;
    return this.status();
  }

  /**
   * "I allowed it": a tap built while the macOS dialog was up stays silent after the grant, so the
   * recording's tap is rebuilt (nothing to rebuild when none runs) before the probe builds its own.
   */
  async confirmSystemAudioAllowed(): Promise<SetupStatus> {
    this.options.systemAudio.source.rebuild('the person said they allowed System Audio Recording');
    return this.testSystemAudio();
  }

  async testNotification(): Promise<SetupStatus> {
    const outcome = await this.options.ports.postTestNotification(TEST_NOTIFICATION);
    this.options.logger.info('test notification', {
      outcome: outcome.kind,
      error: outcome.kind === 'failed' ? outcome.error : null,
    });
    switch (outcome.kind) {
      case 'shown':
        this.notification = check('shown');
        break;
      case 'failed':
        this.notification = check(
          'failed',
          `macOS did not show Roger's test notification (${outcome.error}). Until it does, Roger bounces its Dock icon when something goes wrong. Turn on Allow notifications under System Settings > Notifications > Roger.`,
        );
        break;
      case 'no-answer':
        this.notification = check(
          'unknown',
          'macOS has not shown the test notification yet. If it asked whether Roger may send notifications, answer it, then press Test again.',
        );
        break;
    }
    return this.status();
  }

  async openSettingsPane(pane: SettingsPaneId): Promise<void> {
    const { url, where } = SETTINGS_PANES[pane];
    try {
      await this.options.ports.openExternal(url);
    } catch (error) {
      throw new Error(`Roger could not open ${where}: ${errorMessage(error)}`, { cause: error });
    }
    this.options.logger.info('settings pane opened', { pane });
  }

  relaunch(): void {
    this.options.logger.info('relaunching from the setup screen');
    this.options.ports.relaunch();
  }

  /** One check of the server at a time: the banner and the screen read the status together. */
  private checkConnections(): Promise<ConnectionResults> {
    this.connections ??= this.options.ports.checkConnections().finally(() => {
      this.connections = null;
    });
    return this.connections;
  }

  private readIdentity(): Promise<IdentityRead> {
    // Read once: codesign takes a moment, and the identity of a running process never changes.
    this.identity ??= this.options.ports.readSigningIdentity().then(
      (identity) => ({ identity }),
      (error: unknown) => {
        this.options.logger.warn('signing identity not read for the setup screen', {
          error: errorMessage(error),
        });
        return { error };
      },
    );
    return this.identity;
  }

  private async signingCheck(): Promise<Check<SigningSetupState>> {
    const read = await this.readIdentity();
    if (!('identity' in read)) {
      return check(
        'unknown',
        'Roger could not read its own signature, so it cannot tell whether macOS will keep its permissions.',
      );
    }
    const { kind } = read.identity;
    if (!this.options.isPackaged) {
      // signing.ts reads process.execPath: in `make dev-desktop` that is Electron.app, which is not
      // what macOS checks (apps/desktop/CLAUDE.md, the first failure-log line).
      return check(
        kind,
        'This is a development build: macOS keeps its permissions for the terminal that started it, where call audio stays silent. Install Roger with make install-desktop to test call audio.',
      );
    }
    switch (kind) {
      case 'local-identity':
      case 'developer-id':
        return check(kind);
      case 'adhoc':
        return check(
          kind,
          "This copy of Roger is signed ad hoc, so macOS forgets its permissions every time it is rebuilt. Install it with make install-desktop, which signs it with this Mac's own identity.",
        );
      case 'unsigned':
        return check(
          kind,
          'This copy of Roger is not signed, so macOS cannot keep its permissions. Install it with make install-desktop.',
        );
    }
  }

  private microphoneCheck(): Check<MediaAccessState> {
    const state = this.options.ports.mediaAccess('microphone');
    const { where } = SETTINGS_PANES.microphone;
    switch (state) {
      case 'granted':
        return check(state);
      case 'not-determined':
        return check(
          state,
          'Roger has not asked for the microphone yet. Press Allow, then answer the macOS dialog.',
        );
      case 'denied':
        return check(
          state,
          `Roger is not allowed to use the microphone. Turn on Roger under ${where}, then relaunch Roger.`,
          true,
        );
      case 'restricted':
        return check(state, restrictedMessage('the microphone'));
      case 'unknown':
        return check(
          state,
          `macOS did not say whether Roger may use the microphone. Check that Roger is on under ${where}.`,
        );
    }
  }

  /** Electron's fallback for call audio needs Screen Recording (M2 D1). */
  private screenCheck(): Check<MediaAccessState> {
    const state = this.options.ports.mediaAccess('screen');
    const { where } = SETTINGS_PANES.screenRecording;
    switch (state) {
      case 'granted':
        return check(state);
      case 'not-determined':
        return check(
          state,
          'Roger asks for Screen Recording at the first Start: allow it in the macOS dialog, then relaunch Roger.',
        );
      case 'denied':
        return check(
          state,
          `Roger is not allowed to record the screen, which it needs for call audio on this Mac. Turn on Roger under ${where}, then relaunch Roger.`,
          true,
        );
      case 'restricted':
        return check(state, restrictedMessage('screen recording'));
      case 'unknown':
        return check(
          state,
          `macOS did not say whether Roger may record the screen. Check that Roger is on under ${where}.`,
        );
    }
  }

  private systemAudioCheck(): Check<SystemAudioSetupState> {
    // On Electron's path the Screen Recording row stands for call audio (status().screenRecording).
    if (this.mode === 'electron') return check('unknown');
    const missing = this.helperMissing();
    if (missing !== null) return check('unknown', missing);
    const state = this.systemAudioState();
    if (this.probeProblem !== null) {
      return check(
        state,
        `Roger could not finish the test: ${this.probeProblem}. Press Test again.`,
      );
    }
    switch (state) {
      case 'unknown':
      case 'verified':
        return check(state);
      case 'pending':
        return check(
          state,
          'Roger heard nothing. If macOS is asking whether Roger may record system audio, allow it, then press I allowed it.',
        );
      case 'not-heard':
        return check(
          state,
          `Roger heard nothing: it is not allowed to record system audio, or this Mac is muted. Turn on Roger under ${SETTINGS_PANES.systemAudio.where} and turn the sound up, then press Test again.`,
          true,
        );
    }
  }

  private systemAudioState(): SystemAudioSetupState {
    // A silence heard after the proof wins over it: the switch may have been turned off since.
    if (this.lastProbe === 'silent') return this.silentState;
    if (this.lastProbe === 'heard' || this.options.systemAudio.verification?.verified === true) {
      return 'verified';
    }
    return 'unknown';
  }

  /** Why the helper cannot run here, for people, or null when it can. */
  private helperMissing(): string | null {
    const lookup = this.lookUpHelper();
    if (lookup.found) return null;
    this.options.logger.warn('setup: no call audio helper to probe with', {
      reason: lookup.reason,
    });
    return this.options.isPackaged
      ? "Roger's call audio helper is missing from this copy of Roger, so it cannot record call audio. Reinstall Roger with make install-desktop."
      : "Roger's call audio helper is not built, so it cannot record call audio. Build it with make native.";
  }

  private lookUpHelper(): HelperLookup | { found: false; reason: string } {
    try {
      return this.options.ports.findHelper();
    } catch (error) {
      // A relative app path or a failed access check: no helper to run (selectSystemAudio.ts).
      return { found: false, reason: errorMessage(error) };
    }
  }

  private async probe(): Promise<void> {
    const { ports, systemAudio } = this.options;
    const lookup = this.lookUpHelper();
    if (!lookup.found) return;
    let outcome = await ports.probe(lookup.location);
    // No answer says nothing about the permission (a route change, a tap that failed): probe once
    // more rather than leave the person a test that did nothing. Never counted as a silence.
    if (outcome.kind === 'no-answer') outcome = await ports.probe(lookup.location);
    switch (outcome.kind) {
      case 'heard':
        this.probeProblem = null;
        this.lastProbe = 'heard';
        systemAudio.verification?.markHeard('probe');
        return;
      case 'silent':
        this.probeProblem = null;
        this.silentState = await this.recordSilence();
        this.lastProbe = 'silent';
        return;
      case 'no-answer':
        this.probeProblem = outcome.detail;
        return;
    }
  }

  /** Whether this silence is the first for this signing identity, and remembers that it came. */
  private async recordSilence(): Promise<'pending' | 'not-heard'> {
    const { store, logger } = this.options;
    const read = await this.readIdentity();
    const hash = 'identity' in read ? read.identity.requirementHash : null;
    if (this.silentThisRun || hash === null) {
      const first = !this.silentThisRun;
      this.silentThisRun = true;
      return first ? 'pending' : 'not-heard';
    }
    this.silentThisRun = true;
    try {
      if (store.getAppState(SYSTEM_AUDIO_SILENT_KEY)?.value === hash) return 'not-heard';
      store.setAppState(SYSTEM_AUDIO_SILENT_KEY, hash, new Date(this.clock()).toISOString());
    } catch (error) {
      // This run still knows; the next launch may say `pending` once more, no worse.
      logger.error('system audio silence not remembered', { error: errorMessage(error) });
    }
    return 'pending';
  }
}

function restrictedMessage(what: string): string {
  return `Something that manages this Mac (a device profile or Screen Time) blocks ${what} for Roger. Ask whoever manages it.`;
}
