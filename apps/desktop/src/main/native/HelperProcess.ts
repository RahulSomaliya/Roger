import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { HELPER_HANG_KILL_MS, HELPER_MAX_RESTARTS } from '../../shared/capture';
import { errorMessage, type Logger } from '../logger';
import type { HelperLocation } from './helperPath';

/**
 * Runs `roger-audio`, the Swift audio helper (native/roger-audio), and keeps it running: the `tap`
 * that captures call audio (M2-T10's TapSystemAudio) and the `monitor` that watches which apps
 * use the mic (M2-T17a). The wire contract is native/roger-audio/Protocol.swift (and the top of
 * Monitor.swift); test/fixtures/fake-roger-audio.mjs speaks it in tests. Change the three together.
 *
 * - A helper that writes nothing, no stdout byte and no stderr line, for `hangKillMs` (3 s) is
 *   hung, stopped with `pkill -STOP` or stuck in a Core Audio call: it gets SIGKILL and a restart.
 *   A stopped helper never exits, so restarting only on exit would leave call audio dead until the
 *   person noticed. The tap's `stats` and the monitor's `alive`, both once a second, keep a
 *   healthy helper under the limit: never add a helper mode that can stay quiet for 3 s.
 * - A helper that exits on its own, cannot start, or writes a frame that is not one, is restarted
 *   too. Every one of those restarts counts: after `maxRestarts` (5) in a row the helper is left
 *   down and `onFailed` says so. A run that lasted `healthyResetMs` starts the count afresh, so
 *   the monitor, which runs for days, is not used up by one crash a day.
 * - `stop()` closes stdin (the helper tears its tap down and exits), then sends SIGTERM after
 *   `stdinGraceMs`, then SIGKILL after `termKillMs` more.
 */

/** The first four bytes of every frame of `roger-audio tap` (Protocol.swift, `FrameHeader`). */
export const FRAME_MAGIC = 'RGA1';
export const FRAME_HEADER_BYTES = 16;
/**
 * A frame is one chunk (100 ms, 3,200 bytes at 16 kHz); `--chunk-ms` allows up to 1 s at 48 kHz.
 * A header that announces more is garbage, and believing it would buffer up to 4 GiB of stdout
 * waiting for a payload that never comes.
 */
export const MAX_FRAME_PAYLOAD_BYTES = 1_048_576;
/** A stdout or stderr line longer than this is cut there (see LineSplitter). */
export const MAX_HELPER_LINE_CHARS = 65_536;

/** How long a helper may take to exit once its stdin is closed (`stop()`), before SIGTERM. */
export const HELPER_STDIN_GRACE_MS = 1_000;
/** How long a helper may take to exit after SIGTERM, before SIGKILL. */
export const HELPER_TERM_KILL_MS = 5_000;
/** The wait before a helper that ended unexpectedly is started again. */
export const HELPER_RESTART_DELAY_MS = 500;
/** A run this long was healthy: the restarts after it count from 0 again. */
export const HELPER_HEALTHY_RESET_MS = 60_000;

/** The helper broke its wire contract: its output cannot be read any more. */
export class HelperProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelperProtocolError';
  }
}

/** One chunk of call audio from `roger-audio tap`. */
export interface HelperFrame {
  /** Mono Int16 little-endian PCM at the rate `ready` announced. A copy: the sink may keep it. */
  pcm: Uint8Array;
  /** Wall clock (epoch ms) of the first sample, taken by the helper where it was captured. */
  capturedAtMs: number;
}

/** Reads `roger-audio tap`'s stdout: 16-byte headers, each followed by its payload. */
export class FrameParser {
  private pending: Buffer = Buffer.alloc(0);
  private read = 0;

  /** The frames `data` completes. Throws HelperProtocolError on bytes that are not a frame. */
  push(data: Uint8Array): HelperFrame[] {
    const incoming = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    this.pending = this.pending.length === 0 ? incoming : Buffer.concat([this.pending, incoming]);
    const frames: HelperFrame[] = [];
    let offset = 0;
    while (this.pending.length - offset >= FRAME_HEADER_BYTES) {
      const number = this.read + 1;
      if (this.pending.toString('latin1', offset, offset + 4) !== FRAME_MAGIC) {
        throw new HelperProtocolError(`frame ${number} does not start with "${FRAME_MAGIC}"`);
      }
      const length = this.pending.readUInt32LE(offset + 4);
      if (length > MAX_FRAME_PAYLOAD_BYTES) {
        throw new HelperProtocolError(
          `frame ${number} announces ${length} payload bytes, over ${MAX_FRAME_PAYLOAD_BYTES}`,
        );
      }
      // Int16 samples: an odd length would shift every later sample the vendor hears.
      if (length % 2 !== 0) {
        throw new HelperProtocolError(
          `frame ${number} has an odd payload length (${length} bytes): not Int16 samples`,
        );
      }
      const capturedAtMs = this.pending.readDoubleLE(offset + 8);
      if (!Number.isFinite(capturedAtMs)) {
        throw new HelperProtocolError(`frame ${number} has no capture time (${capturedAtMs})`);
      }
      const end = offset + FRAME_HEADER_BYTES + length;
      if (this.pending.length < end) break;
      this.read = number;
      // A copy: a view would keep the whole pipe read (up to 64 KiB) alive in every sink that
      // holds the chunk, such as the reopen buffer or the backup writer.
      if (length > 0) {
        frames.push({
          pcm: new Uint8Array(this.pending.subarray(offset + FRAME_HEADER_BYTES, end)),
          capturedAtMs,
        });
      }
      offset = end;
    }
    this.pending = this.pending.subarray(offset);
    return frames;
  }
}

/**
 * Splits text into lines: `\n` ends one, a trailing `\r` is dropped. A line longer than
 * MAX_HELPER_LINE_CHARS is cut there and the rest of it, up to its newline, is dropped, as the
 * helper's own LineSplitter does: a writer that never sends a newline must not grow memory.
 */
export class LineSplitter {
  private pending = '';
  private discarding = false;

  push(text: string): string[] {
    const lines: string[] = [];
    let rest = text;
    for (;;) {
      const newline = rest.indexOf('\n');
      const piece = newline === -1 ? rest : rest.slice(0, newline);
      if (!this.discarding) {
        this.pending += piece;
        if (this.pending.length >= MAX_HELPER_LINE_CHARS) {
          lines.push(this.pending.slice(0, MAX_HELPER_LINE_CHARS));
          this.pending = '';
          this.discarding = true;
        }
      }
      if (newline === -1) return lines;
      if (!this.discarding) {
        lines.push(this.pending.endsWith('\r') ? this.pending.slice(0, -1) : this.pending);
      }
      this.pending = '';
      this.discarding = false;
      rest = rest.slice(newline + 1);
    }
  }
}

/** How to start a helper: the program, its arguments and its environment. */
export interface HelperCommand {
  file: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

/**
 * The command for one helper subcommand at `location` (helperPath.ts finds it). The fake helper
 * is a Node script: it runs under this process's own binary, Electron's, as Node
 * (ELECTRON_RUN_AS_NODE), since a Mac may have no other Node and must never pick one up from PATH.
 */
export function helperCommand(
  location: HelperLocation,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): HelperCommand {
  if (location.origin === 'e2e-fake') {
    return {
      file: process.execPath,
      args: [location.path, ...args],
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return { file: location.path, args: [...args], env };
}

/** Why a run ended when nobody asked it to. */
export type HelperEndCause =
  /** It exited on its own, was killed by something else, or could not start. */
  | 'crashed'
  /** It wrote nothing for `hangKillMs`, so it was killed. */
  | 'hung'
  /** It wrote bytes that are not a frame (HelperProtocolError), so it was killed. */
  | 'protocol';

export interface HelperRunEnd {
  /** 1 for the first run, then one more per restart. */
  run: number;
  cause: HelperEndCause;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** For logs and messages, e.g. "exit 1", "no output for 3000 ms". Never transcript text. */
  detail: string;
  /** Restarts in a row so far: this one included for `onRestart`, all of them for `onFailed`. */
  restarts: number;
}

/** How a run that was asked to stop ended. */
export interface HelperExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * What a helper's owner hears. Each call is its own: one that throws is logged and the helper goes
 * on. Output from a run that is stopping or has ended is never handed on.
 */
export interface HelperProcessListener {
  /** A run began: the first, a restart or a `restart()`. Its output follows. */
  onSpawn?(run: { run: number; pid: number | null }): void;
  /** `stdout: 'frames'` only: each frame, in order. */
  onFrame?(frame: HelperFrame): void;
  /** `stdout: 'lines'` only: each line. */
  onStdoutLine?(line: string): void;
  /** Each stderr line (the JSON events of Protocol.swift; audio/system/helperEvents.ts reads them). */
  onStderrLine?(line: string): void;
  /** A run ended unexpectedly; the next one starts after `restartDelayMs`. */
  onRestart?(end: HelperRunEnd): void;
  /** A run ended unexpectedly with no restarts left: the helper stays down. */
  onFailed?(end: HelperRunEnd): void;
}

export interface HelperProcessOptions {
  /** Names it in logs: "tap", "monitor". */
  name: string;
  command: HelperCommand;
  /** What its stdout carries: `tap`'s binary frames, or `monitor`'s JSON lines. */
  stdout: 'frames' | 'lines';
  listener: HelperProcessListener;
  logger: Logger;
  hangKillMs?: number;
  maxRestarts?: number;
  restartDelayMs?: number;
  healthyResetMs?: number;
  stdinGraceMs?: number;
  termKillMs?: number;
  clock?: () => number;
}

interface Run {
  run: number;
  child: ChildProcessWithoutNullStreams;
  spawnedAtMs: number;
  /** Set once its end was handled ('close', or an 'error' that means it never started). */
  ended: boolean;
  /** Why it was killed by this class, when it was. */
  killed: { cause: Exclude<HelperEndCause, 'crashed'>; detail: string } | null;
  /** `restart()` asked for it to end: the next run starts at once and nothing is counted. */
  replaced: boolean;
  spawnError: string | null;
  watchdog: NodeJS.Timeout;
  /** The stop sequence's SIGTERM and SIGKILL timers. */
  terminate: NodeJS.Timeout[];
}

/** What deciding a run's sequel needs of it; a run whose spawn threw has only this. */
type RunOutcome = Pick<Run, 'run' | 'spawnedAtMs' | 'killed' | 'replaced' | 'spawnError'>;

type State = 'new' | 'running' | 'stopping' | 'stopped' | 'failed';

export class HelperProcess {
  private readonly clock: () => number;
  private readonly hangKillMs: number;
  private readonly maxRestarts: number;
  private state: State = 'new';
  private current: Run | null = null;
  private runs = 0;
  private restartsInARow = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped: Promise<HelperExit | null> | null = null;
  private onStoppedRunEnd: ((exit: HelperExit) => void) | null = null;

  constructor(private readonly options: HelperProcessOptions) {
    this.clock = options.clock ?? (() => Date.now());
    this.hangKillMs = options.hangKillMs ?? HELPER_HANG_KILL_MS;
    this.maxRestarts = options.maxRestarts ?? HELPER_MAX_RESTARTS;
  }

  /** Restarts in a row so far (see `healthyResetMs`); a `restart()` is not one. */
  get restarts(): number {
    return this.restartsInARow;
  }

  /** Starts the first run. A helper is started once; build a new one to run again after stop. */
  start(): void {
    if (this.state !== 'new') {
      throw new Error(`audio helper "${this.options.name}" was already started`);
    }
    this.state = 'running';
    this.spawnRun();
  }

  /**
   * Sends one command line to the running helper's stdin (`rebuild`, `recording on`). False when
   * no run takes commands now: before start, between a crash and its restart, while stopping, or
   * after giving up.
   */
  writeLine(command: string): boolean {
    if (command.includes('\n')) {
      throw new Error(`an audio helper command is one line, got ${JSON.stringify(command)}`);
    }
    const run = this.current;
    if (this.state !== 'running' || run === null || run.ended || run.replaced) return false;
    if (!run.child.stdin.writable) return false;
    run.child.stdin.write(`${command}\n`);
    return true;
  }

  /**
   * Ends the running helper as `stop()` does and starts a new one as soon as it is gone, outside
   * the restart count: a deliberate restart (after a wake, M2-T18) is not a failure.
   */
  restart(reason: string): void {
    if (this.state !== 'running') return;
    const run = this.current;
    if (run === null) {
      // Between a crash and its restart: start the next run now.
      if (this.restartTimer !== null) clearTimeout(this.restartTimer);
      this.restartTimer = null;
      this.spawnRun();
      return;
    }
    if (run.replaced || run.ended) return;
    this.options.logger.info('audio helper restart requested', {
      helper: this.options.name,
      run: run.run,
      reason,
    });
    run.replaced = true;
    this.terminate(run);
  }

  /**
   * Stops the helper for good: closes stdin, then SIGTERM, then SIGKILL (see the class comment).
   * Resolves with how the running helper ended, or null when none was running. Every call answers
   * the same promise.
   */
  stop(): Promise<HelperExit | null> {
    if (this.stopped !== null) return this.stopped;
    this.state = 'stopping';
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const run = this.current;
    if (run === null || run.ended) {
      this.state = 'stopped';
      this.stopped = Promise.resolve(null);
      return this.stopped;
    }
    this.stopped = new Promise((resolve) => {
      this.onStoppedRunEnd = (exit) => {
        this.state = 'stopped';
        resolve(exit);
      };
    });
    this.terminate(run);
    return this.stopped;
  }

  private spawnRun(): void {
    this.runs += 1;
    const { command, logger, name } = this.options;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command.file, [...command.args], { env: command.env, stdio: 'pipe' });
    } catch (error) {
      // Node throws a spawn failure outside its async list (EACCES, EAGAIN, EMFILE, ENFILE,
      // ENOENT) at once: ENOEXEC for a binary `make native` is still writing, EBADARCH for an x64
      // Roger.app on an Intel Mac that carries the arm64 helper (electron-builder.yml). It is a run
      // that could not start, like the async 'error' below. Uncaught, a throw at Start skipped the
      // restart count and onFailed, so call audio was never reported failed, and a throw from the
      // restart timer or the 'close' handler was an uncaught exception in main.
      const number = this.runs;
      logger.error('audio helper process error', {
        helper: name,
        run: number,
        error: errorMessage(error),
      });
      this.tell('onSpawn', number, (listener) => listener.onSpawn?.({ run: number, pid: null }));
      this.afterRun(
        {
          run: number,
          spawnedAtMs: this.clock(),
          killed: null,
          replaced: false,
          spawnError: `could not start ${command.file}: ${errorMessage(error)}`,
        },
        null,
        null,
      );
      return;
    }
    const run: Run = {
      run: this.runs,
      child,
      spawnedAtMs: this.clock(),
      ended: false,
      killed: null,
      replaced: false,
      spawnError: null,
      watchdog: setTimeout(() => {
        this.kill(run, 'hung', `no output for ${this.hangKillMs} ms`);
      }, this.hangKillMs),
      terminate: [],
    };
    this.current = run;

    if (this.options.stdout === 'frames') {
      const frames = new FrameParser();
      child.stdout.on('data', (data: Buffer) => {
        if (!this.heardFrom(run)) return;
        let parsed: HelperFrame[];
        try {
          parsed = frames.push(data);
        } catch (error) {
          this.kill(run, 'protocol', errorMessage(error));
          return;
        }
        for (const frame of parsed) {
          this.tell('onFrame', run.run, (listener) => listener.onFrame?.(frame));
        }
      });
    } else {
      this.readLines(run, child.stdout, (line) => {
        this.tell('onStdoutLine', run.run, (listener) => listener.onStdoutLine?.(line));
      });
    }
    this.readLines(run, child.stderr, (line) => {
      this.tell('onStderrLine', run.run, (listener) => listener.onStderrLine?.(line));
    });
    // EPIPE once the helper has exited: expected, and its end is handled on 'close'. Without a
    // listener, Node throws it as an uncaught exception and takes main down.
    child.stdin.on('error', (error) => {
      logger.debug('audio helper stdin closed', {
        helper: name,
        run: run.run,
        error: errorMessage(error),
      });
    });
    child.on('error', (error) => {
      // Also emitted when a kill fails; only a missing pid means it never started.
      logger.error('audio helper process error', {
        helper: name,
        run: run.run,
        error: errorMessage(error),
      });
      if (child.pid === undefined) {
        run.spawnError = `could not start ${command.file}: ${errorMessage(error)}`;
        this.ended(run, null, null);
      }
    });
    child.on('close', (code, signal) => {
      this.ended(run, code, signal);
    });
    logger.info('audio helper started', { helper: name, run: run.run, pid: child.pid ?? null });
    this.tell('onSpawn', run.run, (listener) =>
      listener.onSpawn?.({ run: run.run, pid: child.pid ?? null }),
    );
  }

  private readLines(run: Run, stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
    const lines = new LineSplitter();
    stream.setEncoding('utf8');
    stream.on('data', (text: string) => {
      if (!this.heardFrom(run)) return;
      for (const line of lines.push(text)) onLine(line);
    });
  }

  /** Any output proves the run alive. False when its output must not be handed on any more. */
  private heardFrom(run: Run): boolean {
    if (this.state !== 'running' || this.current !== run || run.ended || run.replaced) return false;
    if (run.killed !== null) return false;
    run.watchdog.refresh();
    return true;
  }

  private kill(run: Run, cause: Exclude<HelperEndCause, 'crashed'>, detail: string): void {
    if (run.ended || run.killed !== null) return;
    run.killed = { cause, detail };
    clearTimeout(run.watchdog);
    this.options.logger.warn('audio helper killed', {
      helper: this.options.name,
      run: run.run,
      cause,
      detail,
    });
    run.child.kill('SIGKILL');
  }

  /** Closes stdin, then SIGTERM after stdinGraceMs, then SIGKILL after termKillMs more. */
  private terminate(run: Run): void {
    clearTimeout(run.watchdog);
    const { stdinGraceMs = HELPER_STDIN_GRACE_MS, termKillMs = HELPER_TERM_KILL_MS } = this.options;
    run.child.stdin.end();
    const signal = (name: NodeJS.Signals): void => {
      this.options.logger.warn('audio helper did not exit; sending a signal', {
        helper: this.options.name,
        run: run.run,
        signal: name,
      });
      run.child.kill(name);
    };
    run.terminate.push(
      setTimeout(() => {
        signal('SIGTERM');
        run.terminate.push(
          setTimeout(() => {
            signal('SIGKILL');
          }, termKillMs),
        );
      }, stdinGraceMs),
    );
  }

  private ended(run: Run, exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (run.ended) return;
    run.ended = true;
    clearTimeout(run.watchdog);
    for (const timer of run.terminate) clearTimeout(timer);
    if (this.current === run) this.current = null;
    this.afterRun(run, exitCode, signal);
  }

  /**
   * What follows a run that is over: the stop's answer, the replacement `restart()` asked for, a
   * counted restart, or giving up. A run whose spawn threw comes here straight from spawnRun.
   */
  private afterRun(run: RunOutcome, exitCode: number | null, signal: NodeJS.Signals | null): void {
    const { logger, name } = this.options;

    if (this.state === 'stopping' || this.state === 'stopped') {
      logger.info('audio helper stopped', { helper: name, run: run.run, exitCode, signal });
      this.onStoppedRunEnd?.({ exitCode, signal });
      this.onStoppedRunEnd = null;
      return;
    }
    if (run.replaced) {
      logger.info('audio helper replaced', { helper: name, run: run.run, exitCode, signal });
      if (this.state === 'running') this.spawnRun();
      return;
    }

    const { restartDelayMs = HELPER_RESTART_DELAY_MS, healthyResetMs = HELPER_HEALTHY_RESET_MS } =
      this.options;
    if (this.clock() - run.spawnedAtMs >= healthyResetMs) this.restartsInARow = 0;
    const end: HelperRunEnd = {
      run: run.run,
      cause: run.killed?.cause ?? 'crashed',
      exitCode,
      signal,
      detail: run.killed?.detail ?? run.spawnError ?? describeExit(exitCode, signal),
      restarts: this.restartsInARow,
    };
    if (this.restartsInARow >= this.maxRestarts) {
      this.state = 'failed';
      logger.error('audio helper failed; no restarts left', { helper: name, ...end });
      this.tell('onFailed', run.run, (listener) => listener.onFailed?.(end));
      return;
    }
    this.restartsInARow += 1;
    end.restarts = this.restartsInARow;
    logger.warn('audio helper ended; restarting', { helper: name, ...end });
    this.tell('onRestart', run.run, (listener) => listener.onRestart?.(end));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.state === 'running') this.spawnRun();
    }, restartDelayMs);
  }

  /** One listener call; one that throws is logged and never reaches the child's stream events. */
  private tell(
    callback: keyof HelperProcessListener,
    run: number,
    call: (listener: HelperProcessListener) => void,
  ): void {
    try {
      call(this.options.listener);
    } catch (error) {
      this.options.logger.error('audio helper listener failed', {
        helper: this.options.name,
        run,
        callback,
        error: errorMessage(error),
      });
    }
  }
}

function describeExit(exitCode: number | null, signal: NodeJS.Signals | null): string {
  if (exitCode !== null) return `exit ${exitCode}`;
  if (signal !== null) return `signal ${signal}`;
  return 'ended';
}
