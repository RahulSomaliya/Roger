import type { SetupCheck, SetupStatus } from '../../../../shared/ipc/setup';

/**
 * Setup statuses for the renderer's tests (not a test file: importing a constant from a
 * `*.test.ts` file would register its tests again). Each mirrors one Mac main can describe.
 */

export function fine<State extends string>(state: State): SetupCheck<State> {
  return { state, message: null, relaunchNeeded: false };
}

/** Everything granted and heard; the notification not tested yet (the preview fake's start). */
export function readyMac(): SetupStatus {
  return {
    microphone: fine('granted'),
    systemAudio: fine('verified'),
    systemCapture: 'tap',
    screenRecording: null,
    notifications: fine('unknown'),
    signing: fine('local-identity'),
    api: fine('ok'),
    stt: fine('ok'),
  };
}

/** Roger has never asked for anything on this Mac. */
export function firstRunMac(): SetupStatus {
  return {
    ...readyMac(),
    microphone: {
      state: 'not-determined',
      message:
        'Roger has not asked for the microphone yet. Press Allow, then answer the macOS dialog.',
      relaunchNeeded: false,
    },
    systemAudio: fine('unknown'),
  };
}

/** A Mac where the microphone was refused and Roger is signed ad hoc. */
export function refusedMac(): SetupStatus {
  return {
    ...readyMac(),
    microphone: {
      state: 'denied',
      message:
        'Roger is not allowed to use the microphone. Turn on Roger under System Settings > Privacy & Security > Microphone, then relaunch Roger.',
      relaunchNeeded: true,
    },
    systemAudio: {
      state: 'not-heard',
      message:
        'Roger heard nothing: it is not allowed to record system audio, or this Mac is muted. Turn on Roger under System Settings > Privacy & Security > Screen & System Audio Recording > System Audio Recording Only and turn the sound up, then press Test again.',
      relaunchNeeded: true,
    },
    signing: {
      state: 'adhoc',
      message:
        "This copy of Roger is signed ad hoc, so macOS forgets its permissions every time it is rebuilt. Install it with make install-desktop, which signs it with this Mac's own identity.",
      relaunchNeeded: false,
    },
    api: {
      state: 'failed',
      message:
        "Roger can't reach its server at http://127.0.0.1:8000. Check that the Roger API is running and that this Mac is online.",
      relaunchNeeded: false,
    },
    stt: {
      state: 'unknown',
      message: "Not checked: Roger can't reach its server.",
      relaunchNeeded: false,
    },
  };
}
