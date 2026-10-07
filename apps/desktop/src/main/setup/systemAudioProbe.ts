import { execFile, spawn } from 'node:child_process';
import { parseHelperEvent } from '../audio/system/helperEvents';
import { errorMessage, type Logger } from '../logger';
import { type HelperCommand, helperCommand, LineSplitter } from '../native/HelperProcess';
import type { HelperLocation } from '../native/helperPath';

/**
 * The setup screen's System Audio Recording check (M2 design, "Permission check for system
 * audio"). No public API reads that permission, and a refused or still-pending tap records digital
 * silence with no error, so Roger plays a system sound while `roger-audio probe` listens through a
 * real tap: heard means granted. The probe's protocol is at the top of
 * native/roger-audio/Probe.swift; the fake helper (test/fixtures/fake-roger-audio.mjs) speaks it.
 */

/** How long the probe listens once its tap runs (Probe.swift takes 1 to 10). */
export const PROBE_SECONDS = 2;
/**
 * Probe.swift tears its tap down after at most 10 s whatever happens; a helper still running past
 * this is stuck, and is killed.
 */
export const PROBE_TIMEOUT_MS = 15_000;
/** Plays a sound file and exits; ships with macOS. */
export const AFPLAY = '/usr/bin/afplay';
/** One of macOS's own alert sounds: short, and on every Mac. */
export const TEST_SOUND = '/System/Library/Sounds/Glass.aiff';
const PLAY_TIMEOUT_MS = 10_000;

/** What a probe answered about the permission. */
export type ProbeOutcome =
  /** The tap heard something (any app's sound counts): System Audio Recording is allowed. */
  | { kind: 'heard'; peak: number; audioMs: number }
  /**
   * The tap ran and the test sound played, and it recorded digital silence: not allowed, the
   * macOS dialog still up, or the Mac muted. The only outcome that says anything when nothing is
   * heard, so the only one that may spend the first-silent-probe `pending` (PermissionService).
   */
  | { kind: 'silent'; audioMs: number }
  /**
   * Nothing is known about the permission: the helper failed, the output changed under it, or the
   * test sound never played. `code` is for the log; `detail` completes "Roger could not finish
   * the test: ...".
   */
  | { kind: 'no-answer'; code: string; detail: string };

/** Everything one probe run did, for decideProbe. */
export interface ProbeRun {
  /** Its `result` line, or null when none came. */
  result: { peak: number; audioMs: number } | null;
  /** Its `listening` line came, so the test sound was started. */
  listened: boolean;
  /** The code of its last stderr `error` event. */
  errorCode: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** The errno (ENOENT, EACCES, ...) when the helper could not be started. */
  spawnError: string | null;
  /** It ran past the timeout and was killed. */
  timedOut: boolean;
  /** Why the test sound did not play, or null. */
  soundError: string | null;
}

/**
 * A probe run's answer. Heard wins over everything: any sound proves the permission. Silence
 * counts only when the tap ran (`audioMs` above 0) and the sound played; anything less is no
 * answer, because a silence the probe could not have heard through would spend `pending` on
 * nothing and tell the person "not allowed" on a Mac that is.
 */
export function decideProbe(run: ProbeRun): ProbeOutcome {
  const { result } = run;
  if (result !== null && result.peak > 0) {
    return { kind: 'heard', peak: result.peak, audioMs: result.audioMs };
  }
  const noAnswer = (code: string, detail: string): ProbeOutcome => ({
    kind: 'no-answer',
    code,
    detail,
  });
  if (run.timedOut) return noAnswer('timeout', 'the call audio helper gave no answer in time');
  if (run.spawnError !== null) {
    return noAnswer('spawn_failed', `the call audio helper could not start (${run.spawnError})`);
  }
  if (result === null) {
    if (run.errorCode === 'route_changed') {
      // Probe.swift: a tap that changed under the probe can go deaf, so it ends without a result.
      return noAnswer('route_changed', 'the sound output changed while Roger listened');
    }
    if (run.errorCode !== null) {
      return noAnswer(run.errorCode, `the call audio helper could not listen (${run.errorCode})`);
    }
    const end = run.signal === null ? `exit ${String(run.exitCode)}` : `signal ${run.signal}`;
    return noAnswer('no_result', `the call audio helper stopped without an answer (${end})`);
  }
  if (result.audioMs === 0)
    return noAnswer('no_audio', 'the call audio helper got no audio at all');
  if (!run.listened) {
    return noAnswer(
      'sound_failed',
      'Roger could not play its test sound (the helper never said it was listening)',
    );
  }
  if (run.soundError !== null) {
    return noAnswer('sound_failed', `Roger could not play its test sound (${run.soundError})`);
  }
  return { kind: 'silent', audioMs: result.audioMs };
}

/** `roger-audio probe --seconds <seconds>` at `location`. */
export function probeCommand(
  location: HelperLocation,
  seconds: number = PROBE_SECONDS,
  env: NodeJS.ProcessEnv = process.env,
): HelperCommand {
  return helperCommand(location, ['probe', '--seconds', String(seconds)], env);
}

export interface ProbeRunOptions {
  command: HelperCommand;
  /** Plays the test sound; called once, on the helper's `listening` line. */
  playSound: () => Promise<void>;
  logger: Logger;
  timeoutMs?: number;
}

/** Runs one probe to its end and answers what it learned. Never rejects. */
export async function runSystemAudioProbe(options: ProbeRunOptions): Promise<ProbeOutcome> {
  const run = await collectProbeRun(options);
  const outcome = decideProbe(run);
  const fields = { exitCode: run.exitCode, signal: run.signal };
  if (outcome.kind === 'no-answer') {
    options.logger.warn('system audio probe gave no answer', { code: outcome.code, ...fields });
  } else {
    options.logger.info('system audio probe answered', { outcome: outcome.kind, ...fields });
  }
  return outcome;
}

function collectProbeRun(options: ProbeRunOptions): Promise<ProbeRun> {
  const { command, logger } = options;
  const run: ProbeRun = {
    result: null,
    listened: false,
    errorCode: null,
    exitCode: null,
    signal: null,
    spawnError: null,
    timedOut: false,
    soundError: null,
  };
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnProbe>;
    try {
      child = spawnProbe(command);
    } catch (error) {
      // spawn throws at once for every errno but five (ENOEXEC for a half-written binary).
      run.spawnError = errnoOf(error);
      resolve(run);
      return;
    }
    let sound: Promise<void> = Promise.resolve();
    const timer = setTimeout(() => {
      run.timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? PROBE_TIMEOUT_MS);

    const stdout = new LineSplitter();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      for (const line of stdout.push(text)) {
        const parsed = parseProbeLine(line);
        if (parsed === null) {
          // The line itself is not logged: it is the helper's, unchecked.
          logger.warn('system audio probe wrote a line that is not an event');
        } else if (parsed.event === 'listening' && !run.listened) {
          // Started on this line, never before: Probe.swift starts listening only now, and a
          // sound played earlier ends before the tap exists.
          run.listened = true;
          sound = options.playSound().catch((error: unknown) => {
            run.soundError = errorMessage(error);
          });
        } else if (parsed.event === 'result') {
          run.result = { peak: parsed.peak, audioMs: parsed.audioMs };
        }
      }
    });
    const stderr = new LineSplitter();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text: string) => {
      for (const line of stderr.push(text)) {
        const parsed = parseHelperEvent(line);
        if (parsed.kind !== 'event') continue;
        const { event } = parsed;
        if (event.event === 'error') {
          run.errorCode = event.code;
          logger.warn('system audio probe error', { code: event.code, message: event.message });
        } else if (event.event === 'warning') {
          logger.warn('system audio probe warning', { code: event.code, message: event.message });
        }
      }
    });
    // ENOENT, EACCES, EAGAIN, EMFILE and ENFILE arrive here, then `close` (code -2).
    child.on('error', (error) => {
      run.spawnError ??= errnoOf(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      run.exitCode = exitCode;
      run.signal = signal;
      // The sound ends within a second of the result; its failure decides a silent answer.
      void sound.then(() => {
        resolve(run);
      });
    });
  });
}

/** No stdin: the probe reads none, and a pipe nobody reads would only add an EPIPE to handle. */
function spawnProbe(command: HelperCommand) {
  return spawn(command.file, [...command.args], {
    env: command.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

type ProbeLine =
  { event: 'listening'; seconds: number } | { event: 'result'; peak: number; audioMs: number };

/** One stdout line of `probe`, or null when it is not one Probe.swift writes. */
function parseProbeLine(line: string): ProbeLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const fields = parsed as Record<string, unknown>;
  const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (fields.event === 'listening' && isCount(fields.seconds)) {
    return { event: 'listening', seconds: fields.seconds };
  }
  if (fields.event === 'result' && isCount(fields.peak) && isCount(fields.audioMs)) {
    return { event: 'result', peak: fields.peak, audioMs: fields.audioMs };
  }
  return null;
}

function errnoOf(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return errorMessage(error);
}

/** Plays `file` with `player` (afplay); rejects with why when it did not play. */
export function playFile(player: string, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(player, [file], { timeout: PLAY_TIMEOUT_MS }, (error) => {
      if (error === null) {
        resolve();
        return;
      }
      if (typeof error.code === 'number') {
        reject(new Error(`${player} exited ${error.code}`, { cause: error }));
        return;
      }
      const reason =
        error.killed === true
          ? `${player} gave no answer within ${PLAY_TIMEOUT_MS / 1_000} s`
          : `could not run ${player}: ${error.message}`;
      reject(new Error(reason, { cause: error }));
    });
  });
}

/** The test sound, as the setup screen plays it. */
export function playTestSound(): Promise<void> {
  return playFile(AFPLAY, TEST_SOUND);
}
