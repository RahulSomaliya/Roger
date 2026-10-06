import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { type Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * `roger-audio monitor` (M2-T8, native/roger-audio/{Monitor,Route,ParentWatch}.swift), run as the
 * built binary; `make check` builds it before `pnpm test:mac`. Main's reader is M2-T17a's
 * MeetingAppMonitor.
 *
 * Nothing here launches Roger.app or any other app. Every monitor runs with `--relaunch-dry-run`,
 * which prints the `open` command instead of running it, even where the test never turns
 * recording on: without it, a parent that dies while recording relaunches the installed Roger.
 * "Roger" is a fake: a Node script, or a tiny program compiled into a temp folder. The monitor only
 * reads Core Audio properties and never opens a device, so it raises no privacy prompt. The real
 * relaunch after a kill -9 is checked by a person, on the exit check's kill -9 call.
 */

const HELPER = fileURLToPath(new URL('../../../native/bin/roger-audio', import.meta.url));
/**
 * What the monitor runs when Roger dies while recording; `appId` in electron-builder.yml.
 * `--relaunched` reaches the new Roger's argv: it is how CrashRecovery (M2-T23) tells this launch
 * from the user opening Roger, and resumes a meeting no call app holds (M2 D7).
 */
const RELAUNCH = ['/usr/bin/open', '-g', '-b', 'ai.linkt.roger', '--args', '--relaunched'];
const TRANSPORTS = [
  'bluetooth',
  'built_in_speaker',
  'built_in_headphones',
  'built_in',
  'usb',
  'other',
];

/**
 * Waits for a signal; SIGTERM or SIGKILL ends it. A copy of /bin/sleep will not do: macOS kills a
 * platform binary copied out of the system folders (SIGKILL at exec, macOS 26.6).
 */
const SLEEPER_C = '#include <unistd.h>\nint main(void) { pause(); return 0; }\n';

/**
 * "Roger" for the tests that must look like the real thing: it spawns `roger-audio monitor
 * --parent-pid <its own pid>` and holds the monitor's stdin, as main does, so a kill -9 ends the
 * parent and the monitor's stdin at once. The monitor's stdout and stderr are this script's, so the
 * test still reads them after this script is dead. Each line on this script's stdin goes to the
 * monitor; `close-stdin` ends the monitor's stdin instead, and `<line> && die` sends the line and
 * then kills this script with SIGKILL as soon as the line is in the pipe.
 */
const FAKE_ROGER_MJS = `
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const [helper, ...extra] = process.argv.slice(2);
const monitor = spawn(helper, ['monitor', '--parent-pid', String(process.pid), ...extra], {
  stdio: ['pipe', 'inherit', 'inherit'],
});
const say = (fields) => process.stdout.write(JSON.stringify(fields) + '\\n');
monitor.on('spawn', () => say({ event: 'fake_roger', monitorPid: monitor.pid }));
monitor.on('exit', (code, signal) => say({ event: 'fake_roger_monitor_exit', code, signal }));
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'close-stdin') {
    monitor.stdin.end();
    return;
  }
  const [command, then] = line.split(' && ');
  monitor.stdin.write(command + '\\n', () => {
    if (then === 'die') process.kill(process.pid, 'SIGKILL');
  });
});
`;

interface Line {
  event: string;
  [field: string]: unknown;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false;
    throw error;
  }
}

/** The JSON lines a process writes, as they arrive, and whether every writer closed the pipe. */
class LineLog {
  readonly lines: Line[] = [];
  /** When each of `lines` arrived, in `Date.now()` ms. */
  readonly arrivals: number[] = [];
  /** Lines that are not a JSON object with an `event`: the protocol allows none. */
  readonly junk: string[] = [];
  ended = false;
  private readonly checks = new Set<() => boolean>();

  constructor(stream: Readable) {
    const reader = createInterface({ input: stream });
    reader.on('line', (text) => {
      const line = parseLine(text);
      if (line) {
        this.lines.push(line);
        this.arrivals.push(Date.now());
      } else {
        this.junk.push(text);
      }
      this.notify();
    });
    reader.on('close', () => {
      this.ended = true;
      this.notify();
    });
  }

  events(event: string): Line[] {
    return this.lines.filter((line) => line.event === event);
  }

  has(event: string, fields: Record<string, unknown> = {}): boolean {
    return this.events(event).some((line) =>
      Object.entries(fields).every(([key, value]) => line[key] === value),
    );
  }

  waitFor(what: string, done: () => boolean, timeoutMs = 5_000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (done()) {
        resolve();
        return;
      }
      const check = (): boolean => {
        if (!done()) return false;
        clearTimeout(timer);
        resolve();
        return true;
      };
      const timer = setTimeout(() => {
        this.checks.delete(check);
        reject(new Error(`timed out waiting for ${what}; lines so far: ${this.describe()}`));
      }, timeoutMs);
      this.checks.add(check);
    });
  }

  describe(): string {
    return JSON.stringify([...this.lines, ...this.junk]);
  }

  private notify(): void {
    for (const check of [...this.checks]) if (check()) this.checks.delete(check);
  }
}

function parseLine(text: string): Line | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (!('event' in value) || typeof value.event !== 'string') return null;
  return { ...value, event: value.event };
}

/** One entry of `mic_users`: `{pid, bundleId, path, name}`, in that order. */
function isMicUser(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const nullableString = (field: unknown): boolean => field === null || typeof field === 'string';
  return (
    JSON.stringify(Object.keys(value)) === JSON.stringify(['pid', 'bundleId', 'path', 'name']) &&
    'pid' in value &&
    Number.isInteger(value.pid) &&
    'bundleId' in value &&
    nullableString(value.bundleId) &&
    'path' in value &&
    nullableString(value.path) &&
    'name' in value &&
    typeof value.name === 'string'
  );
}

/** One device of `route`: `{name, transport}`. */
function isRouteDevice(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return (
    JSON.stringify(Object.keys(value)) === JSON.stringify(['name', 'transport']) &&
    'name' in value &&
    typeof value.name === 'string' &&
    'transport' in value &&
    typeof value.transport === 'string' &&
    TRANSPORTS.includes(value.transport)
  );
}

let workDir = '';
let sleeper = '';
let fakeRogerScript = '';
/** Killed after each test if still running. */
const children = new Set<ChildProcess>();
/**
 * Monitors whose fake Roger died: no longer the test's children, so they are known by pid only.
 * Each should have exited by itself; one still running after a failed test is killed.
 */
const orphanMonitors = new Set<number>();

function track(child: ChildProcess): number {
  const { pid } = child;
  if (pid === undefined) throw new Error(`spawning ${child.spawnfile} gave no pid`);
  children.add(child);
  return pid;
}

/** Whether `pid` is still a roger-audio process: a pid that exited can be reused. */
function isHelper(pid: number): boolean {
  const result = spawnSync('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
  return result.stdout.trim() === HELPER;
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

/** Starts a copy of the sleeper at `path` (made by `beforeAll`) and waits until it runs. */
async function startSleeper(path: string): Promise<{ child: ChildProcess; pid: number }> {
  const child = spawn(path, [], { stdio: 'ignore' });
  const pid = track(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return { child, pid };
}

function resolvePid(pid: number): Line {
  const output = execFileSync(HELPER, ['monitor', '--resolve-pid', String(pid)], {
    encoding: 'utf8',
  });
  const lines = output.trim().split(/\r?\n/);
  expect(lines).toHaveLength(1);
  const line = parseLine(lines[0]!);
  if (!line) throw new Error(`--resolve-pid printed no event line: ${output}`);
  return line;
}

/** A monitor that is the test's own child, watching `parentPid`. */
async function startMonitor(parentPid: number): Promise<{
  child: ChildProcess;
  out: LineLog;
  err: LineLog;
  send: (line: string) => void;
}> {
  const child = spawn(
    HELPER,
    ['monitor', '--parent-pid', String(parentPid), '--relaunch-dry-run'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  track(child);
  const { stdin, stdout, stderr } = child;
  const out = new LineLog(stdout);
  const err = new LineLog(stderr);
  await out.waitFor(
    'the first route and mic users',
    () => out.has('route') && out.has('mic_users'),
  );
  return { child, out, err, send: (line) => stdin.write(`${line}\n`) };
}

/** A fake Roger (FAKE_ROGER_MJS) with its monitor running. */
async function startFakeRoger(): Promise<{
  pid: number;
  monitorPid: number;
  out: LineLog;
  err: LineLog;
  send: (line: string) => void;
  kill: () => void;
}> {
  const child = spawn(process.execPath, [fakeRogerScript, HELPER, '--relaunch-dry-run'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pid = track(child);
  const { stdin, stdout, stderr } = child;
  const out = new LineLog(stdout);
  const err = new LineLog(stderr);
  await out.waitFor(
    'the fake Roger and its monitor',
    () => out.has('fake_roger') && out.has('route') && out.has('mic_users'),
  );
  const monitorPid = out.events('fake_roger')[0]?.monitorPid;
  if (typeof monitorPid !== 'number') throw new Error(`no monitor pid: ${out.describe()}`);
  orphanMonitors.add(monitorPid);
  return {
    pid,
    monitorPid,
    out,
    err,
    send: (line) => stdin.write(`${line}\n`),
    kill: () => process.kill(pid, 'SIGKILL'),
  };
}

beforeAll(() => {
  if (!existsSync(HELPER)) {
    throw new Error(`${HELPER} is missing: build it with \`make native\` (make check does)`);
  }
  // realpath: /var is a symlink to /private/var, and the monitor reports the real path.
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'roger-monitor-')));
  sleeper = join(workDir, 'sleeper');
  // /usr/bin/cc by its full path: a shell alias named `cc` must not stand in for the compiler.
  execFileSync('/usr/bin/cc', ['-x', 'c', '-o', sleeper, '-'], { input: SLEEPER_C });
  fakeRogerScript = join(workDir, 'fake-roger.mjs');
  writeFileSync(fakeRogerScript, FAKE_ROGER_MJS);
});

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const pid of orphanMonitors) {
    if (!isHelper(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      // It exited between the check and the kill.
      if (!isErrno(error, 'ESRCH')) throw error;
    }
  }
  orphanMonitors.clear();
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function installSleeper(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(sleeper, path);
  return path;
}

function writeInfoPlist(bundle: string, fields: Record<string, string>): void {
  const entries = Object.entries(fields)
    .map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`)
    .join('\n');
  mkdirSync(join(bundle, 'Contents'), { recursive: true });
  writeFileSync(
    join(bundle, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries}
</dict>
</plist>
`,
  );
}

describe('roger-audio monitor: who is the process', { timeout: 20_000 }, () => {
  it('names a process outside any app by its executable path, as for avconferenced', async () => {
    // FaceTime and phone calls run their audio in /usr/libexec/avconferenced, which has no .app
    // around it (M2 D6); main's callApps.ts (M2-T17a) matches that path.
    const exe = installSleeper(join(workDir, 'usr', 'libexec', 'avconferenced'));
    const { pid } = await startSleeper(exe);

    expect(resolvePid(pid)).toEqual({
      event: 'process',
      pid,
      bundleId: null,
      path: exe,
      name: 'avconferenced',
    });
  });

  it('names a helper process nested in app bundles by its outermost app', async () => {
    // As Chrome's and Teams' audio helpers sit inside the browser's own .app.
    const outer = join(workDir, 'Applications', 'Fake Call.app');
    const inner = join(outer, 'Contents', 'Frameworks', 'Fake Call Helper.app');
    writeInfoPlist(outer, {
      CFBundleIdentifier: 'ai.linkt.test.fakecall',
      CFBundleName: 'Fake Call',
    });
    writeInfoPlist(inner, {
      CFBundleIdentifier: 'ai.linkt.test.fakecall.helper',
      CFBundleName: 'Fake Call Helper',
    });
    const exe = installSleeper(join(inner, 'Contents', 'MacOS', 'Fake Call Helper'));
    const { pid } = await startSleeper(exe);

    expect(resolvePid(pid)).toEqual({
      event: 'process',
      pid,
      bundleId: 'ai.linkt.test.fakecall',
      path: outer,
      name: 'Fake Call',
    });
  });

  it('prefers the display name, and falls back to the folder name without a plist', async () => {
    const named = join(workDir, 'Named.app');
    writeInfoPlist(named, {
      CFBundleIdentifier: 'ai.linkt.test.named',
      CFBundleName: 'named',
      CFBundleDisplayName: 'Named Display',
    });
    const bare = join(workDir, 'Bare Call.app');
    const namedPid = (await startSleeper(installSleeper(join(named, 'Contents', 'MacOS', 'n'))))
      .pid;
    const barePid = (await startSleeper(installSleeper(join(bare, 'Contents', 'MacOS', 'b')))).pid;

    expect(resolvePid(namedPid)).toMatchObject({
      bundleId: 'ai.linkt.test.named',
      name: 'Named Display',
    });
    expect(resolvePid(barePid)).toMatchObject({ bundleId: null, path: bare, name: 'Bare Call' });
  });

  it('fails with no_such_process for a pid that is gone', async () => {
    const { child, pid } = await startSleeper(sleeper);
    child.kill('SIGKILL');
    await exited(child);

    const result = spawnSync(HELPER, ['monitor', '--resolve-pid', String(pid)], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(parseLine(result.stderr.trim())).toMatchObject({
      event: 'error',
      code: 'no_such_process',
    });
  });
});

describe('roger-audio monitor: watching', { timeout: 20_000 }, () => {
  it('reports the mic users and the route at start, then only when they change', async () => {
    const monitor = await startMonitor(process.pid);
    // Two more polls (one a second) with whatever this Mac is doing.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    const { lines } = monitor.out;
    expect(
      lines
        .slice(0, 2)
        .map((line) => line.event)
        .sort(),
    ).toEqual(['mic_users', 'route']);
    for (const event of ['mic_users', 'route']) {
      const sent = monitor.out.events(event).map((line) => JSON.stringify(line));
      sent.forEach((line, index) => {
        if (index > 0) expect(line, `${event} sent twice in a row`).not.toBe(sent[index - 1]);
      });
    }
    for (const line of monitor.out.events('mic_users')) {
      expect(Object.keys(line), JSON.stringify(line)).toEqual(['event', 'users']);
      expect(Array.isArray(line.users), JSON.stringify(line)).toBe(true);
      const users: unknown[] = Array.isArray(line.users) ? line.users : [];
      for (const user of users) expect(isMicUser(user), JSON.stringify(user)).toBe(true);
    }
    for (const line of monitor.out.events('route')) {
      expect(Object.keys(line), JSON.stringify(line)).toEqual(['event', 'output', 'input']);
      for (const device of [line.output, line.input]) {
        expect(device === null || isRouteDevice(device), JSON.stringify(device)).toBe(true);
      }
    }
    expect(monitor.out.junk).toEqual([]);
    expect(monitor.err.lines).toEqual([]);

    // Not recording: the end of stdin is a plain stop, at once.
    const started = Date.now();
    monitor.child.stdin?.end();
    expect(await exited(monitor.child)).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('says alive after every poll, so a Mac where nothing changes still feeds the watchdog', async () => {
    // HelperProcess (M2-T10) kills a helper that writes no stdout byte and no event for 3 s. With
    // no change in mic users or route, `alive` is the only line the monitor writes.
    const monitor = await startMonitor(process.pid);
    await monitor.out.waitFor('three alive lines', () => monitor.out.events('alive').length >= 3);

    const { lines, arrivals } = monitor.out;
    const alive = monitor.out.events('alive');
    expect(alive).toEqual(alive.map(() => ({ event: 'alive' })));
    const first = lines.findIndex((line) => line.event === 'alive');
    expect(
      lines
        .slice(0, first)
        .map((line) => line.event)
        .sort(),
      'the first poll reports, then says alive',
    ).toEqual(['mic_users', 'route']);
    let previous: number | undefined;
    for (const [index, at] of arrivals.entries()) {
      if (lines[index]?.event !== 'alive') continue;
      // One a second; the margin is for a loaded Mac, and stays well under the 3 s watchdog.
      if (previous !== undefined) expect(at - previous).toBeLessThan(2_000);
      previous = at;
    }
    expect(monitor.err.lines).toEqual([]);
  });

  it('acknowledges recording on and off, and warns about an unknown command', async () => {
    const monitor = await startMonitor(process.pid);
    monitor.send('recording on');
    monitor.send('recording on');
    monitor.send('hello');
    monitor.send('recording off');
    await monitor.out.waitFor('recording off', () => monitor.out.has('recording', { on: false }));
    await monitor.err.waitFor('the warning', () => monitor.err.has('warning'));

    expect(monitor.out.events('recording')).toEqual([
      { event: 'recording', on: true },
      { event: 'recording', on: false },
    ]);
    expect(monitor.err.events('warning')).toEqual([
      { event: 'warning', code: 'unknown_command', message: 'unknown stdin command: hello' },
    ]);
  });

  it('refuses a bad command line with a usage error', () => {
    for (const args of [
      ['monitor'],
      ['monitor', '--parent-pid'],
      ['monitor', '--parent-pid', 'roger'],
      ['monitor', '--parent-pid', '1'],
      ['monitor', '--parent-pid', '42', '--resolve-pid', '42'],
      ['monitor', '--resolve-pid', '42', '--relaunch-dry-run'],
      ['monitor', '--parent-pid', '42', '--verbose'],
    ]) {
      const result = spawnSync(HELPER, args, { encoding: 'utf8' });
      expect(result.status, args.join(' ')).toBe(64);
      expect(result.stdout, args.join(' ')).toBe('');
      expect(parseLine(result.stderr.trim()), args.join(' ')).toMatchObject({
        event: 'error',
        code: 'usage',
      });
    }
  });
});

describe('roger-audio monitor: when Roger dies', { timeout: 20_000 }, () => {
  it('relaunches Roger once and exits when Roger is killed while recording', async () => {
    const roger = await startFakeRoger();
    roger.send('recording on');
    await roger.out.waitFor('recording on', () => roger.out.has('recording', { on: true }));

    roger.kill();
    // Ends when the monitor, the last writer of the pipe, has exited.
    await roger.out.waitFor('the monitor to exit', () => roger.out.ended, 10_000);

    expect(roger.out.events('relaunch')).toEqual([
      { event: 'relaunch', dryRun: true, command: RELAUNCH },
    ]);
    expect(isAlive(roger.monitorPid)).toBe(false);
    expect(roger.out.junk).toEqual([]);
  });

  it('relaunches when Roger dies right after it turned recording on', async () => {
    // The line and the death arrive together.
    const roger = await startFakeRoger();
    roger.send('recording on && die');
    await roger.out.waitFor('the monitor to exit', () => roger.out.ended, 10_000);

    expect(roger.out.events('relaunch')).toEqual([
      { event: 'relaunch', dryRun: true, command: RELAUNCH },
    ]);
  });

  it('does not relaunch when Roger dies right after it turned recording off', async () => {
    // A quit stops the recording, sends `recording off`, and exits at once.
    const roger = await startFakeRoger();
    roger.send('recording on');
    await roger.out.waitFor('recording on', () => roger.out.has('recording', { on: true }));
    roger.send('recording off && die');
    await roger.out.waitFor('the monitor to exit', () => roger.out.ended, 10_000);

    expect(roger.out.events('relaunch')).toEqual([]);
    expect(isAlive(roger.monitorPid)).toBe(false);
  });

  it('just exits when Roger dies while not recording', async () => {
    const roger = await startFakeRoger();
    roger.kill();
    await roger.out.waitFor('the monitor to exit', () => roger.out.ended, 10_000);

    expect(roger.out.events('relaunch')).toEqual([]);
    expect(roger.out.events('recording')).toEqual([]);
    expect(isAlive(roger.monitorPid)).toBe(false);
  });

  it('relaunches when the parent dies while another process still holds its stdin', async () => {
    // The parent watch alone, without the end of stdin that a kill -9 also brings.
    const parent = await startSleeper(sleeper);
    const monitor = await startMonitor(parent.pid);
    monitor.send('recording on');
    await monitor.out.waitFor('recording on', () => monitor.out.has('recording', { on: true }));

    parent.child.kill('SIGKILL');

    expect(await exited(monitor.child)).toEqual({ code: 0, signal: null });
    expect(monitor.out.events('relaunch')).toEqual([
      { event: 'relaunch', dryRun: true, command: RELAUNCH },
    ]);
  });

  it('decides at the end of the relaunch delay, from the last recording line by then', async () => {
    // The parent dies first and a line arrives after: a line main wrote just before it died can be
    // read after the monitor saw the exit (ParentWatch.swift). The kill -9 tests above never show
    // that order, since the kernel closes a dying process's pipes before it reports the exit.
    const offParent = await startSleeper(sleeper);
    const off = await startMonitor(offParent.pid);
    const onParent = await startSleeper(sleeper);
    const on = await startMonitor(onParent.pid);
    off.send('recording on');
    await off.out.waitFor('recording on', () => off.out.has('recording', { on: true }));

    offParent.child.kill('SIGKILL');
    onParent.child.kill('SIGKILL');
    await Promise.all([exited(offParent.child), exited(onParent.child)]);
    // Well inside the 1 s relaunch delay.
    await new Promise((resolve) => setTimeout(resolve, 200));
    off.send('recording off');
    on.send('recording on');

    expect(await exited(off.child)).toEqual({ code: 0, signal: null });
    expect(await exited(on.child)).toEqual({ code: 0, signal: null });
    expect(off.out.events('relaunch')).toEqual([]);
    expect(on.out.events('relaunch')).toEqual([
      { event: 'relaunch', dryRun: true, command: RELAUNCH },
    ]);
  });

  it('does not relaunch when a live Roger closes its stdin while recording', async () => {
    const roger = await startFakeRoger();
    roger.send('recording on');
    await roger.out.waitFor('recording on', () => roger.out.has('recording', { on: true }));

    roger.send('close-stdin');
    await roger.out.waitFor('the monitor to exit', () => roger.out.has('fake_roger_monitor_exit'));

    expect(roger.out.events('fake_roger_monitor_exit')).toEqual([
      { event: 'fake_roger_monitor_exit', code: 0, signal: null },
    ]);
    expect(roger.out.events('relaunch')).toEqual([]);
    expect(isAlive(roger.pid)).toBe(true);
  });

  it('exits at once on SIGTERM while recording, with no relaunch', async () => {
    // HelperProcess (M2-T10) stops a helper with SIGTERM; so does a logout.
    const parent = await startSleeper(sleeper);
    const monitor = await startMonitor(parent.pid);
    monitor.send('recording on');
    await monitor.out.waitFor('recording on', () => monitor.out.has('recording', { on: true }));

    monitor.child.kill('SIGTERM');

    expect(await exited(monitor.child)).toEqual({ code: 0, signal: null });
    expect(monitor.out.events('relaunch')).toEqual([]);
  });
});
