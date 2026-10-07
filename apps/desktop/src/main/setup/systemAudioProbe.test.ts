import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger';
import { helperCommand } from '../native/HelperProcess';
import type { HelperLocation } from '../native/helperPath';
import {
  decideProbe,
  playFile,
  probeCommand,
  type ProbeRun,
  runSystemAudioProbe,
} from './systemAudioProbe';

// Never the real helper: after `make check` on a Mac, native/bin/roger-audio exists, and its probe
// builds a real tap (a privacy prompt for whatever runs the tests). M2-T10's fake answers `probe`
// as Probe.swift describes; the stand-ins below speak the cases it has no switch for.
const FAKE_HELPER: HelperLocation = {
  origin: 'e2e-fake',
  path: fileURLToPath(new URL('../../../test/fixtures/fake-roger-audio.mjs', import.meta.url)),
};

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

const standIns = mkdtempSync(join(tmpdir(), 'roger-probe-test-'));
afterAll(() => {
  rmSync(standIns, { recursive: true, force: true });
});

/** A Node script run as the helper is: the fake helper's way (origin `e2e-fake`). */
function standIn(name: string, source: string): HelperLocation {
  const path = join(standIns, `${name}.mjs`);
  writeFileSync(path, source);
  return { origin: 'e2e-fake', path };
}

function run(change: Partial<ProbeRun> = {}): ProbeRun {
  return {
    result: { peak: 0, audioMs: 1_000 },
    listened: true,
    errorCode: null,
    exitCode: 0,
    signal: null,
    spawnError: null,
    timedOut: false,
    soundError: null,
    ...change,
  };
}

describe('decideProbe', () => {
  it("reads any peak above zero as heard: any sound counts, ours or another app's", () => {
    expect(decideProbe(run({ result: { peak: 8_000, audioMs: 1_000 } }))).toEqual({
      kind: 'heard',
      peak: 8_000,
      audioMs: 1_000,
    });
    // Even when our own sound failed: something else played, so the permission is there.
    expect(
      decideProbe(run({ result: { peak: 12, audioMs: 1_000 }, soundError: 'afplay exited 1' })),
    ).toMatchObject({ kind: 'heard' });
  });

  it('reads digital silence over real audio as silent, the only answer that spends `pending`', () => {
    expect(decideProbe(run())).toEqual({ kind: 'silent', audioMs: 1_000 });
  });

  it('reads a route change as no answer: the tap may have gone deaf, so its silence proves nothing', () => {
    expect(decideProbe(run({ result: null, errorCode: 'route_changed', exitCode: 1 }))).toEqual({
      kind: 'no-answer',
      code: 'route_changed',
      detail: 'the sound output changed while Roger listened',
    });
  });

  it('reads every other helper failure as no answer', () => {
    expect(decideProbe(run({ result: null, errorCode: 'tap_create_failed', exitCode: 1 }))).toEqual(
      {
        kind: 'no-answer',
        code: 'tap_create_failed',
        detail: 'the call audio helper could not listen (tap_create_failed)',
      },
    );
    expect(decideProbe(run({ result: { peak: 0, audioMs: 0 } }))).toEqual({
      kind: 'no-answer',
      code: 'no_audio',
      detail: 'the call audio helper got no audio at all',
    });
    expect(decideProbe(run({ result: null, exitCode: 70 }))).toEqual({
      kind: 'no-answer',
      code: 'no_result',
      detail: 'the call audio helper stopped without an answer (exit 70)',
    });
    expect(decideProbe(run({ result: null, exitCode: null, spawnError: 'ENOENT' }))).toEqual({
      kind: 'no-answer',
      code: 'spawn_failed',
      detail: 'the call audio helper could not start (ENOENT)',
    });
    expect(decideProbe(run({ result: null, exitCode: null, timedOut: true }))).toEqual({
      kind: 'no-answer',
      code: 'timeout',
      detail: 'the call audio helper gave no answer in time',
    });
  });

  it('reads silence as no answer when the test sound never played', () => {
    expect(decideProbe(run({ soundError: 'afplay exited 1' }))).toEqual({
      kind: 'no-answer',
      code: 'sound_failed',
      detail: 'Roger could not play its test sound (afplay exited 1)',
    });
    expect(decideProbe(run({ listened: false }))).toEqual({
      kind: 'no-answer',
      code: 'sound_failed',
      detail: 'Roger could not play its test sound (the helper never said it was listening)',
    });
  });
});

describe('runSystemAudioProbe', () => {
  it('plays the test sound once the helper listens, and hears it', async () => {
    const playSound = vi.fn(() => Promise.resolve());
    const outcome = await runSystemAudioProbe({
      command: probeCommand(FAKE_HELPER, 1, {}),
      playSound,
      logger,
    });
    expect(outcome).toEqual({ kind: 'heard', peak: 8_000, audioMs: 1_000 });
    expect(playSound).toHaveBeenCalledTimes(1);
  });

  it('answers silent when the tap records digital zeros', async () => {
    const outcome = await runSystemAudioProbe({
      command: probeCommand(FAKE_HELPER, 1, { ROGER_FAKE_AUDIO: 'silence' }),
      playSound: () => Promise.resolve(),
      logger,
    });
    expect(outcome).toEqual({ kind: 'silent', audioMs: 1_000 });
  });

  it('answers no answer when the sound could not play, rather than a false silent', async () => {
    const outcome = await runSystemAudioProbe({
      command: probeCommand(FAKE_HELPER, 1, { ROGER_FAKE_AUDIO: 'silence' }),
      playSound: () => Promise.reject(new Error('afplay exited 1')),
      logger,
    });
    expect(outcome).toMatchObject({ kind: 'no-answer', code: 'sound_failed' });
  });

  it("reads the helper's error event when it exits without a result", async () => {
    const helper = standIn(
      'route-change',
      `process.stdout.write('{"event":"listening","seconds":1}\\n');
       process.stderr.write('{"event":"error","code":"route_changed","message":"the output changed"}\\n');
       process.exitCode = 1;`,
    );
    const outcome = await runSystemAudioProbe({
      command: helperCommand(helper, ['probe'], {}),
      playSound: () => Promise.resolve(),
      logger,
    });
    expect(outcome).toMatchObject({ kind: 'no-answer', code: 'route_changed' });
  });

  it('kills a helper that never answers, and says so', async () => {
    const helper = standIn('hang', 'setInterval(() => undefined, 1_000);');
    const started = Date.now();
    const outcome = await runSystemAudioProbe({
      command: helperCommand(helper, ['probe'], {}),
      playSound: () => Promise.resolve(),
      logger,
      timeoutMs: 300,
    });
    expect(outcome).toMatchObject({ kind: 'no-answer', code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('answers no answer for a helper that is not there, never throws', async () => {
    const outcome = await runSystemAudioProbe({
      command: helperCommand({ origin: 'dev-build', path: join(standIns, 'no-such-helper') }, [
        'probe',
      ]),
      playSound: () => Promise.resolve(),
      logger,
    });
    expect(outcome).toMatchObject({ kind: 'no-answer', code: 'spawn_failed' });
  });
});

describe('playFile', () => {
  it('resolves when the player exits 0 and rejects with its exit otherwise', async () => {
    await expect(playFile('/usr/bin/true', '/System/Library/Sounds/Glass.aiff')).resolves.toBe(
      undefined,
    );
    await expect(playFile('/usr/bin/false', '/System/Library/Sounds/Glass.aiff')).rejects.toThrow(
      /false exited 1/,
    );
  });
});
