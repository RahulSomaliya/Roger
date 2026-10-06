import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CaptureWarning, WARNING_NOTIFY_INTERVAL_MS } from '../../shared/capture';
import { PCM_SAMPLE_RATE } from '../../shared/ipc';
import { ApiClient } from '../api/ApiClient';
import { createCaptureRuntime } from '../capture/createCaptureRuntime';
import { loadConfig } from '../config';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import { FakeSpeechToText } from '../stt/fake/FakeSpeechToText';
import { TranscriptUploader } from '../upload/TranscriptUploader';
import {
  electronNotifierPorts,
  type NotificationContent,
  Notifier,
  type NotifierPorts,
} from './Notifier';

// Electron's Notification, dock and focused window, as far as the Notifier uses them: no test
// here may post a real macOS notification. Hoisted, because vi.mock runs before the imports.
const electron = vi.hoisted(() => {
  type Listener = (event: unknown, error: string) => void;
  const state = {
    supported: true,
    focusedWindowId: null as number | null,
    bounces: [] as string[],
    badges: [] as string[],
  };
  class FakeNotification {
    static isSupported(): boolean {
      return state.supported;
    }
    readonly listeners = new Map<string, Listener[]>();
    constructor(readonly options: { title: string; body: string }) {}
    on(event: string, listener: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    show(): void {
      shown.push(this);
    }
    /** What macOS does later: `show` once posted, `failed` when it refused. */
    emit(event: string, error = ''): void {
      for (const listener of this.listeners.get(event) ?? []) listener({}, error);
    }
  }
  const shown: FakeNotification[] = [];
  return {
    state,
    shown,
    Notification: FakeNotification,
    app: {
      dock: {
        bounce: (type: string): number => {
          state.bounces.push(type);
          return state.bounces.length;
        },
        setBadge: (text: string): void => {
          state.badges.push(text);
        },
      },
    },
    BrowserWindow: {
      getFocusedWindow: () =>
        state.focusedWindowId === null ? null : { webContents: { id: state.focusedWindowId } },
    },
  };
});
vi.mock('electron', () => ({
  Notification: electron.Notification,
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
}));

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const T0 = Date.parse('2026-10-07T10:00:00.000Z');

beforeEach(() => {
  electron.state.supported = true;
  electron.state.focusedWindowId = null;
  electron.state.bounces.length = 0;
  electron.state.badges.length = 0;
  electron.shown.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

function warning(overrides: Partial<CaptureWarning> = {}): CaptureWarning {
  return {
    kind: 'mic-dead',
    source: 'mic',
    since: new Date(T0).toISOString(),
    message: 'The mic sends only silence.',
    loud: true,
    ...overrides,
  };
}

/** Ports that record what the Notifier asked of Electron. */
function fakePorts() {
  const ports = {
    posted: [] as NotificationContent[],
    bounces: 0,
    badges: [] as string[],
    focused: false,
    /** Set to make macOS refuse every notification, with this error. */
    failWith: null as string | null,
  };
  const api: NotifierPorts = {
    show: (content, onFailed) => {
      ports.posted.push(content);
      if (ports.failWith !== null) onFailed(ports.failWith);
    },
    bounceDock: () => {
      ports.bounces += 1;
    },
    setDockBadge: (text) => {
      ports.badges.push(text);
    },
    isFocused: () => ports.focused,
  };
  return { ports, api };
}

function harness() {
  let now = T0;
  const { ports, api } = fakePorts();
  const notifier = new Notifier({ ports: api, logger, clock: () => now });
  return {
    notifier,
    ports,
    at(ms: number): void {
      now = T0 + ms;
    },
    titles: () => ports.posted.map(({ title }) => title),
  };
}

describe('Notifier: warnings', () => {
  it('posts one notification per loud spell, however often the status repeats it', () => {
    const h = harness();
    for (let second = 0; second < 30; second += 1) {
      h.at(second * 1_000);
      h.notifier.updateWarnings([warning()]);
    }
    expect(h.ports.posted).toEqual([
      { title: 'Your mic is silent', body: 'The mic sends only silence.' },
    ]);
  });

  it('posts nothing for an on-screen warning, and posts when its spell turns loud', () => {
    const h = harness();
    const silent = warning({ kind: 'call-audio-silent', source: 'system', loud: false });
    h.notifier.updateWarnings([silent]);
    h.at(50_000);
    h.notifier.updateWarnings([silent]);
    expect(h.ports.posted).toEqual([]);
    h.at(52_000);
    h.notifier.updateWarnings([{ ...silent, loud: true, message: 'Silent for a minute.' }]);
    expect(h.ports.posted).toEqual([
      { title: 'Call audio is silent', body: 'Silent for a minute.' },
    ]);
  });

  it('posts the same kind and stream at most once every 2 minutes', () => {
    const h = harness();
    h.notifier.updateWarnings([warning()]);
    h.at(10_000);
    h.notifier.updateWarnings([]);
    // A new spell 60 s after the first was posted: held back for good, not posted later.
    h.at(60_000);
    h.notifier.updateWarnings([warning({ since: new Date(T0 + 52_000).toISOString() })]);
    h.at(WARNING_NOTIFY_INTERVAL_MS + 10_000);
    h.notifier.updateWarnings([warning({ since: new Date(T0 + 52_000).toISOString() })]);
    expect(h.ports.posted).toHaveLength(1);

    h.notifier.updateWarnings([]);
    h.at(WARNING_NOTIFY_INTERVAL_MS + 20_000);
    h.notifier.updateWarnings([warning({ since: new Date(T0 + 130_000).toISOString() })]);
    expect(h.ports.posted).toHaveLength(2);
  });

  it('forgets a spell once it ends: a later one dated the same is a new spell', () => {
    // WarningSpells dates a spell back by how long its condition held, in audio time, so a spell
    // that ends and comes back can carry the date of the one before.
    const h = harness();
    h.notifier.updateWarnings([warning()]);
    h.at(10_000);
    h.notifier.updateWarnings([]);
    h.at(WARNING_NOTIFY_INTERVAL_MS + 10_000);
    h.notifier.updateWarnings([warning()]);
    expect(h.ports.posted).toHaveLength(2);
  });

  it('always posts a different kind or the other stream: one cut never hides the next', () => {
    const h = harness();
    h.notifier.updateWarnings([warning()]);
    h.at(30_000);
    h.notifier.updateWarnings([
      warning(),
      warning({ kind: 'offline', source: null, message: 'The Mac is offline.' }),
    ]);
    h.at(40_000);
    h.notifier.updateWarnings([
      warning({ kind: 'no-audio', source: 'mic', message: 'No mic audio.' }),
      warning({ kind: 'no-audio', source: 'system', message: 'No call audio.' }),
    ]);
    expect(h.titles()).toEqual([
      'Your mic is silent',
      'Transcription is offline',
      'No audio from your mic',
      'No call audio',
    ]);
  });

  it('posts only while Roger is not in focus, and once it leaves focus if the spell lasts', () => {
    const h = harness();
    h.ports.focused = true;
    h.notifier.updateWarnings([warning()]);
    h.at(5_000);
    h.notifier.updateWarnings([warning()]);
    expect(h.ports.posted).toEqual([]);

    h.ports.focused = false;
    h.at(6_000);
    h.notifier.updateWarnings([warning()]);
    h.ports.focused = true;
    h.at(7_000);
    h.notifier.updateWarnings([warning()]);
    h.ports.focused = false;
    h.at(8_000);
    h.notifier.updateWarnings([warning()]);
    expect(h.ports.posted).toHaveLength(1);
  });

  it('bounces the dock and badges it when a notification fails, then clears the badge', () => {
    const h = harness();
    h.ports.failWith = 'Notifications are not allowed for this application';
    h.notifier.updateWarnings([warning()]);
    expect(h.ports.bounces).toBe(1);
    expect(h.ports.badges).toEqual(['!']);

    // Still unfocused and still wrong: the badge stays.
    h.at(1_000);
    h.notifier.updateWarnings([warning()]);
    expect(h.ports.badges).toEqual(['!']);
    // Roger comes into focus: its banner says the rest.
    h.ports.focused = true;
    h.notifier.updateWarnings([warning()]);
    expect(h.ports.badges).toEqual(['!', '']);
  });

  it('asks nothing of Electron on a status with no loud warning and no badge', () => {
    // Every status passes here (one per upload tick), and the runtime's tests mock `electron`
    // with `desktopCapturer` only: a focus check per status throws there.
    const { ports, api } = fakePorts();
    const isFocused = vi.fn(() => false);
    const notifier = new Notifier({ ports: { ...api, isFocused }, logger });
    notifier.updateWarnings([]);
    notifier.updateWarnings([
      warning({ kind: 'call-audio-silent', source: 'system', loud: false }),
    ]);
    expect(isFocused).not.toHaveBeenCalled();
    expect(ports.posted).toEqual([]);
  });

  it('clears the badge once no loud warning is left', () => {
    const h = harness();
    h.ports.failWith = 'denied';
    h.notifier.updateWarnings([warning()]);
    h.notifier.updateWarnings([
      warning({ kind: 'call-audio-silent', source: 'system', loud: false }),
    ]);
    expect(h.ports.badges).toEqual(['!', '']);
    h.notifier.updateWarnings([]);
    expect(h.ports.badges).toEqual(['!', '']);
  });
});

describe('Notifier.notify', () => {
  it('posts a one-off notification, and falls back to the dock when it fails', () => {
    const h = harness();
    h.notifier.notify({ title: 'Stopped', body: 'The call in Zoom ended.' });
    expect(h.ports.posted).toEqual([{ title: 'Stopped', body: 'The call in Zoom ended.' }]);
    expect(h.ports.bounces).toBe(0);
    h.ports.failWith = 'denied';
    h.notifier.notify({ title: 'Stopped', body: 'The call in Zoom ended.' });
    expect(h.ports.bounces).toBe(1);
    expect(h.ports.badges).toEqual(['!']);
  });

  it('keeps the badge of a failed one-off until Roger is in focus, whatever the warnings do', () => {
    const h = harness();
    h.ports.failWith = 'denied';
    h.notifier.notify({ title: 'Stopped', body: 'The call in Zoom ended.' });
    // The statuses after Stop hold no warning, and one comes at every upload tick (2 s).
    h.notifier.updateWarnings([]);
    h.at(2_000);
    h.notifier.updateWarnings([]);
    expect(h.ports.badges).toEqual(['!']);
    h.ports.focused = true;
    h.at(4_000);
    h.notifier.updateWarnings([]);
    expect(h.ports.badges).toEqual(['!', '']);
  });

  it('keeps one badge while a failed warning or a failed one-off still has it', () => {
    const h = harness();
    h.ports.failWith = 'denied';
    h.notifier.updateWarnings([warning()]);
    h.notifier.notify({ title: 'Stopped', body: 'The call in Zoom ended.' });
    expect(h.ports.badges).toEqual(['!']);
    // The warning ended; the one-off is still unseen.
    h.notifier.updateWarnings([]);
    expect(h.ports.badges).toEqual(['!']);
    h.ports.focused = true;
    h.notifier.updateWarnings([]);
    expect(h.ports.badges).toEqual(['!', '']);
  });
});

describe('electronNotifierPorts', () => {
  const mainWindow = { webContents: { id: 7 } };

  it('posts an Electron notification with the title and body, and hands its failure on', () => {
    const ports = electronNotifierPorts(() => mainWindow);
    const failures: string[] = [];
    ports.show({ title: 'Your mic is silent', body: 'Check the mic.' }, (error) => {
      failures.push(error);
    });
    expect(electron.shown.map(({ options }) => options)).toEqual([
      { title: 'Your mic is silent', body: 'Check the mic.' },
    ]);
    electron.shown[0]?.emit('failed', 'UNErrorDomain error 1');
    expect(failures).toEqual(['UNErrorDomain error 1']);
  });

  it('fails at once where notifications are not supported, posting nothing', () => {
    electron.state.supported = false;
    const failures: string[] = [];
    electronNotifierPorts(() => mainWindow).show({ title: 'T', body: 'B' }, (error) => {
      failures.push(error);
    });
    expect(electron.shown).toEqual([]);
    expect(failures).toHaveLength(1);
  });

  it('bounces the dock until Roger is activated, and sets its badge', () => {
    const ports = electronNotifierPorts(() => mainWindow);
    ports.bounceDock();
    ports.setDockBadge('!');
    expect(electron.state.bounces).toEqual(['critical']);
    expect(electron.state.badges).toEqual(['!']);
  });

  it("is focused only while Roger's main window is the focused window", () => {
    let main: typeof mainWindow | null = mainWindow;
    const ports = electronNotifierPorts(() => main);
    expect(ports.isFocused()).toBe(false);
    electron.state.focusedWindowId = 7;
    expect(ports.isFocused()).toBe(true);
    // Another window of Roger's (M5's prompt panel) has focus: the banner is not in sight.
    electron.state.focusedWindowId = 9;
    expect(ports.isFocused()).toBe(false);
    main = null;
    electron.state.focusedWindowId = 7;
    expect(ports.isFocused()).toBe(false);
  });
});

describe('the M2-T11 slot of createCaptureRuntime', () => {
  it('turns 8 s of a silent mic into a status warning and a macOS notification', async () => {
    vi.useFakeTimers();
    let now = T0;
    const store = new InMemoryTranscriptStore();
    const connection = { baseUrl: 'http://127.0.0.1:9', token: 'test' };
    const api = new ApiClient(connection);
    const { capture } = createCaptureRuntime({
      // The fake provider: Start asks the API for no token.
      config: { ...loadConfig({}), sttProviderOverride: 'fake' },
      store,
      api,
      apiConnection: connection,
      uploader: new TranscriptUploader({ store, api, logger }),
      createSpeechToText: () => new FakeSpeechToText({ clock: () => now }),
      ensureMicrophoneAccess: () => Promise.resolve('granted'),
      startupError: null,
      userData: '/nonexistent/roger-test',
      ipcMain: { handle: () => undefined, on: () => undefined },
      getWindow: () => ({
        webContents: { id: 7, send: () => undefined },
        isDestroyed: () => false,
      }),
      logger,
      clock: () => now,
    });

    await capture.start();
    const silence = new Uint8Array((PCM_SAMPLE_RATE / 10) * 2);
    const voice = new Uint8Array(new Int16Array(PCM_SAMPLE_RATE / 10).fill(3_277).buffer);
    for (let fed = 0; fed < 8_000; fed += 100) {
      now += 100;
      capture.pushAudio('mic', silence);
      capture.pushAudio('system', voice);
      vi.advanceTimersByTime(100);
    }

    expect(capture.getStatus().warnings?.map(({ kind, loud }) => ({ kind, loud }))).toEqual([
      { kind: 'mic-dead', loud: true },
    ]);
    expect(capture.getStatus().sources.mic.signal).toBe('dead');
    expect(electron.shown.map(({ options }) => options.title)).toEqual(['Your mic is silent']);

    await capture.stop({ flushUploads: false });
    expect(capture.getStatus().warnings).toBeUndefined();
  });
});
