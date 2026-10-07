import type { CaptureService } from '../../capture/CaptureService';
import type { SystemAudioCaptureSetting } from '../../config';
import type { QuitHook } from '../../lifecycle';
import type { Logger } from '../../logger';
import { HELPER_STDIN_GRACE_MS, HELPER_TERM_KILL_MS } from '../../native/HelperProcess';
import type { HelperPathContext } from '../../native/helperPath';
import type { SigningIdentity } from '../../signing';
import type { TranscriptStore } from '../../store/TranscriptStore';
import { ElectronSystemAudio } from './ElectronSystemAudio';
import { selectSystemAudio } from './selectSystemAudio';
import type { SystemAudioSource } from './SystemAudioSource';
import { SystemAudioVerification } from './systemAudioVerification';
import { TapSystemAudio } from './TapSystemAudio';

export interface SystemAudioDeps {
  /** config.json's `systemAudioCapture`. */
  setting: SystemAudioCaptureSetting;
  /** Where this build keeps the helper (`app.isPackaged`, `process.resourcesPath`, ...). */
  helperContext: HelperPathContext;
  capture: Pick<
    CaptureService,
    'onRecording' | 'addStatusContributor' | 'refreshStatus' | 'pushAudio' | 'reportSourceState'
  >;
  store: Pick<TranscriptStore, 'addCaptureEvent' | 'getAppState' | 'setAppState'>;
  logger: Logger;
  /** This build's signing identity (`readSigningIdentity(process.execPath)`), read for the tap only. */
  readSigningIdentity: () => Promise<SigningIdentity>;
  /** Calls `listener` whenever a Roger window gains focus (`app.on('browser-window-focus')`). */
  onWindowFocus: (listener: () => void) => void;
  clock?: () => number;
  /** The helper's environment; process.env by default. */
  env?: NodeJS.ProcessEnv;
}

export interface SystemAudio {
  /**
   * Call audio, tap or Electron. M2-T18 restarts it at wake (`restart`); M2-T19 rebuilds the tap
   * after "I allowed it" (`rebuild`).
   */
  source: SystemAudioSource;
  /**
   * The tap's "system audio verified" for this signing identity; M2-T19's probe marks it heard too.
   * Null on Electron's path, which the tap's proof says nothing about.
   */
  verification: SystemAudioVerification | null;
  /** Stops the helper at quit, after the recording's own stop; bounded by its kill sequence. */
  quitHook: QuitHook;
}

/**
 * Call audio for as long as Roger runs (M2-T10): picks the tap or Electron's path once
 * (selectSystemAudio.ts), and follows each recording through CaptureService's seams. `[slot
 * M2-T10]` in capture/createCaptureRuntime.ts calls it with Electron's `app`.
 */
export function createSystemAudio(deps: SystemAudioDeps): SystemAudio {
  const { capture, logger, store } = deps;
  const clock = deps.clock ?? (() => Date.now());
  const selection = selectSystemAudio(deps.setting, deps.helperContext);
  let source: SystemAudioSource;
  let verification: SystemAudioVerification | null = null;
  if (selection.mode === 'tap') {
    logger.info('call audio capture chosen', {
      systemCapture: 'tap',
      helper: selection.helper?.origin ?? null,
      path: selection.helper?.path ?? null,
      missing: selection.helper === null ? selection.missing : null,
    });
    verification = new SystemAudioVerification({
      store,
      identity: deps.readSigningIdentity(),
      logger,
      clock,
      onChange: () => {
        capture.refreshStatus();
      },
    });
    source = new TapSystemAudio({
      selection,
      capture,
      store,
      verification,
      logger,
      clock,
      env: deps.env ?? process.env,
    });
  } else {
    logger.info('call audio capture chosen', {
      systemCapture: 'electron',
      reason: selection.reason,
    });
    source = new ElectronSystemAudio();
  }
  capture.onRecording({
    started: (recording) => {
      source.start(recording);
    },
    ended: () => {
      // Also after a Stop that failed (`stopFailed`): no helper outlives its recording.
      void source.stop();
    },
  });
  capture.addStatusContributor('system-audio', (context) => source.status(context));
  deps.onWindowFocus(() => {
    source.windowFocused();
  });
  return {
    source,
    verification,
    quitHook: {
      name: 'stop the call audio helper',
      // stdin, then SIGTERM, then SIGKILL (HelperProcess.stop), with a second to spare.
      timeoutMs: HELPER_STDIN_GRACE_MS + HELPER_TERM_KILL_MS + 1_000,
      run: () => source.stop(),
    },
  };
}
