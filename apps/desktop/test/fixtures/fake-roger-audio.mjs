// A stand-in for `roger-audio`, the Swift audio helper (native/roger-audio), for tests and the
// Electron smoke test (M2-T13). It speaks the helper's wire contract with no Core Audio, no device
// and no privacy prompt. Change it with the files that define that contract:
//   - `tap`: native/roger-audio/Protocol.swift; read by src/main/native/HelperProcess.ts and
//     src/main/audio/system/TapSystemAudio.ts (M2-T10)
//   - `monitor`: the top of native/roger-audio/Monitor.swift; read by M2-T17a's MeetingAppMonitor
//   - `probe`: the top of native/roger-audio/Probe.swift; read by M2-T19's setup screen
// A mismatch shows up as call audio that never arrives, in the app and nowhere in these tests.
//
// It is a Node script: run it with Node, or with Electron's binary under ELECTRON_RUN_AS_NODE=1
// (src/main/native/helperPath.ts, origin `e2e-fake`), never exec it.
//
//   node fake-roger-audio.mjs tap [--sample-rate 16000] [--chunk-ms 100]
//   node fake-roger-audio.mjs monitor --parent-pid <pid> [--relaunch-dry-run]
//   node fake-roger-audio.mjs probe [--seconds 2]
//   node fake-roger-audio.mjs selftest
//
// With nothing set, `tap` is a healthy helper playing a 440 Hz tone: `ready`, then one frame per
// chunk in real time with continuous capture times, and `stats` every second. The environment
// variable ROGER_FAKE_AUDIO bends it for a test, as comma-separated directives:
//   silence              frames of digital zeros instead of the tone
//   format=<hz>          announce this sample rate in `ready` (main refuses anything but 16000)
//   no-ready             never send `ready`; frames still flow
//   crash-after=<n>      after n frames, send an `error` event and exit 1 (every run does)
//   bad-frame-after=<n>  after n frames, write a frame whose magic is not "RGA1"
//   clock-offset-ms=<n>  date every frame this far from the wall clock
//   tick-ms=<n>          `stats` (and the monitor's `alive`) every n ms instead of every second
//   ignore-eof           keep running when stdin ends
//   ignore-term          ignore SIGTERM, so only SIGKILL ends it
// stdin of `tap` takes, one per line, the real `rebuild` (answered with `restarted`) and, for
// tests: `hang` stops every write and keeps the process alive, as a helper stuck in a Core Audio
// call or stopped with `pkill -STOP` would; `crash` sends an `error` event and exits 1; `route`
// answers `restarted {reason: output_device_changed}`, as an output switch does.
//
// Like the real helper it exits when stdin ends, when its parent dies and when stdout or stderr
// closes, so a test that fails half way never leaves one running.

import process from 'node:process';

const TONE_HZ = 440;
const TONE_AMPLITUDE = 8_000;
const MAGIC = 'RGA1';
const HEADER_BYTES = 16;
/** The tap format the real helper reports from Core Audio; main only logs it. */
const TAP_FORMAT = { sampleRate: 48_000, channels: 2 };

const directives = parseDirectives(process.env.ROGER_FAKE_AUDIO ?? '');
const tickMs = directives['tick-ms'] ?? 1_000;

function parseDirectives(text) {
  const parsed = {};
  for (const item of text.split(',')) {
    const directive = item.trim();
    if (directive === '') continue;
    const [name, value] = directive.split('=');
    parsed[name] = value === undefined ? true : Number(value);
  }
  return parsed;
}

/** One JSON line, "event" first, as Protocol.swift writes them. */
function line(stream, event) {
  stream.write(`${JSON.stringify(event)}\n`);
}

function emit(event) {
  line(process.stderr, event);
}

function fail(code, message, exitCode) {
  emit({ event: 'error', code, message });
  process.exit(exitCode);
}

/** `--name value` options and bare flags; anything else is a usage error, as in the helper. */
function parseOptions(args, valueOptions, flagOptions = []) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (valueOptions.includes(name) && index + 1 < args.length) {
      options[name] = args[index + 1];
      index += 1;
    } else if (flagOptions.includes(name)) {
      options[name] = true;
    } else {
      fail('usage', `unknown option ${name}`, 64);
    }
  }
  return options;
}

/** Calls `onLine` for each stdin line and `onEnd` when stdin ends. */
function readStdin(onLine, onEnd) {
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    pending += data;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const command = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (command !== '') onLine(command);
      newline = pending.indexOf('\n');
    }
  });
  process.stdin.on('end', onEnd);
}

/** The helper's ways out that do not depend on what it was asked to do. */
function exitWithParent() {
  const parent = process.ppid;
  // Reparented (to launchd, or init on Linux): Roger is gone and nobody reads the output.
  setInterval(() => {
    if (process.ppid !== parent) process.exit(0);
  }, 200);
  // EPIPE: the reader closed its end.
  process.stdout.on('error', () => process.exit(0));
  process.stderr.on('error', () => process.exit(0));
  if (directives['ignore-term'] === true) process.on('SIGTERM', () => undefined);
}

function stdinEnded() {
  if (directives['ignore-eof'] !== true) process.exit(0);
}

function runTap(args) {
  const options = parseOptions(args, ['--sample-rate', '--chunk-ms']);
  const sampleRate = Number(options['--sample-rate'] ?? 16_000);
  const chunkMs = Number(options['--chunk-ms'] ?? 100);
  const samplesPerFrame = (sampleRate * chunkMs) / 1_000;
  const startedAtMs = Date.now() + (directives['clock-offset-ms'] ?? 0);
  let hung = false;
  let written = 0;
  let sinceStats = { peak: 0, frames: 0 };

  const crash = () => fail('tap_failed', 'the fake helper was told to crash', 1);

  if (directives['no-ready'] !== true) {
    emit({
      event: 'ready',
      format: {
        encoding: 'linear16',
        sampleRate: directives.format ?? sampleRate,
        channels: 1,
        chunkMs,
      },
      tapFormat: TAP_FORMAT,
    });
  }

  setInterval(() => {
    if (hung) return;
    if (directives['crash-after'] !== undefined && written >= directives['crash-after']) crash();
    const payload = Buffer.alloc(samplesPerFrame * 2);
    const firstSample = written * samplesPerFrame;
    for (let index = 0; index < samplesPerFrame; index += 1) {
      const sample =
        directives.silence === true
          ? 0
          : Math.round(
              Math.sin((2 * Math.PI * TONE_HZ * (firstSample + index)) / sampleRate) *
                TONE_AMPLITUDE,
            );
      payload.writeInt16LE(sample, index * 2);
      sinceStats.peak = Math.max(sinceStats.peak, Math.abs(sample));
    }
    const header = Buffer.alloc(HEADER_BYTES);
    const badFrame =
      directives['bad-frame-after'] !== undefined && written >= directives['bad-frame-after'];
    header.write(badFrame ? 'XXXX' : MAGIC, 0, 'ascii');
    header.writeUInt32LE(payload.length, 4);
    header.writeDoubleLE(startedAtMs + (firstSample / sampleRate) * 1_000, 8);
    process.stdout.write(Buffer.concat([header, payload]));
    written += 1;
    sinceStats.frames += 1;
  }, chunkMs);

  setInterval(() => {
    if (hung) return;
    emit({ event: 'stats', peak: sinceStats.peak, frames: sinceStats.frames, dropped: 0 });
    sinceStats = { peak: 0, frames: 0 };
  }, tickMs);

  readStdin((command) => {
    if (hung) return;
    if (command === 'rebuild') {
      emit({ event: 'restarted', reason: 'rebuild_requested', tapFormat: TAP_FORMAT });
    } else if (command === 'route') {
      emit({ event: 'restarted', reason: 'output_device_changed', tapFormat: TAP_FORMAT });
    } else if (command === 'hang') {
      hung = true;
    } else if (command === 'crash') {
      crash();
    } else {
      emit({ event: 'warning', code: 'unknown_command', message: `unknown command ${command}` });
    }
  }, stdinEnded);
}

function runMonitor(args) {
  const options = parseOptions(args, ['--parent-pid'], ['--relaunch-dry-run']);
  if (options['--parent-pid'] === undefined) fail('usage', 'monitor needs --parent-pid', 64);
  let recording = false;
  line(process.stdout, { event: 'mic_users', users: [] });
  line(process.stdout, {
    event: 'route',
    output: { name: 'Fake Speakers', transport: 'built_in_speaker' },
    input: { name: 'Fake Microphone', transport: 'built_in' },
  });
  setInterval(() => line(process.stdout, { event: 'alive' }), tickMs);
  readStdin((command) => {
    const on = command === 'recording on' ? true : command === 'recording off' ? false : null;
    if (on === null) {
      emit({ event: 'warning', code: 'unknown_command', message: `unknown command ${command}` });
    } else if (on !== recording) {
      recording = on;
      line(process.stdout, { event: 'recording', on });
    }
  }, stdinEnded);
}

function runProbe(args) {
  const options = parseOptions(args, ['--seconds']);
  const seconds = Number(options['--seconds'] ?? 2);
  line(process.stdout, { event: 'listening', seconds });
  setTimeout(() => {
    const peak = directives.silence === true ? 0 : TONE_AMPLITUDE;
    line(process.stdout, { event: 'result', peak, audioMs: seconds * 1_000 });
    process.exit(0);
  }, seconds * 1_000);
}

const [command, ...rest] = process.argv.slice(2);
exitWithParent();
switch (command) {
  case 'tap':
    runTap(rest);
    break;
  case 'monitor':
    runMonitor(rest);
    break;
  case 'probe':
    runProbe(rest);
    break;
  case 'selftest':
    process.stdout.write('selftest: the fake helper has nothing to test\n');
    process.exit(0);
    break;
  default:
    process.stderr.write('usage: fake-roger-audio.mjs tap|monitor|probe|selftest [options]\n');
    process.exit(64);
}
