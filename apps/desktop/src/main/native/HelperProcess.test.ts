import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, type TestContext, vi } from 'vitest';
import { createLogger } from '../logger';
import {
  FRAME_HEADER_BYTES,
  FrameParser,
  type HelperCommand,
  helperCommand,
  type HelperFrame,
  HelperProcess,
  type HelperProcessOptions,
  HelperProtocolError,
  type HelperRunEnd,
  LineSplitter,
  MAX_FRAME_PAYLOAD_BYTES,
  MAX_HELPER_LINE_CHARS,
} from './HelperProcess';

const FAKE_HELPER = fileURLToPath(
  new URL('../../../test/fixtures/fake-roger-audio.mjs', import.meta.url),
);

/** One frame as `roger-audio tap` writes it (native/roger-audio/Protocol.swift). */
function frameBytes(payload: Uint8Array, capturedAtMs: number, magic = 'RGA1'): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.write(magic, 0, 'ascii');
  header.writeUInt32LE(payload.byteLength, 4);
  header.writeDoubleLE(capturedAtMs, 8);
  return Buffer.concat([header, payload]);
}

function payloadOf(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

describe('FrameParser', () => {
  it('reads frames however the pipe splits them', () => {
    const frames = [
      { pcm: payloadOf(3200, 1), capturedAtMs: 1_759_744_800_000.5 },
      { pcm: payloadOf(1600, 2), capturedAtMs: 1_759_744_800_100.25 },
      { pcm: payloadOf(3200, 3), capturedAtMs: 1_759_744_800_150 },
    ];
    const stream = Buffer.concat(frames.map((frame) => frameBytes(frame.pcm, frame.capturedAtMs)));
    // Splits inside a header, inside a payload and right on a frame boundary.
    for (const size of [1, 7, 16, 3216, 5000, stream.length]) {
      const parser = new FrameParser();
      const got: HelperFrame[] = [];
      for (let offset = 0; offset < stream.length; offset += size) {
        got.push(...parser.push(stream.subarray(offset, offset + size)));
      }
      expect(got).toEqual(frames);
    }
  });

  it('takes the payload length from the header: the last frame before a gap is shorter', () => {
    const parser = new FrameParser();
    const short = parser.push(frameBytes(payloadOf(640, 9), 1_000));
    expect(short).toEqual([{ pcm: payloadOf(640, 9), capturedAtMs: 1_000 }]);
  });

  it('copies each payload, so a sink that keeps it never holds the pipe buffer', () => {
    const data = frameBytes(payloadOf(3200, 4), 1_000);
    const [frame] = new FrameParser().push(data);
    data.fill(0);
    expect(frame?.pcm.byteOffset).toBe(0);
    expect(frame?.pcm.buffer.byteLength).toBe(3200);
    expect(frame?.pcm).toEqual(payloadOf(3200, 4));
  });

  it('skips a frame with no payload', () => {
    const parser = new FrameParser();
    const got = parser.push(
      Buffer.concat([frameBytes(new Uint8Array(0), 1_000), frameBytes(payloadOf(2, 1), 2_000)]),
    );
    expect(got).toEqual([{ pcm: payloadOf(2, 1), capturedAtMs: 2_000 }]);
  });

  // A stream that lost its place cannot be read again: every later "frame" would be noise.
  it('refuses a frame that does not start with RGA1', () => {
    expect(() => new FrameParser().push(frameBytes(payloadOf(2, 1), 1_000, 'RGA2'))).toThrow(
      new HelperProtocolError('frame 1 does not start with "RGA1"'),
    );
  });

  it('refuses a payload of an odd length, or longer than any chunk', () => {
    const odd = frameBytes(payloadOf(3, 1), 1_000);
    expect(() => new FrameParser().push(odd)).toThrow(
      new HelperProtocolError('frame 1 has an odd payload length (3 bytes): not Int16 samples'),
    );
    const huge = Buffer.alloc(FRAME_HEADER_BYTES);
    huge.write('RGA1', 0, 'ascii');
    huge.writeUInt32LE(MAX_FRAME_PAYLOAD_BYTES + 2, 4);
    expect(() => new FrameParser().push(huge)).toThrow(
      new HelperProtocolError(
        `frame 1 announces ${MAX_FRAME_PAYLOAD_BYTES + 2} payload bytes, over ${MAX_FRAME_PAYLOAD_BYTES}`,
      ),
    );
  });

  it('refuses a capture time that is not a number', () => {
    for (const time of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const parser = new FrameParser();
      parser.push(frameBytes(payloadOf(2, 1), 1_000));
      expect(() => parser.push(frameBytes(payloadOf(2, 1), time))).toThrow(
        new HelperProtocolError(`frame 2 has no capture time (${time})`),
      );
    }
  });
});

describe('LineSplitter', () => {
  it('splits on newlines, drops a carriage return and keeps a partial line for later', () => {
    const lines = new LineSplitter();
    expect(lines.push('{"event":"ready"}\r\n{"event":')).toEqual(['{"event":"ready"}']);
    expect(lines.push('"stats"}\n\n')).toEqual(['{"event":"stats"}', '']);
  });

  // A helper that never writes a newline must not grow main's memory without bound.
  it('cuts a line at the cap and drops the rest of it, up to its newline', () => {
    const lines = new LineSplitter();
    const long = 'x'.repeat(MAX_HELPER_LINE_CHARS + 10);
    expect(lines.push(long)).toEqual(['x'.repeat(MAX_HELPER_LINE_CHARS)]);
    expect(lines.push('yyy\nnext\n')).toEqual(['next']);
  });
});

describe('helperCommand', () => {
  it('runs the fake helper with this process binary as Node', () => {
    const command = helperCommand({ origin: 'e2e-fake', path: '/app/fake.mjs' }, ['tap'], {
      HOME: '/Users/someone',
    });
    expect(command).toEqual({
      file: process.execPath,
      args: ['/app/fake.mjs', 'tap'],
      env: { HOME: '/Users/someone', ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('runs the real helper itself', () => {
    const env = { HOME: '/Users/someone' };
    for (const origin of ['bundle', 'dev-build'] as const) {
      expect(helperCommand({ origin, path: '/x/roger-audio' }, ['monitor'], env)).toEqual({
        file: '/x/roger-audio',
        args: ['monitor'],
        env,
      });
    }
  });
});

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

function fake(args: string[], directives = ''): HelperCommand {
  return helperCommand({ origin: 'e2e-fake', path: FAKE_HELPER }, args, {
    ...process.env,
    ROGER_FAKE_AUDIO: directives,
  });
}

interface Recorded {
  spawns: number[];
  frames: HelperFrame[];
  stdout: string[];
  stderr: string[];
  restarts: HelperRunEnd[];
  failed: HelperRunEnd[];
}

/**
 * A helper whose callbacks are recorded; it is stopped after the test whatever happens. The tests
 * run concurrently, so the hook is the test's own (`context.onTestFinished`): Vitest does not tie
 * the global one to a concurrent test, and it stopped other tests' helpers.
 */
function supervise(
  context: TestContext,
  command: HelperCommand,
  options: Partial<Omit<HelperProcessOptions, 'command' | 'listener'>> = {},
): { helper: HelperProcess; seen: Recorded } {
  const seen: Recorded = {
    spawns: [],
    frames: [],
    stdout: [],
    stderr: [],
    restarts: [],
    failed: [],
  };
  const helper = new HelperProcess({
    name: 'test',
    command,
    stdout: 'frames',
    logger,
    restartDelayMs: 20,
    ...options,
    listener: {
      onSpawn: ({ run }) => seen.spawns.push(run),
      onFrame: (frame) => seen.frames.push(frame),
      onStdoutLine: (line) => seen.stdout.push(line),
      onStderrLine: (line) => seen.stderr.push(line),
      onRestart: (end) => seen.restarts.push(end),
      onFailed: (end) => seen.failed.push(end),
    },
  });
  context.onTestFinished(async () => {
    await helper.stop();
  });
  return { helper, seen };
}

const events = (lines: string[]): string[] =>
  lines.map((line) => (JSON.parse(line) as { event: string }).event);

/** An executable file of bytes no Mac can run: spawning it fails with ENOEXEC. */
function garbageExecutable(context: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'roger-garbage-'));
  context.onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, 'roger-audio');
  writeFileSync(file, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0, 1, 2, 3]), { mode: 0o755 });
  return file;
}

// Concurrent: each test runs its own fake helper processes, and most of them wait on real time.
describe.concurrent('HelperProcess', () => {
  it('hands on tap frames with their capture times, and the stderr lines', async (context) => {
    const before = Date.now();
    const { helper, seen } = supervise(context, fake(['tap'], 'tick-ms=100'));
    helper.start();
    await vi.waitFor(() => {
      expect(seen.frames.length).toBeGreaterThanOrEqual(3);
      expect(events(seen.stderr)).toContain('stats');
    });
    expect(seen.spawns).toEqual([1]);
    expect(events(seen.stderr)[0]).toBe('ready');
    for (const frame of seen.frames) expect(frame.pcm.byteLength).toBe(3200);
    const [first, second] = seen.frames;
    expect(first!.capturedAtMs).toBeGreaterThanOrEqual(before);
    // Continuous audio: each frame starts where the one before it ended.
    expect(second!.capturedAtMs - first!.capturedAtMs).toBe(100);
  });

  it('hands on stdout lines in lines mode, and alive lines keep a quiet monitor running', async (context) => {
    const { helper, seen } = supervise(
      context,
      fake(['monitor', '--parent-pid', '1234'], 'tick-ms=100'),
      {
        stdout: 'lines',
        hangKillMs: 1_000,
      },
    );
    helper.start();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(events(seen.stdout).slice(0, 2)).toEqual(['mic_users', 'route']);
    expect(events(seen.stdout).filter((event) => event === 'alive').length).toBeGreaterThan(5);
    expect(seen.restarts).toEqual([]);
    expect(seen.spawns).toEqual([1]);
  });

  it('writes commands to the helper stdin', async (context) => {
    const { helper, seen } = supervise(context, fake(['tap']));
    helper.start();
    expect(helper.writeLine('rebuild')).toBe(true);
    await vi.waitFor(() => {
      expect(events(seen.stderr)).toContain('restarted');
    });
  });

  // The 3 s watchdog of the M2 design: a stopped or deadlocked helper never exits, so restarting
  // only on exit would leave call audio dead until the person noticed.
  it('kills a helper that writes nothing for hangKillMs and restarts it', async (context) => {
    const { helper, seen } = supervise(context, fake(['tap']), { hangKillMs: 500 });
    helper.start();
    await vi.waitFor(() => {
      expect(seen.frames.length).toBeGreaterThan(0);
    });
    const hungAt = Date.now();
    helper.writeLine('hang');
    await vi.waitFor(() => {
      expect(seen.spawns).toEqual([1, 2]);
    });
    expect(Date.now() - hungAt).toBeGreaterThanOrEqual(500);
    expect(seen.restarts).toEqual([
      {
        run: 1,
        cause: 'hung',
        exitCode: null,
        signal: 'SIGKILL',
        detail: 'no output for 500 ms',
        restarts: 1,
      },
    ]);
    const framesBefore = seen.frames.length;
    await vi.waitFor(() => {
      expect(seen.frames.length).toBeGreaterThan(framesBefore);
    });
    expect(helper.restarts).toBe(1);
  });

  it('restarts a helper that exits on its own', async (context) => {
    const { helper, seen } = supervise(context, fake(['tap']));
    helper.start();
    helper.writeLine('crash');
    await vi.waitFor(() => {
      expect(seen.spawns).toEqual([1, 2]);
    });
    expect(seen.restarts).toEqual([
      { run: 1, cause: 'crashed', exitCode: 1, signal: null, detail: 'exit 1', restarts: 1 },
    ]);
  });

  it('kills and restarts a helper that writes a malformed frame', async (context) => {
    const { helper, seen } = supervise(context, fake(['tap'], 'bad-frame-after=2'), {
      maxRestarts: 1,
    });
    helper.start();
    await vi.waitFor(() => {
      expect(seen.restarts.length).toBe(1);
    });
    expect(seen.restarts[0]).toMatchObject({
      run: 1,
      cause: 'protocol',
      signal: 'SIGKILL',
      detail: 'frame 3 does not start with "RGA1"',
    });
    // The frames before the bad one were good.
    expect(seen.frames.length).toBeGreaterThanOrEqual(2);
  });

  it('gives up after maxRestarts restarts in a row', async (context) => {
    const { helper, seen } = supervise(context, fake(['tap'], 'crash-after=0'), { maxRestarts: 5 });
    helper.start();
    await vi.waitFor(
      () => {
        expect(seen.failed.length).toBe(1);
      },
      { timeout: 5_000 },
    );
    expect(seen.spawns).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen.restarts.map((end) => end.restarts)).toEqual([1, 2, 3, 4, 5]);
    expect(seen.failed[0]).toMatchObject({ run: 6, cause: 'crashed', exitCode: 1, restarts: 5 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen.spawns).toHaveLength(6);
    expect(helper.writeLine('rebuild')).toBe(false);
  });

  it('counts restarts afresh once a run has lasted healthyResetMs', async (context) => {
    const { helper, seen } = supervise(context, fake(['tap']), {
      maxRestarts: 1,
      healthyResetMs: 300,
    });
    helper.start();
    helper.writeLine('crash');
    await vi.waitFor(() => {
      expect(seen.spawns).toEqual([1, 2]);
    });
    // Run 2 lives past healthyResetMs, so its crash starts the count again.
    await new Promise((resolve) => setTimeout(resolve, 400));
    helper.writeLine('crash');
    await vi.waitFor(() => {
      expect(seen.spawns).toEqual([1, 2, 3]);
    });
    // Run 3 crashes at once: one restart in a row is all it has.
    helper.writeLine('crash');
    await vi.waitFor(() => {
      expect(seen.failed.length).toBe(1);
    });
    expect(seen.restarts.map((end) => end.restarts)).toEqual([1, 1]);
  });

  it('treats a helper that cannot start as one that crashed', async (context) => {
    const { helper, seen } = supervise(
      context,
      { file: '/nonexistent/roger-audio', args: ['tap'], env: {} },
      { maxRestarts: 1 },
    );
    helper.start();
    await vi.waitFor(() => {
      expect(seen.failed.length).toBe(1);
    });
    expect(seen.failed[0]).toMatchObject({ run: 2, cause: 'crashed', restarts: 1 });
    expect(seen.failed[0]!.detail).toContain('ENOENT');
  });

  // Node throws a spawn failure outside its async list (EACCES, EAGAIN, EMFILE, ENFILE, ENOENT) at
  // once: ENOEXEC for a binary `make native` is still writing, EBADARCH for an x64 Roger.app on an
  // Intel Mac that carries the arm64 helper (electron-builder.yml).
  it('treats a helper whose spawn throws as one that cannot start, at start and at every restart', async (context) => {
    const file = garbageExecutable(context);
    // The case under test: this Node throws for it rather than emitting 'error'.
    expect(() => spawn(file, [], { stdio: 'ignore' })).toThrow('spawn ENOEXEC');
    const { helper, seen } = supervise(
      context,
      { file, args: ['tap'], env: {} },
      { maxRestarts: 2 },
    );
    expect(() => {
      helper.start();
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(seen.failed.length).toBe(1);
    });
    expect(seen.spawns).toEqual([1, 2, 3]);
    expect(seen.restarts.map((end) => end.restarts)).toEqual([1, 2]);
    expect(seen.failed[0]).toEqual({
      run: 3,
      cause: 'crashed',
      exitCode: null,
      signal: null,
      detail: `could not start ${file}: spawn ENOEXEC`,
      restarts: 2,
    });
    expect(helper.writeLine('rebuild')).toBe(false);
  });

  it('stop closes stdin, and a helper that exits on it is not restarted', async (context) => {
    const { helper, seen } = supervise(context, fake(['tap']));
    helper.start();
    await vi.waitFor(() => {
      expect(seen.frames.length).toBeGreaterThan(0);
    });
    await expect(helper.stop()).resolves.toEqual({ exitCode: 0, signal: null });
    const frames = seen.frames.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(seen.spawns).toEqual([1]);
    expect(seen.restarts).toEqual([]);
    expect(seen.frames).toHaveLength(frames);
    expect(helper.writeLine('rebuild')).toBe(false);
  });

  it('stop sends SIGTERM to a helper that keeps running after stdin ends', async (context) => {
    const { helper } = supervise(context, fake(['tap'], 'ignore-eof'), { stdinGraceMs: 100 });
    helper.start();
    await expect(helper.stop()).resolves.toEqual({ exitCode: null, signal: 'SIGTERM' });
  });

  it('stop sends SIGKILL to a helper that also ignores SIGTERM', async (context) => {
    const { helper } = supervise(context, fake(['tap'], 'ignore-eof,ignore-term'), {
      stdinGraceMs: 100,
      termKillMs: 200,
    });
    helper.start();
    // Let the fake install its SIGTERM handler first, as the real helper does at once.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(helper.stop()).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' });
  });

  it('answers the same stop twice, and a stop before start or after giving up with null', async (context) => {
    const { helper } = supervise(context, fake(['tap']));
    await expect(helper.stop()).resolves.toBeNull();

    const other = supervise(context, fake(['tap'])).helper;
    other.start();
    const first = other.stop();
    expect(other.stop()).toBe(first);
    await first;
  });

  it('stop while a restart waits cancels the restart', async (context) => {
    const { helper, seen } = supervise(context, fake(['tap']), { restartDelayMs: 300 });
    helper.start();
    helper.writeLine('crash');
    await vi.waitFor(() => {
      expect(seen.restarts.length).toBe(1);
    });
    await expect(helper.stop()).resolves.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen.spawns).toEqual([1]);
  });

  it('restart replaces the running helper at once and does not count it', async (context) => {
    const { helper, seen } = supervise(context, fake(['tap']), { stdinGraceMs: 100 });
    helper.start();
    await vi.waitFor(() => {
      expect(seen.frames.length).toBeGreaterThan(0);
    });
    helper.restart('the Mac woke up');
    await vi.waitFor(() => {
      expect(seen.spawns).toEqual([1, 2]);
    });
    expect(seen.restarts).toEqual([]);
    expect(helper.restarts).toBe(0);
  });

  it('logs a listener that throws, and the helper keeps going', async (context) => {
    const lines: string[] = [];
    const helper = new HelperProcess({
      name: 'tap',
      command: fake(['tap']),
      stdout: 'frames',
      logger: createLogger({ level: 'error', format: 'json', sink: (line) => lines.push(line) }),
      listener: {
        onFrame: () => {
          throw new Error('sink broke');
        },
      },
    });
    context.onTestFinished(async () => {
      await helper.stop();
    });
    helper.start();
    await vi.waitFor(() => {
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'error',
      message: 'audio helper listener failed',
      helper: 'tap',
      callback: 'onFrame',
      error: 'sink broke',
    });
    expect(helper.restarts).toBe(0);
  });
});
