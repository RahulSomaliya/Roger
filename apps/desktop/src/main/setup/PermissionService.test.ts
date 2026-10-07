import { describe, expect, it, vi } from 'vitest';
import type { SystemCaptureMode } from '../../shared/capture';
import type { MediaAccessState, SetupStatus } from '../../shared/ipc/setup';
import {
  SYSTEM_AUDIO_VERIFIED_KEY,
  SystemAudioVerification,
} from '../audio/system/systemAudioVerification';
import { createLogger } from '../logger';
import type { HelperLookup } from '../native/helperPath';
import { SETTINGS_PANES } from '../settingsPanes';
import { SigningCheckError, type SigningIdentity } from '../signing';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import type { ConnectionResults } from './connectionChecks';
import {
  type NotificationTestOutcome,
  PermissionService,
  SYSTEM_AUDIO_SILENT_KEY,
  type SetupPorts,
} from './PermissionService';
import type { ProbeOutcome } from './systemAudioProbe';

const LOCAL_HASH = 'a'.repeat(64);
const LOCAL: SigningIdentity = {
  kind: 'local-identity',
  requirement: 'identifier "ai.linkt.roger" and certificate leaf = H"b4570000"',
  requirementHash: LOCAL_HASH,
};
const ADHOC: SigningIdentity = {
  kind: 'adhoc',
  requirement: 'cdhash H"0123456789abcdef"',
  requirementHash: 'b'.repeat(64),
};

const HELPER: HelperLookup = {
  found: true,
  location: {
    origin: 'bundle',
    path: '/Applications/Roger.app/Contents/Resources/bin/roger-audio',
  },
};

const HEARD: ProbeOutcome = { kind: 'heard', peak: 9_000, audioMs: 2_000 };
const SILENT: ProbeOutcome = { kind: 'silent', audioMs: 2_000 };
const ROUTE_CHANGED: ProbeOutcome = {
  kind: 'no-answer',
  code: 'route_changed',
  detail: 'the sound output changed while Roger listened',
};

const CONNECTED: ConnectionResults = {
  api: { state: 'ok', message: null, relaunchNeeded: false },
  stt: { state: 'ok', message: null, relaunchNeeded: false },
};

interface HarnessOptions {
  microphone?: MediaAccessState;
  screen?: MediaAccessState;
  mode?: SystemCaptureMode;
  identity?: SigningIdentity | Error;
  helper?: HelperLookup;
  probes?: ProbeOutcome[];
  notification?: NotificationTestOutcome;
  isPackaged?: boolean;
  store?: InMemoryTranscriptStore;
}

function harness(options: HarnessOptions = {}) {
  const access: Record<'microphone' | 'screen', MediaAccessState> = {
    microphone: options.microphone ?? 'granted',
    screen: options.screen ?? 'granted',
  };
  const identity = options.identity ?? LOCAL;
  const readIdentity = (): Promise<SigningIdentity> =>
    identity instanceof Error ? Promise.reject(identity) : Promise.resolve(identity);
  const probes = [...(options.probes ?? [])];
  const store = options.store ?? new InMemoryTranscriptStore();
  const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
  const ports = {
    mediaAccess: vi.fn((type: 'microphone' | 'screen') => access[type]),
    askForMicrophone: vi.fn(() => {
      access.microphone = 'granted';
      return Promise.resolve(true);
    }),
    readSigningIdentity: vi.fn(readIdentity),
    findHelper: vi.fn(() => options.helper ?? HELPER),
    probe: vi.fn(() => {
      const next = probes.shift();
      if (next === undefined) throw new Error('this test planned no more probes');
      return Promise.resolve(next);
    }),
    postTestNotification: vi.fn(() =>
      Promise.resolve<NotificationTestOutcome>(options.notification ?? { kind: 'shown' }),
    ),
    checkConnections: vi.fn(() => Promise.resolve(CONNECTED)),
    openExternal: vi.fn((_url: string) => Promise.resolve()),
    relaunch: vi.fn(),
  } satisfies SetupPorts;
  const mode = options.mode ?? 'tap';
  const verification =
    mode === 'tap'
      ? new SystemAudioVerification({ store, identity: readIdentity(), logger })
      : null;
  const rebuild = vi.fn();
  const service = new PermissionService({
    ports,
    systemAudio: { source: { mode, rebuild }, verification },
    store,
    isPackaged: options.isPackaged ?? true,
    logger,
    clock: () => Date.parse('2026-10-07T09:00:00.000Z'),
  });
  return { service, ports, store, rebuild, access, verification };
}

describe('the microphone row', () => {
  it('is fine once macOS says granted', async () => {
    const { service } = harness();
    expect((await service.status()).microphone).toEqual({
      state: 'granted',
      message: null,
      relaunchNeeded: false,
    });
  });

  it('asks for the microphone only while macOS has never asked (a first run)', async () => {
    const { service, ports } = harness({ microphone: 'not-determined' });
    const before = await service.status();
    expect(before.microphone).toEqual({
      state: 'not-determined',
      message:
        'Roger has not asked for the microphone yet. Press Allow, then answer the macOS dialog.',
      relaunchNeeded: false,
    });
    const after = await service.requestMicrophone();
    expect(ports.askForMicrophone).toHaveBeenCalledTimes(1);
    expect(after.microphone.state).toBe('granted');
  });

  it('names the pane and the switch when denied, and offers a relaunch; it never asks again', async () => {
    const { service, ports } = harness({ microphone: 'denied' });
    const status = await service.requestMicrophone();
    // macOS shows its dialog once per identity: asking again would show nothing.
    expect(ports.askForMicrophone).not.toHaveBeenCalled();
    expect(status.microphone).toEqual({
      state: 'denied',
      message: `Roger is not allowed to use the microphone. Turn on Roger under ${SETTINGS_PANES.microphone.where}, then relaunch Roger.`,
      relaunchNeeded: true,
    });
  });

  it('says who blocks a restricted microphone', async () => {
    const { service } = harness({ microphone: 'restricted' });
    expect((await service.status()).microphone).toEqual({
      state: 'restricted',
      message:
        'Something that manages this Mac (a device profile or Screen Time) blocks the microphone for Roger. Ask whoever manages it.',
      relaunchNeeded: false,
    });
  });
});

describe('the system audio row', () => {
  it('is not tested yet on a fresh identity, with nothing wrong to say', async () => {
    const { service } = harness();
    const status = await service.status();
    expect(status.systemCapture).toBe('tap');
    expect(status.screenRecording).toBeNull();
    expect(status.systemAudio).toEqual({ state: 'unknown', message: null, relaunchNeeded: false });
  });

  it('is verified once a probe hears the test sound, and stores that for this identity', async () => {
    const { service, store, ports } = harness({ probes: [HEARD] });
    const status = await service.testSystemAudio();
    expect(ports.probe).toHaveBeenCalledWith(HELPER.location);
    expect(status.systemAudio).toEqual({ state: 'verified', message: null, relaunchNeeded: false });
    expect(store.getAppState(SYSTEM_AUDIO_VERIFIED_KEY)?.value).toBe(LOCAL.requirementHash);
  });

  it('is pending after the first silent probe for an identity, then not heard after the next', async () => {
    const { service } = harness({ probes: [SILENT, SILENT] });
    const pending = await service.testSystemAudio();
    expect(pending.systemAudio).toEqual({
      state: 'pending',
      message:
        'Roger heard nothing. If macOS is asking whether Roger may record system audio, allow it, then press I allowed it.',
      relaunchNeeded: false,
    });
    const refused = await service.testSystemAudio();
    expect(refused.systemAudio).toEqual({
      state: 'not-heard',
      message: `Roger heard nothing: it is not allowed to record system audio, or this Mac is muted. Turn on Roger under ${SETTINGS_PANES.systemAudio.where} and turn the sound up, then press Test again.`,
      relaunchNeeded: true,
    });
  });

  it('spends `pending` once per identity, across launches', async () => {
    const store = new InMemoryTranscriptStore();
    const first = harness({ store, probes: [SILENT] });
    expect((await first.service.testSystemAudio()).systemAudio.state).toBe('pending');
    expect(store.getAppState(SYSTEM_AUDIO_SILENT_KEY)?.value).toBe(LOCAL.requirementHash);
    // Roger relaunched: not probed since it started, so nothing is known yet.
    const relaunched = harness({ store, probes: [SILENT] });
    expect((await relaunched.service.status()).systemAudio.state).toBe('unknown');
    expect((await relaunched.service.testSystemAudio()).systemAudio.state).toBe('not-heard');
    // A new signing identity is asked afresh by macOS, so its first silence is pending again.
    const resigned = harness({ store, identity: ADHOC, probes: [SILENT] });
    expect((await resigned.service.testSystemAudio()).systemAudio.state).toBe('pending');
  });

  it('never spends `pending` on a probe that gave no answer: it probes again', async () => {
    const { service, ports } = harness({ probes: [ROUTE_CHANGED, SILENT] });
    const status = await service.testSystemAudio();
    expect(ports.probe).toHaveBeenCalledTimes(2);
    expect(status.systemAudio.state).toBe('pending');
  });

  it('keeps the state and says why when two probes in a row give no answer', async () => {
    const { service } = harness({ probes: [ROUTE_CHANGED, ROUTE_CHANGED, SILENT] });
    const status = await service.testSystemAudio();
    expect(status.systemAudio).toEqual({
      state: 'unknown',
      message:
        'Roger could not finish the test: the sound output changed while Roger listened. Press Test again.',
      relaunchNeeded: false,
    });
    // The next real silence is still the first for this identity.
    expect((await service.testSystemAudio()).systemAudio.state).toBe('pending');
  });

  it('takes call audio a recording heard after a silent test as the proof', async () => {
    const { service, verification } = harness({ probes: [SILENT, SILENT] });
    await service.testSystemAudio();
    expect((await service.testSystemAudio()).systemAudio.state).toBe('not-heard');
    // The person unmuted and recorded a call: the tap heard it (TapSystemAudio).
    verification?.markHeard('tap');
    expect((await service.status()).systemAudio).toEqual({
      state: 'verified',
      message: null,
      relaunchNeeded: false,
    });
  });

  it('takes a heard call over the first silence too, which asked for I allowed it', async () => {
    const { service, verification } = harness({ probes: [SILENT] });
    expect((await service.testSystemAudio()).systemAudio.state).toBe('pending');
    verification?.markHeard('tap');
    expect((await service.status()).systemAudio.state).toBe('verified');
  });

  it('lets a silent test outweigh a proof from before it: the switch may be off since', async () => {
    const store = new InMemoryTranscriptStore();
    store.setAppState(SYSTEM_AUDIO_VERIFIED_KEY, LOCAL_HASH, '2026-10-01T09:00:00.000Z');
    const { service } = harness({ store, probes: [SILENT] });
    expect((await service.status()).systemAudio.state).toBe('verified');
    expect((await service.testSystemAudio()).systemAudio.state).toBe('pending');
  });

  it('rebuilds the tap before probing again when the person says they allowed it', async () => {
    const { service, rebuild, ports } = harness({ probes: [SILENT, HEARD] });
    await service.testSystemAudio();
    const status = await service.confirmSystemAudioAllowed();
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(rebuild.mock.invocationCallOrder[0]).toBeLessThan(
      ports.probe.mock.invocationCallOrder[1] ?? 0,
    );
    expect(status.systemAudio.state).toBe('verified');
  });

  it('runs one probe for two presses at once', async () => {
    const { service, ports } = harness({ probes: [HEARD] });
    const [one, two] = await Promise.all([service.testSystemAudio(), service.testSystemAudio()]);
    expect(ports.probe).toHaveBeenCalledTimes(1);
    expect(one.systemAudio.state).toBe('verified');
    expect(two.systemAudio.state).toBe('verified');
  });

  it('says the helper is missing, and how to get it, for each kind of build', async () => {
    const missing: HelperLookup = {
      found: false,
      location: HELPER.location,
      reason: `no audio helper at ${HELPER.location.path}`,
    };
    const installed = harness({ helper: missing });
    expect((await installed.service.status()).systemAudio).toEqual({
      state: 'unknown',
      message:
        "Roger's call audio helper is missing from this copy of Roger, so it cannot record call audio. Reinstall Roger with make install-desktop.",
      relaunchNeeded: false,
    });
    const dev = harness({ helper: missing, isPackaged: false });
    expect((await dev.service.status()).systemAudio.message).toBe(
      "Roger's call audio helper is not built, so it cannot record call audio. Build it with make native.",
    );
    expect(installed.ports.probe).not.toHaveBeenCalled();
  });

  it('says why Test does nothing without the helper, rather than answering the same status', async () => {
    const missing: HelperLookup = {
      found: false,
      location: HELPER.location,
      reason: `no audio helper at ${HELPER.location.path}`,
    };
    const installed = harness({ helper: missing });
    await expect(installed.service.testSystemAudio()).rejects.toThrow(
      'Roger has no call audio helper to test with. Reinstall Roger with make install-desktop.',
    );
    expect(installed.ports.probe).not.toHaveBeenCalled();
    const dev = harness({ helper: missing, isPackaged: false });
    await expect(dev.service.confirmSystemAudioAllowed()).rejects.toThrow(
      'Roger has no call audio helper to test with. Build it with make native.',
    );
    // The failed press leaves nothing behind: the next one asks again.
    await expect(installed.service.testSystemAudio()).rejects.toThrow('no call audio helper');
  });

  it('shows Screen Recording instead on the Electron path, and runs no probe there', async () => {
    const { service, ports } = harness({ mode: 'electron', screen: 'denied' });
    const status = await service.status();
    expect(status.systemCapture).toBe('electron');
    expect(status.systemAudio).toEqual({ state: 'unknown', message: null, relaunchNeeded: false });
    expect(status.screenRecording).toEqual({
      state: 'denied',
      message: `Roger is not allowed to record the screen, which it needs for call audio on this Mac. Turn on Roger under ${SETTINGS_PANES.screenRecording.where}, then relaunch Roger.`,
      relaunchNeeded: true,
    });
    await expect(service.testSystemAudio()).rejects.toThrow(
      'Roger records call audio through Screen Recording on this Mac',
    );
    expect(ports.probe).not.toHaveBeenCalled();
  });
});

describe('the notifications row', () => {
  it('is not tested until the person asks, then says what macOS did', async () => {
    const { service, ports } = harness();
    expect((await service.status()).notifications).toEqual({
      state: 'unknown',
      message: null,
      relaunchNeeded: false,
    });
    expect((await service.testNotification()).notifications).toEqual({
      state: 'shown',
      message: null,
      relaunchNeeded: false,
    });
    expect(ports.postTestNotification).toHaveBeenCalledTimes(1);
  });

  it('says where to allow them when macOS refuses, and that the Dock stands in', async () => {
    const { service } = harness({
      notification: { kind: 'failed', error: 'Notifications are not allowed for this application' },
    });
    expect((await service.testNotification()).notifications).toEqual({
      state: 'failed',
      message:
        "macOS did not show Roger's test notification (Notifications are not allowed for this application). Until it does, Roger bounces its Dock icon when something goes wrong. Turn on Allow notifications under System Settings > Notifications > Roger.",
      relaunchNeeded: false,
    });
  });

  it('says it is still waiting when macOS neither showed nor refused it', async () => {
    const { service } = harness({ notification: { kind: 'no-answer' } });
    expect((await service.testNotification()).notifications).toEqual({
      state: 'unknown',
      message:
        'macOS has not shown the test notification yet. If it asked whether Roger may send notifications, answer it, then press Test again.',
      relaunchNeeded: false,
    });
  });
});

describe('the signing row', () => {
  it('is fine for a build signed with this Mac identity', async () => {
    const { service } = harness();
    expect((await service.status()).signing).toEqual({
      state: 'local-identity',
      message: null,
      relaunchNeeded: false,
    });
  });

  it('warns that an ad-hoc build loses its permissions on every rebuild', async () => {
    const { service } = harness({ identity: ADHOC });
    expect((await service.status()).signing).toEqual({
      state: 'adhoc',
      message:
        "This copy of Roger is signed ad hoc, so macOS forgets its permissions every time it is rebuilt. Install it with make install-desktop, which signs it with this Mac's own identity.",
      relaunchNeeded: false,
    });
  });

  it('says a development build asks macOS on behalf of the terminal', async () => {
    const { service } = harness({ identity: ADHOC, isPackaged: false });
    expect((await service.status()).signing.message).toBe(
      'This is a development build: macOS keeps its permissions for the terminal that started it, where call audio stays silent. Install Roger with make install-desktop to test call audio.',
    );
  });

  it('is unknown, in plain words, when codesign cannot tell, and reads it once', async () => {
    const { service, ports } = harness({
      identity: new SigningCheckError('codesign gave no answer within 10000 ms'),
    });
    const status = await service.status();
    expect(status.signing).toEqual({
      state: 'unknown',
      message:
        'Roger could not read its own signature, so it cannot tell whether macOS will keep its permissions.',
      relaunchNeeded: false,
    });
    await service.status();
    expect(ports.readSigningIdentity).toHaveBeenCalledTimes(1);
  });
});

describe('the server rows', () => {
  it('come from the connection checks, run once for two reads at once', async () => {
    const { service, ports } = harness();
    const [one, two] = await Promise.all([service.status(), service.status()]);
    expect(ports.checkConnections).toHaveBeenCalledTimes(1);
    expect(one.api).toEqual(CONNECTED.api);
    expect(two.stt).toEqual(CONNECTED.stt);
    await service.status();
    expect(ports.checkConnections).toHaveBeenCalledTimes(2);
  });
});

describe('the actions with no row of their own', () => {
  it('opens each pane by its deep link', async () => {
    const { service, ports } = harness();
    for (const pane of ['microphone', 'systemAudio', 'screenRecording'] as const) {
      await service.openSettingsPane(pane);
    }
    expect(ports.openExternal.mock.calls.map(([url]) => url)).toEqual([
      SETTINGS_PANES.microphone.url,
      SETTINGS_PANES.systemAudio.url,
      SETTINGS_PANES.screenRecording.url,
    ]);
  });

  it('says in plain words which pane would not open', async () => {
    const { service, ports } = harness();
    ports.openExternal.mockRejectedValueOnce(new Error('no application can open the URL'));
    await expect(service.openSettingsPane('microphone')).rejects.toThrow(
      `Roger could not open ${SETTINGS_PANES.microphone.where}: no application can open the URL`,
    );
  });

  it('relaunches through its port', () => {
    const { service, ports } = harness();
    service.relaunch();
    expect(ports.relaunch).toHaveBeenCalledTimes(1);
  });
});

it('answers every row of a status', async () => {
  const { service } = harness();
  const status: SetupStatus = await service.status();
  expect(Object.keys(status).sort()).toEqual([
    'api',
    'microphone',
    'notifications',
    'screenRecording',
    'signing',
    'stt',
    'systemAudio',
    'systemCapture',
  ]);
});
