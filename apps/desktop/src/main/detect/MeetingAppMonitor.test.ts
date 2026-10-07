import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { HelperProcessListener } from '../native/HelperProcess';
import { helperCommand, HelperProcess } from '../native/HelperProcess';
import { createLogger } from '../logger';
import {
  feedRoute,
  MeetingAppMonitor,
  type MonitorCapture,
  type MonitorHelper,
  type MonitorRoute,
  outputRouteOf,
  parseMonitorLine,
} from './MeetingAppMonitor';
import type { DetectedCallApp, MicUser } from './callApps';

const FAKE_HELPER = fileURLToPath(
  new URL('../../../test/fixtures/fake-roger-audio.mjs', import.meta.url),
);

function silentLogger() {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) });
  return { logger, lines };
}

const ZOOM: MicUser = {
  pid: 100,
  bundleId: 'us.zoom.xos',
  path: '/Applications/zoom.us.app',
  name: 'zoom.us',
};
const CHROME: MicUser = {
  pid: 200,
  bundleId: 'com.google.Chrome',
  path: '/Applications/Google Chrome.app',
  name: 'Google Chrome',
};

const SPEAKERS_ROUTE: MonitorRoute = {
  output: { name: 'MacBook Pro Speakers', transport: 'built_in_speaker' },
  input: { name: 'MacBook Pro Microphone', transport: 'built_in' },
};

function micUsers(...users: MicUser[]): string {
  return JSON.stringify({ event: 'mic_users', users });
}
function routeLine(route: MonitorRoute): string {
  return JSON.stringify({ event: 'route', ...route });
}

/** A helper that records what main writes and lets the test play its stdout. */
class FakeHelper implements MonitorHelper {
  started = 0;
  stopped = 0;
  written: string[] = [];
  /** False models a helper between a crash and its restart. */
  accepting = true;
  constructor(readonly listener: HelperProcessListener) {}
  start(): void {
    this.started += 1;
    this.listener.onSpawn?.({ run: 1, pid: 4242 });
  }
  writeLine(command: string): boolean {
    if (!this.accepting) return false;
    this.written.push(command);
    return true;
  }
  stop(): Promise<null> {
    this.stopped += 1;
    return Promise.resolve(null);
  }
  say(line: string): void {
    this.listener.onStdoutLine?.(line);
  }
}

interface Started {
  resumed: boolean;
}
function harness(options: { relaunched?: boolean; own?: number[] } = {}) {
  const { logger, lines } = silentLogger();
  let helper: FakeHelper | null = null;
  let recording: { started?(r: Started): void; ended?(): void } = {};
  const capture: MonitorCapture = {
    onRecording: (listener) => {
      recording = listener;
      return () => undefined;
    },
  };
  const monitor = new MeetingAppMonitor({
    helper: {
      create: (listener) => {
        helper = new FakeHelper(listener);
        return helper;
      },
    },
    ownPids: () => new Set(options.own ?? []),
    relaunched: options.relaunched ?? false,
    logger,
  });
  monitor.attach(capture);
  const apps: DetectedCallApp[][] = [];
  const routes: (MonitorRoute | null)[] = [];
  monitor.onCallApps((found) => apps.push([...found]));
  monitor.onRoute((route) => routes.push(route));
  const live = (): FakeHelper => {
    if (helper === null) throw new Error('the monitor has not started its helper');
    return helper;
  };
  return {
    monitor,
    lines,
    apps,
    routes,
    live,
    start: (resumed = false) => recording.started?.({ resumed }),
    stop: () => recording.ended?.(),
  };
}

describe('parseMonitorLine', () => {
  it('reads the four events of the helper`s stdout protocol (Monitor.swift)', () => {
    expect(parseMonitorLine(micUsers(ZOOM))).toEqual({
      kind: 'event',
      event: { event: 'mic_users', users: [ZOOM] },
    });
    expect(parseMonitorLine(routeLine(SPEAKERS_ROUTE))).toEqual({
      kind: 'event',
      event: { event: 'route', ...SPEAKERS_ROUTE },
    });
    expect(parseMonitorLine('{"event":"recording","on":true}')).toEqual({
      kind: 'event',
      event: { event: 'recording', on: true },
    });
    expect(parseMonitorLine('{"event":"alive"}')).toEqual({
      kind: 'event',
      event: { event: 'alive' },
    });
  });

  it('reads a route with no default device as null, and a transport it does not know as other', () => {
    const line =
      '{"event":"route","output":null,"input":{"name":"Mic","transport":"thunderbolt3"}}';
    expect(parseMonitorLine(line)).toEqual({
      kind: 'event',
      event: { event: 'route', output: null, input: { name: 'Mic', transport: 'other' } },
    });
  });

  it('passes over an event a newer helper added, and refuses a line that is not an event', () => {
    expect(parseMonitorLine('{"event":"relaunch","dryRun":true,"command":["open"]}')).toEqual({
      kind: 'unknown',
      name: 'relaunch',
    });
    expect(parseMonitorLine('not json').kind).toBe('malformed');
    expect(parseMonitorLine('[1]').kind).toBe('malformed');
    expect(parseMonitorLine('{"users":[]}').kind).toBe('malformed');
  });

  it('names the field that broke', () => {
    const reasonOf = (line: string): string => {
      const parsed = parseMonitorLine(line);
      return parsed.kind === 'malformed' ? parsed.reason : `read as ${parsed.kind}`;
    };
    const badUser = JSON.stringify({ event: 'mic_users', users: [{ pid: 'x', name: 'n' }] });
    expect(reasonOf(badUser)).toBe('mic_users: "users[0].pid" is not an integer');
    const badRoute = '{"event":"route","output":{"name":3,"transport":"usb"},"input":null}';
    expect(reasonOf(badRoute)).toBe('route: "output.name" is not a string');
    expect(reasonOf('{"event":"recording"}')).toBe('recording: "on" is not true or false');
  });
});

describe('outputRouteOf', () => {
  const output = (transport: MonitorRoute['output'] extends infer D ? D : never) => ({
    output: transport,
    input: null,
  });

  it('is speakers for the Mac`s own speakers and headphones for its jack', () => {
    expect(
      outputRouteOf(output({ name: 'MacBook Pro Speakers', transport: 'built_in_speaker' })),
    ).toBe('speakers');
    expect(outputRouteOf(output({ name: 'Headphones', transport: 'built_in_headphones' }))).toBe(
      'headphones',
    );
  });

  it('is unknown for anything that may be a speaker, which keeps the echo filter on', () => {
    for (const transport of ['usb', 'other', 'built_in'] as const) {
      expect(outputRouteOf(output({ name: 'Something', transport }))).toBe('unknown');
    }
    expect(outputRouteOf(output({ name: 'JBL Flip 6', transport: 'bluetooth' }))).toBe('unknown');
    expect(outputRouteOf({ output: null, input: null })).toBe('unknown');
  });

  it('is headphones for a Bluetooth output that is named like personal audio', () => {
    for (const name of [
      'AirPods Pro',
      "Rahul's AirPods",
      'Beats Studio Buds',
      'WH-1000XM5 Headphones',
    ]) {
      expect(outputRouteOf(output({ name, transport: 'bluetooth' }))).toBe('headphones');
    }
  });
});

describe('MeetingAppMonitor', () => {
  it('starts its helper once and runs it with Roger, not with a recording', () => {
    const { monitor, live } = harness();
    monitor.start();
    expect(live().started).toBe(1);
    expect(live().written).toEqual([]);
    expect(monitor.running).toBe(true);
  });

  it('hands on the call apps that use the mic, once per change', () => {
    const { monitor, apps, live } = harness();
    monitor.start();
    live().say(micUsers());
    live().say(micUsers(ZOOM));
    live().say(micUsers(ZOOM)); // the helper repeats a list only at a restart
    live().say(micUsers(ZOOM, CHROME));
    live().say(micUsers());
    expect(apps.map((found) => found.map((app) => app.name))).toEqual([
      ['Zoom'],
      ['Zoom', 'Google Chrome'],
      [],
    ]);
    expect(monitor.callApps).toEqual([]);
  });

  it('never counts Roger`s own processes, asked for fresh at every list', () => {
    const own = new Set<number>();
    const { logger } = silentLogger();
    let helper: FakeHelper | null = null;
    const monitor = new MeetingAppMonitor({
      helper: { create: (listener) => (helper = new FakeHelper(listener)) },
      ownPids: () => own,
      relaunched: false,
      logger,
    });
    const apps: DetectedCallApp[][] = [];
    monitor.onCallApps((found) => apps.push([...found]));
    monitor.start();
    own.add(CHROME.pid); // a renderer is born after Roger started
    helper!.say(micUsers(CHROME));
    expect(apps).toEqual([]);
  });

  it('hands on each route, and keeps the last for the status', () => {
    const { monitor, routes, live } = harness();
    monitor.start();
    expect(monitor.route).toBeNull();
    live().say(routeLine(SPEAKERS_ROUTE));
    live().say(routeLine(SPEAKERS_ROUTE)); // every route event, as a restart repeats it
    expect(routes).toEqual([SPEAKERS_ROUTE, SPEAKERS_ROUTE]);
    expect(monitor.route).toEqual(SPEAKERS_ROUTE);
  });

  it('keeps going after a line it cannot read, and logs the reason once per spell', () => {
    const { monitor, lines, apps, live } = harness();
    monitor.start();
    live().say('{"event":"mic_users","users":[{"pid":"x"}]}');
    live().say('{"event":"mic_users","users":[{"pid":"y"}]}');
    live().say(micUsers(ZOOM));
    expect(apps).toHaveLength(1);
    const warnings = lines.filter((line) => line.includes('unreadable'));
    expect(warnings).toHaveLength(1);
  });

  it('sends recording on at Start and recording off at every stop, failed or not', () => {
    const { monitor, start, stop, live } = harness();
    monitor.start();
    start();
    expect(live().written).toEqual(['recording on']);
    stop();
    expect(live().written).toEqual(['recording on', 'recording off']);
  });

  it('sends recording on again to a monitor that restarted mid-recording, and not after a stop', () => {
    const { monitor, start, stop, live } = harness();
    monitor.start();
    start();
    live().listener.onSpawn?.({ run: 2, pid: 4243 });
    expect(live().written).toEqual(['recording on', 'recording on']);
    stop();
    live().listener.onSpawn?.({ run: 3, pid: 4244 });
    expect(live().written).toEqual(['recording on', 'recording on', 'recording off']);
  });

  it('sends recording on to a monitor that was down when the recording began', () => {
    const { monitor, start, live } = harness();
    monitor.start();
    live().accepting = false;
    start();
    expect(live().written).toEqual([]);
    live().accepting = true;
    live().listener.onSpawn?.({ run: 2, pid: 4243 });
    expect(live().written).toEqual(['recording on']);
  });

  it('never asks for a second relaunch in a meeting Roger was relaunched into', () => {
    // The monitor relaunches once; main is the one that must not arm it again, or a Roger that
    // crashes on every resume relaunches itself forever (ParentWatch.swift).
    const relaunched = harness({ relaunched: true });
    relaunched.monitor.start();
    relaunched.start(true);
    expect(relaunched.live().written).toEqual([]);
    relaunched.live().listener.onSpawn?.({ run: 2, pid: 1 });
    expect(relaunched.live().written).toEqual([]);
    // A new meeting in that same launch is armed as usual.
    relaunched.stop();
    relaunched.start(false);
    expect(relaunched.live().written).toEqual(['recording off', 'recording on']);

    // A resume that nobody relaunched (the person opened Roger again) may still be relaunched once.
    const reopened = harness({ relaunched: false });
    reopened.monitor.start();
    reopened.start(true);
    expect(reopened.live().written).toEqual(['recording on']);
  });

  it('sends recording off before it stops the helper at quit', async () => {
    const { monitor, start, live } = harness();
    monitor.start();
    start();
    const order: string[] = [];
    const helper = live();
    const write = helper.writeLine.bind(helper);
    helper.writeLine = (command) => {
      order.push(command);
      return write(command);
    };
    const stop = helper.stop.bind(helper);
    helper.stop = () => {
      order.push('stop');
      return stop();
    };
    await monitor.quitHook.run();
    expect(order).toEqual(['recording off', 'stop']);
    expect(monitor.running).toBe(false);
  });

  it('clears what it knew when the helper is out of restarts, and says so', () => {
    const { monitor, apps, routes, live, lines } = harness();
    monitor.start();
    live().say(micUsers(ZOOM));
    live().say(routeLine(SPEAKERS_ROUTE));
    live().listener.onFailed?.({
      run: 6,
      cause: 'crashed',
      exitCode: 1,
      signal: null,
      detail: 'exit 1',
      restarts: 5,
    });
    expect(apps.at(-1)).toEqual([]);
    expect(routes.at(-1)).toBeNull();
    expect(monitor.running).toBe(false);
    expect(monitor.route).toBeNull();
    expect(lines.some((line) => line.includes('"level":"error"'))).toBe(true);
  });

  it('runs without a helper when the build has none, and logs why', () => {
    const { logger, lines } = silentLogger();
    const monitor = new MeetingAppMonitor({
      helper: { missing: 'no audio helper at /x' },
      ownPids: () => new Set(),
      relaunched: false,
      logger,
    });
    monitor.attach({ onRecording: () => () => undefined });
    monitor.start();
    expect(monitor.running).toBe(false);
    expect(lines.some((line) => line.includes('no audio helper at /x'))).toBe(true);
    return expect(monitor.quitHook.run()).resolves.toBeUndefined();
  });

  it('logs the helper`s own warnings and errors from stderr', () => {
    const { monitor, lines, live } = harness();
    monitor.start();
    live().listener.onStderrLine?.(
      '{"event":"warning","code":"core_audio_read","message":"read failed"}',
    );
    live().listener.onStderrLine?.('{"event":"error","code":"boom","message":"bye","status":null}');
    expect(lines.filter((line) => line.includes('"level":"warn"'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('"level":"error"'))).toHaveLength(1);
  });

  it('contributes the route and the mic`s device to the status', () => {
    const { monitor, live } = harness();
    monitor.start();
    expect(monitor.statusContribution()).toEqual({});
    live().say(routeLine(SPEAKERS_ROUTE));
    expect(monitor.statusContribution()).toEqual({
      route: {
        output: 'speakers',
        outputDevice: 'MacBook Pro Speakers',
        inputDevice: 'MacBook Pro Microphone',
      },
      sources: { mic: { device: 'MacBook Pro Microphone' } },
    });
    live().say(routeLine({ output: null, input: null }));
    expect(monitor.statusContribution()).toEqual({
      route: { output: 'unknown', outputDevice: null, inputDevice: null },
      sources: { mic: { device: null } },
    });
  });

  it('keeps one listener`s failure from reaching the others or the helper', () => {
    const { monitor, live, lines } = harness();
    const heard = vi.fn();
    monitor.onRoute(() => {
      throw new Error('listener broke');
    });
    monitor.onRoute(heard);
    monitor.start();
    live().say(routeLine(SPEAKERS_ROUTE));
    expect(heard).toHaveBeenCalledTimes(1);
    expect(lines.some((line) => line.includes('listener broke'))).toBe(true);
  });
});

describe('feedRoute', () => {
  function feeds() {
    const calls: string[] = [];
    const { monitor, live } = harness();
    feedRoute(monitor, {
      echoRoute: { set: (route) => calls.push(`echo ${route}`) },
      signalMonitor: { setMicBluetooth: (on) => calls.push(`bluetooth ${on}`) },
      refreshStatus: () => calls.push('refresh'),
    });
    monitor.start();
    return {
      calls,
      say: (line: string) => {
        live().say(line);
      },
    };
  }

  it('tells the echo filter where call audio plays and the signal monitor if the mic is Bluetooth', () => {
    const { calls, say } = feeds();
    say(routeLine(SPEAKERS_ROUTE));
    say(
      routeLine({
        output: { name: 'AirPods Pro', transport: 'bluetooth' },
        input: { name: 'AirPods Pro', transport: 'bluetooth' },
      }),
    );
    // The Bluetooth flag lands before the refresh, so the notice for the new device is timed with
    // the right dead-signal window.
    expect(calls).toEqual([
      'echo speakers',
      'bluetooth false',
      'refresh',
      'echo headphones',
      'bluetooth true',
      'refresh',
    ]);
  });

  it('reads no default input as not Bluetooth', () => {
    const { calls, say } = feeds();
    say(routeLine({ output: null, input: null }));
    expect(calls).toEqual(['echo unknown', 'bluetooth false', 'refresh']);
  });

  it('keeps the echo filter on, and the Bluetooth flag as it was, when the monitor is lost', () => {
    const calls: string[] = [];
    const { monitor, live } = harness();
    feedRoute(monitor, {
      echoRoute: { set: (route) => calls.push(`echo ${route}`) },
      signalMonitor: { setMicBluetooth: (on) => calls.push(`bluetooth ${on}`) },
      refreshStatus: () => calls.push('refresh'),
    });
    monitor.start();
    live().say(
      routeLine({
        output: { name: 'AirPods Pro', transport: 'bluetooth' },
        input: { name: 'AirPods Pro', transport: 'bluetooth' },
      }),
    );
    calls.length = 0;
    live().listener.onFailed?.({
      run: 6,
      cause: 'hung',
      exitCode: null,
      signal: null,
      detail: 'x',
      restarts: 5,
    });
    // Lost mid-call on AirPods, a 30 s mic window must not drop to 8 s and warn falsely.
    expect(calls).toEqual(['echo unknown', 'refresh']);
  });
});

describe('MeetingAppMonitor with the fake helper', () => {
  it('reads the fake helper`s stdout and answers recording on and off', async (context) => {
    const { logger, lines } = silentLogger();
    const routes: (MonitorRoute | null)[] = [];
    const monitor = new MeetingAppMonitor({
      helper: {
        create: (listener) =>
          new HelperProcess({
            name: 'monitor',
            command: helperCommand(
              { origin: 'e2e-fake', path: FAKE_HELPER },
              ['monitor', '--parent-pid', String(process.pid), '--relaunch-dry-run'],
              { ...process.env, ROGER_FAKE_AUDIO: 'tick-ms=100' },
            ),
            stdout: 'lines',
            listener,
            logger,
          }),
      },
      ownPids: () => new Set(),
      relaunched: false,
      logger,
    });
    let recording: { started?(r: Started): void; ended?(): void } = {};
    monitor.attach({
      onRecording: (listener) => {
        recording = listener;
        return () => undefined;
      },
    });
    monitor.onRoute((route) => routes.push(route));
    // Context hook, not afterEach: this file's tests share nothing, and a failed one must still
    // stop its helper (CLAUDE.md, helper tests).
    context.onTestFinished(async () => {
      await monitor.quitHook.run();
    });
    monitor.start();
    await vi.waitFor(
      () => {
        expect(routes).toHaveLength(1);
      },
      { timeout: 5_000 },
    );
    expect(routes[0]).toEqual({
      output: { name: 'Fake Speakers', transport: 'built_in_speaker' },
      input: { name: 'Fake Microphone', transport: 'built_in' },
    });
    recording.started?.({ resumed: false });
    await vi.waitFor(
      () => {
        expect(lines.some((l) => l.includes('"on":true'))).toBe(true);
      },
      {
        timeout: 5_000,
      },
    );
    recording.ended?.();
    await vi.waitFor(
      () => {
        expect(lines.some((l) => l.includes('"on":false'))).toBe(true);
      },
      {
        timeout: 5_000,
      },
    );
  });
});
