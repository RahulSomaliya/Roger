import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COST_GUARDS } from '../src/main/costGuards';
import { createLogger } from '../src/main/logger';
import { SttConnectError } from '../src/main/stt/SpeechToText';
import {
  CANARY_FINAL_WITHIN_MS,
  CANARY_MAX_WER,
  CANARY_REFERENCE,
  CANARY_SPOKEN,
  type CanaryDeps,
  runCanary,
} from './canary';
import { encodeWav } from './core/wav';
import { registryAdapters } from './run/adapters';
import { tone } from './run/testing/benchFolder';
import {
  FakeVendor,
  type FakeVendorScript,
  ScriptedTokenApi,
  tokenResponse,
} from './run/testing/fakes';
import { ManualTimers } from './run/testing/manualTimers';

const T0 = Date.UTC(2026, 9, 6, 10, 0, 0);
const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

describe('runCanary', () => {
  let wireDir = '';

  beforeEach(async () => {
    wireDir = await mkdtemp(join(tmpdir(), 'roger-canary-wire-'));
  });

  afterEach(async () => {
    await rm(wireDir, { recursive: true, force: true });
  });

  function deps(
    options: {
      provider?: string;
      vendor?: FakeVendorScript;
      audio?: Int16Array;
    } = {},
  ): { deps: CanaryDeps; lines: string[]; spoken: string[]; timers: ManualTimers } {
    const timers = new ManualTimers(T0);
    const lines: string[] = [];
    const spoken: string[] = [];
    const provider = options.provider ?? 'assemblyai';
    const adapters =
      provider === 'fake'
        ? registryAdapters({ logger, guards: DEFAULT_COST_GUARDS })
        : new FakeVendor(timers, options.vendor).adapters;
    return {
      timers,
      lines,
      spoken,
      deps: {
        api: new ScriptedTokenApi(
          tokenResponse(
            provider === 'fake' ? { provider, model: 'fake', token: '' } : { provider },
          ),
        ),
        adapters,
        timers,
        opensPerMinute: 4,
        synthesize: async (script, path) => {
          spoken.push(script);
          await writeFile(path, encodeWav(options.audio ?? tone(12_000)));
        },
        out: (line) => lines.push(line),
      },
    };
  }

  /** A vendor that answers the canary's audio with these finals, one every 3 s. */
  function answering(...finals: string[]): FakeVendorScript {
    return {
      onAudio: (stream, endMs) => {
        const index = endMs / 3_000 - 1;
        const text = Number.isInteger(index) ? finals[index] : undefined;
        if (text === undefined) return;
        stream.receive(JSON.stringify({ type: 'Turn', transcript: text }));
        stream.emit({
          type: 'final',
          text,
          startMs: endMs - 3_000,
          endMs,
          confidence: 0.9,
          words: [],
        });
      },
    };
  }

  it('speaks a fixed script with jargon in it, the pauses only in what is spoken', () => {
    expect(CANARY_REFERENCE).toMatch(/Linkt/);
    expect(CANARY_REFERENCE).toMatch(/Roger/);
    expect(CANARY_REFERENCE).not.toMatch(/\[\[/);
    expect(CANARY_SPOKEN).toMatch(/\[\[slnc \d+\]\]/);
    expect(CANARY_FINAL_WITHIN_MS).toBe(10_000);
    expect(CANARY_MAX_WER).toBe(0.15);
  });

  it('with the fake provider checks only that a final arrives in 10 s, and says so', async () => {
    const { deps: canaryDeps, lines, spoken, timers } = deps({ provider: 'fake' });

    const result = await timers.settle(runCanary({ saveWireDir: null }, canaryDeps));

    expect(result).toMatchObject({ passed: true, provider: 'fake', wer: null });
    expect(result.firstFinalMs).toBeLessThanOrEqual(CANARY_FINAL_WITHIN_MS);
    expect(spoken).toEqual([CANARY_SPOKEN]);
    expect(lines).toContain('WER not checked (fake provider)');
  });

  it('fails the fake provider when no final arrives in 10 s', async () => {
    const { deps: canaryDeps, timers } = deps({
      provider: 'fake',
      audio: new Int16Array(16 * 12_000),
    });

    const result = await timers.settle(runCanary({ saveWireDir: null }, canaryDeps));

    expect(result).toMatchObject({ passed: false, reason: 'no final within 10 s' });
  });

  it('passes a real vendor that hears the script', async () => {
    const sentences = CANARY_REFERENCE.split(/(?<=\.) /);
    const { deps: canaryDeps, lines, timers } = deps({ vendor: answering(...sentences) });

    const result = await timers.settle(runCanary({ saveWireDir: null }, canaryDeps));

    expect(result).toMatchObject({
      passed: true,
      provider: 'assemblyai',
      wer: 0,
      firstFinalMs: 3_000,
    });
    expect(lines.at(-1)).toBe('canary passed');
  });

  it('fails a real vendor whose WER is above 15%', async () => {
    const { deps: canaryDeps, timers } = deps({
      vendor: answering('Roger takes the meeting notes', 'something else entirely'),
    });

    const result = await timers.settle(runCanary({ saveWireDir: null }, canaryDeps));

    expect(result.passed).toBe(false);
    expect(result.wer).toBeGreaterThan(CANARY_MAX_WER);
    expect(result.reason).toMatch(/^WER \d+\.\d% is above 15%$/);
  });

  it('fails a real vendor with no final in 10 s, and stops the replay there', async () => {
    const vendor: FakeVendorScript = {};
    const { deps: canaryDeps, timers } = deps({ vendor });

    const result = await timers.settle(runCanary({ saveWireDir: null }, canaryDeps));

    expect(result).toMatchObject({
      passed: false,
      reason: 'no final within 10 s',
      firstFinalMs: null,
    });
    expect(timers.now() - T0).toBeLessThan(12_000);
  });

  it('fails with the reason when the vendor refuses the jargon list', async () => {
    const { deps: canaryDeps, timers } = deps({
      vendor: {
        onOpen: () => {
          throw new SttConnectError(
            'AssemblyAI: closed before the session began (3005); jargon list rejected',
            null,
            {
              keytermsRejected: true,
            },
          );
        },
      },
    });

    const result = await timers.settle(runCanary({ saveWireDir: null }, canaryDeps));

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/jargon list rejected/);
  });

  it("--save-wire writes the vendor's raw messages, one per line, named after the model", async () => {
    const { deps: canaryDeps, timers } = deps({
      vendor: answering('Roger takes the meeting notes'),
    });

    await timers.settle(runCanary({ saveWireDir: wireDir }, canaryDeps));

    expect(await readdir(wireDir)).toEqual(['universal-streaming-english.jsonl']);
    expect(await readFile(join(wireDir, 'universal-streaming-english.jsonl'), 'utf8')).toBe(
      `${JSON.stringify({ type: 'Turn', transcript: 'Roger takes the meeting notes' })}\n`,
    );
  });

  it('--save-wire fails and writes nothing when the core reported no vendor messages', async () => {
    const { deps: canaryDeps, timers } = deps({
      vendor: {
        onAudio: (stream, endMs) => {
          if (endMs === 3_000) {
            stream.emit({
              type: 'final',
              text: CANARY_REFERENCE,
              startMs: 0,
              endMs,
              confidence: 0.9,
              words: [],
            });
          }
        },
      },
    });

    const result = await timers.settle(runCanary({ saveWireDir: wireDir }, canaryDeps));

    expect(result).toMatchObject({
      passed: false,
      reason: 'the STT core reported no vendor messages, so no wire was saved',
    });
    expect(await readdir(wireDir)).toEqual([]);
  });

  it('--save-wire with the fake provider says there is no wire to save', async () => {
    const { deps: canaryDeps, lines, timers } = deps({ provider: 'fake' });

    await timers.settle(runCanary({ saveWireDir: wireDir }, canaryDeps));

    expect(await readdir(wireDir)).toEqual([]);
    expect(lines).toContain('no vendor wire to save: the fake provider opens no socket');
  });
});
