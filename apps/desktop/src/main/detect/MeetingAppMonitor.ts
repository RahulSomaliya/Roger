import type { AudioRouteStatus, OutputRoute } from '../../shared/capture';
import type { RecordingStarted, StatusContribution } from '../capture/CaptureService';
import type { QuitHook } from '../lifecycle';
import { errorMessage, type Logger } from '../logger';
import {
  HELPER_STDIN_GRACE_MS,
  HELPER_TERM_KILL_MS,
  type HelperProcess,
  type HelperProcessListener,
  type HelperRunEnd,
} from '../native/HelperProcess';
import { parseHelperEvent } from '../audio/system/helperEvents';
import { type DetectedCallApp, detectCallApps, type MicUser } from './callApps';

/**
 * Reads `roger-audio monitor` while Roger runs (M2 D6, D7): which call apps use the mic, and which
 * devices the Mac plays through and records from. The wire contract is the top of
 * native/roger-audio/Monitor.swift; test/fixtures/fake-roger-audio.mjs speaks it in tests. Change
 * the three together. `HelperProcess` (M2-T10) runs the process and its watchdog.
 *
 * What it feeds: the call apps to M2-T17b's CallDetector (`onCallApps`), and each route to the
 * echo filter's RouteProvider, to `SignalMonitor.setMicBluetooth` and to the status's `route` and
 * `sources.mic.device` (`feedRoute`, `statusContribution`; the T17a slot in createCaptureRuntime.ts
 * wires them). It also tells the helper when a recording runs, so the helper relaunches Roger if
 * it is killed mid-recording.
 *
 * It starts at launch, not at Start: a call is offered before anyone presses Start.
 */

/** How the default device is connected, as the helper's `route` reports it (Route.swift). */
export type MonitorTransport =
  'bluetooth' | 'built_in_speaker' | 'built_in_headphones' | 'built_in' | 'usb' | 'other';

const TRANSPORTS: ReadonlySet<string> = new Set<MonitorTransport>([
  'bluetooth',
  'built_in_speaker',
  'built_in_headphones',
  'built_in',
  'usb',
  'other',
]);

export interface MonitorDevice {
  /** For people: "MacBook Pro Speakers", "AirPods Pro". */
  name: string;
  transport: MonitorTransport;
}

/** The Mac's default devices; null when it has none. */
export interface MonitorRoute {
  output: MonitorDevice | null;
  input: MonitorDevice | null;
}

export type MonitorEvent =
  | { event: 'mic_users'; users: MicUser[] }
  | ({ event: 'route' } & MonitorRoute)
  | { event: 'recording'; on: boolean }
  | { event: 'alive' };

export type ParsedMonitorLine =
  | { kind: 'event'; event: MonitorEvent }
  /** A well-formed event this main does not know (a newer helper, or `relaunch`'s dry run). */
  | { kind: 'unknown'; name: string }
  /** Not an event: the reason is for the log. */
  | { kind: 'malformed'; reason: string };

class Malformed extends Error {}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(object: JsonObject, path: string, key: string): string {
  const value = object[key];
  if (typeof value !== 'string') throw new Malformed(`"${path}${key}" is not a string`);
  return value;
}

function micUser(value: unknown, index: number): MicUser {
  const path = `users[${index}].`;
  if (!isObject(value)) throw new Malformed(`"users[${index}]" is not an object`);
  const { pid, bundleId } = value;
  if (typeof pid !== 'number' || !Number.isInteger(pid)) {
    throw new Malformed(`"${path}pid" is not an integer`);
  }
  if (bundleId !== null && typeof bundleId !== 'string') {
    throw new Malformed(`"${path}bundleId" is not a string or null`);
  }
  return {
    pid,
    bundleId,
    path: stringField(value, path, 'path'),
    name: stringField(value, path, 'name'),
  };
}

function device(object: JsonObject, key: 'output' | 'input'): MonitorDevice | null {
  const value = object[key];
  if (value === null) return null;
  if (!isObject(value)) throw new Malformed(`"${key}" is not an object or null`);
  const transport = stringField(value, `${key}.`, 'transport');
  return {
    name: stringField(value, `${key}.`, 'name'),
    // A transport a newer helper added is still a device: the safe reading is `other`.
    transport: TRANSPORTS.has(transport) ? (transport as MonitorTransport) : 'other',
  };
}

function readEvent(name: string, object: JsonObject): MonitorEvent | null {
  switch (name) {
    case 'mic_users': {
      const users = object.users;
      if (!Array.isArray(users)) throw new Malformed('"users" is not a list');
      return { event: 'mic_users', users: users.map(micUser) };
    }
    case 'route':
      return { event: 'route', output: device(object, 'output'), input: device(object, 'input') };
    case 'recording': {
      if (typeof object.on !== 'boolean') throw new Malformed('"on" is not true or false');
      return { event: 'recording', on: object.on };
    }
    case 'alive':
      return { event: 'alive' };
    default:
      return null;
  }
}

/** Reads one stdout line of the monitor. */
export function parseMonitorLine(line: string): ParsedMonitorLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'malformed', reason: 'not a JSON object' };
  }
  if (!isObject(parsed)) return { kind: 'malformed', reason: 'not a JSON object' };
  const name = parsed.event;
  if (typeof name !== 'string') return { kind: 'malformed', reason: 'no "event" name' };
  try {
    const event = readEvent(name, parsed);
    return event === null ? { kind: 'unknown', name } : { kind: 'event', event };
  } catch (error) {
    if (error instanceof Malformed)
      return { kind: 'malformed', reason: `${name}: ${error.message}` };
    throw error;
  }
}

/**
 * A Bluetooth output named like something worn on the ears. A Bluetooth output may as well be a
 * speaker (a JBL, a Beats Pill), and the transport alone cannot tell them apart.
 */
const PERSONAL_AUDIO_NAME = /airpods|headphone|headset|earbud|earphone|\bbuds\b/i;

/**
 * Where call audio plays, for the echo filter. Only the Mac's own speakers are `speakers` and only
 * the Mac's jack and a Bluetooth output named like headphones are `headphones`; everything else
 * is `unknown`, which keeps the filter on. The two mistakes are not equal: a speaker read as
 * headphones turns the filter off and uploads every echo of the call, while headphones read as
 * unknown only leave the filter on, which hides a line only when its words match call audio said
 * within 700 ms. So a USB device (a headset or a speaker), HDMI, an aggregate device and a
 * Bluetooth speaker all stay `unknown`.
 */
export function outputRouteOf(route: MonitorRoute): OutputRoute {
  const output = route.output;
  if (output === null) return 'unknown';
  switch (output.transport) {
    case 'built_in_speaker':
      return 'speakers';
    case 'built_in_headphones':
      return 'headphones';
    case 'bluetooth':
      return PERSONAL_AUDIO_NAME.test(output.name) ? 'headphones' : 'unknown';
    case 'built_in':
    case 'usb':
    case 'other':
      return 'unknown';
  }
}

/** The helper as the monitor uses it: HelperProcess, or a stand-in in a test. */
export type MonitorHelper = Pick<HelperProcess, 'start' | 'stop' | 'writeLine'>;

/** What the monitor needs of CaptureService (`onRecording`). */
export interface MonitorCapture {
  onRecording(listener: {
    started?(recording: Pick<RecordingStarted, 'resumed'>): void;
    ended?(): void;
  }): () => void;
}

export interface MeetingAppMonitorOptions {
  /**
   * How to run the helper: the slot's `create` builds a HelperProcess around the listener it is
   * given. `missing` (why) when this build has no helper: there is then no call detection and no
   * relaunch, and Roger runs as it did before M2.
   */
  helper: { create(listener: HelperProcessListener): MonitorHelper } | { missing: string };
  /** Roger's own processes right now (main, renderer, GPU, utility): asked for at every list. */
  ownPids: () => ReadonlySet<number>;
  /**
   * This launch is the helper's relaunch of a killed Roger (`--relaunched` in argv, the only sign
   * of it). Main must not arm the relaunch again in the meeting it resumes (see `attach`).
   */
  relaunched: boolean;
  logger: Logger;
}

type State = 'new' | 'running' | 'down' | 'stopped';

export class MeetingAppMonitor {
  private helper: MonitorHelper | null = null;
  private state: State = 'new';
  private apps: DetectedCallApp[] = [];
  private currentRoute: MonitorRoute | null = null;
  /** A recording runs and the helper is to watch over it (`recording on` sent or owed). */
  private watching = false;
  private readonly appListeners = new Set<(apps: readonly DetectedCallApp[]) => void>();
  private readonly routeListeners = new Set<(route: MonitorRoute | null) => void>();
  /** The reason of the last unreadable line, so a helper that repeats one logs it once. */
  private unreadable: string | null = null;

  constructor(private readonly options: MeetingAppMonitorOptions) {}

  /** The call apps using the mic now: empty while the monitor is down. */
  get callApps(): readonly DetectedCallApp[] {
    return this.apps;
  }

  /** The Mac's default devices as last reported; null before the first report and while down. */
  get route(): MonitorRoute | null {
    return this.currentRoute;
  }

  /** The helper is running, or restarting after a crash it will be restarted from. */
  get running(): boolean {
    return this.state === 'running';
  }

  /** Called with the whole list whenever it changes (also to empty). Returns the removal. */
  onCallApps(listener: (apps: readonly DetectedCallApp[]) => void): () => void {
    this.appListeners.add(listener);
    return () => this.appListeners.delete(listener);
  }

  /**
   * Called on every `route` event, also one that repeats the last (the helper sends it again after
   * a restart), and with null when the monitor is lost. Returns the removal.
   */
  onRoute(listener: (route: MonitorRoute | null) => void): () => void {
    this.routeListeners.add(listener);
    return () => this.routeListeners.delete(listener);
  }

  /** Starts the helper. Once, at launch. */
  start(): void {
    const { helper, logger } = this.options;
    if ('missing' in helper) {
      this.state = 'down';
      logger.warn('call app monitor not started: no audio helper', { reason: helper.missing });
      return;
    }
    this.state = 'running';
    this.helper = helper.create(this.listener());
    this.helper.start();
  }

  /**
   * Follows each recording: `recording on` at Start, `recording off` at every stop, so the helper
   * relaunches Roger only when it dies mid-recording. A stop that threw still sends it: no
   * recording outlives its stop in this process.
   *
   * Trap: the helper relaunches Roger once, then exits. "Once per meeting" is ours (ParentWatch.swift):
   * in a meeting Roger was relaunched into, `recording on` is not sent again, or a Roger that
   * crashes on every resume relaunches itself forever. A resume that nobody relaunched (the person
   * opened Roger again) is armed like any other: it has had no relaunch yet.
   */
  attach(capture: MonitorCapture): void {
    capture.onRecording({
      started: ({ resumed }) => {
        if (resumed && this.options.relaunched) {
          this.options.logger.info(
            'call app monitor not armed: Roger was relaunched into this meeting',
          );
          return;
        }
        this.watching = true;
        this.announce('recording on');
      },
      ended: () => {
        this.watching = false;
        this.announce('recording off');
      },
    });
  }

  /** The route's part of the status (a status contributor): `route` and the mic's device. */
  statusContribution(): StatusContribution {
    const route = this.currentRoute;
    if (route === null) return {};
    const status: AudioRouteStatus = {
      output: outputRouteOf(route),
      outputDevice: route.output?.name ?? null,
      inputDevice: route.input?.name ?? null,
    };
    // The default input is the device M2-T12's MicRecovery follows, and the name SignalMonitor
    // turns into "Switched to <device>" when it changes.
    return { route: status, sources: { mic: { device: status.inputDevice } } };
  }

  /** Stops the helper at quit, after `recording off`: or the helper reads Roger's exit as a crash. */
  readonly quitHook: QuitHook = {
    name: 'stop the call app monitor',
    // stdin, then SIGTERM, then SIGKILL (HelperProcess.stop), with a second to spare.
    timeoutMs: HELPER_STDIN_GRACE_MS + HELPER_TERM_KILL_MS + 1_000,
    run: async () => {
      const helper = this.helper;
      if (helper === null || this.state === 'stopped') return;
      this.announce('recording off');
      this.state = 'stopped';
      await helper.stop();
    },
  };

  private announce(command: 'recording on' | 'recording off'): void {
    const delivered = this.helper?.writeLine(command) ?? false;
    if (!delivered) {
      // A helper between a crash and its restart: a new run is told on spawn (`onSpawn`).
      this.options.logger.debug('call app monitor command not delivered', { command });
    }
  }

  private listener(): HelperProcessListener {
    const { logger } = this.options;
    return {
      onSpawn: ({ run, pid }) => {
        // A new run starts not recording: tell it a recording is on, or its parent-death relaunch
        // is off for the rest of the meeting.
        logger.info('call app monitor started', { run, pid });
        if (this.watching) this.announce('recording on');
      },
      onStdoutLine: (line) => {
        this.read(line);
      },
      onStderrLine: (line) => {
        this.readStderr(line);
      },
      onFailed: (end) => {
        this.lost(end);
      },
    };
  }

  private read(line: string): void {
    const parsed = parseMonitorLine(line);
    if (parsed.kind === 'malformed') {
      // Once per reason: a helper that breaks writes the same line every second.
      if (this.unreadable !== parsed.reason) {
        this.options.logger.warn('call app monitor wrote an unreadable line', {
          reason: parsed.reason,
        });
      }
      this.unreadable = parsed.reason;
      return;
    }
    this.unreadable = null;
    if (parsed.kind === 'unknown') return;
    const { event } = parsed;
    switch (event.event) {
      case 'mic_users':
        this.setCallApps(detectCallApps(event.users, this.options.ownPids()));
        return;
      case 'route':
        this.currentRoute = { output: event.output, input: event.input };
        this.options.logger.info('audio route', {
          output: event.output,
          input: event.input,
        });
        this.tell(this.routeListeners, this.currentRoute);
        return;
      case 'recording':
        this.options.logger.info('call app monitor recording state', { on: event.on });
        return;
      case 'alive':
        // Every second, so the helper's watchdog (HelperProcess) sees a quiet monitor alive.
        return;
    }
  }

  private readStderr(line: string): void {
    const parsed = parseHelperEvent(line);
    if (parsed.kind !== 'event') return;
    const { event } = parsed;
    if (event.event === 'warning') {
      this.options.logger.warn('call app monitor warning', {
        code: event.code,
        message: event.message,
      });
    } else if (event.event === 'error') {
      this.options.logger.error('call app monitor error', {
        code: event.code,
        message: event.message,
        status: event.status,
      });
    }
  }

  /** Out of restarts: no detection and no relaunch from here on; say what is no longer known. */
  private lost(end: HelperRunEnd): void {
    this.options.logger.error('call app monitor lost: no call detection until Roger restarts', {
      detail: end.detail,
      restarts: end.restarts,
    });
    this.state = 'down';
    this.setCallApps([]);
    if (this.currentRoute !== null) {
      this.currentRoute = null;
      this.tell(this.routeListeners, null);
    }
  }

  private setCallApps(found: DetectedCallApp[]): void {
    const key = (apps: readonly DetectedCallApp[]): string =>
      apps.map((app) => `${app.kind}:${app.bundleId}:${app.name}`).join('|');
    if (key(found) === key(this.apps)) return;
    this.apps = found;
    this.tell(this.appListeners, found);
  }

  /** One listener that throws is logged and never reaches the helper's pipe or the others. */
  private tell<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      try {
        listener(value);
      } catch (error) {
        this.options.logger.error('call app monitor listener failed', {
          error: errorMessage(error),
        });
      }
    }
  }
}

/** What `feedRoute` tells; the T17a slot passes `echoRoute`, `signalMonitor` and `capture`. */
export interface RouteFeeds {
  echoRoute: { set(route: OutputRoute): void };
  signalMonitor: { setMicBluetooth(bluetooth: boolean): void };
  refreshStatus(): void;
}

/**
 * Each route event: where call audio plays goes to the echo filter, whether the default input is
 * Bluetooth to SignalMonitor (D4's 30 s window for an AirPods mic that gates between words), and
 * the status is refreshed so the new device shows (and becomes "Switched to <device>") at once.
 *
 * A lost monitor (null) keeps the echo filter on, which is the safe reading, and leaves the
 * Bluetooth flag alone: lost mid-call on AirPods, dropping to 8 s would warn falsely.
 */
export function feedRoute(monitor: Pick<MeetingAppMonitor, 'onRoute'>, feeds: RouteFeeds): void {
  monitor.onRoute((route) => {
    if (route === null) {
      feeds.echoRoute.set('unknown');
    } else {
      feeds.echoRoute.set(outputRouteOf(route));
      // Before the refresh: the refresh is what turns a changed device into a notice, and its
      // dead-signal window must already be the new device's.
      feeds.signalMonitor.setMicBluetooth(route.input?.transport === 'bluetooth');
    }
    feeds.refreshStatus();
  });
}
