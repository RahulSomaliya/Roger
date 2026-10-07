import { readFileSync } from 'node:fs';

/**
 * Test-only: AssemblyAI's wire, one file per model, for the message and adapter tests
 * (messages.test.ts, AssemblyAiSpeechToText.test.ts). `<model>.jsonl` holds the text messages the
 * vendor sent on one stream, in order, one message per line exactly as it arrived; nothing Roger
 * sent, and no audio.
 *
 * Until close step 0 of the M3 plan they are the examples of AssemblyAI's API reference and its
 * message-sequence page (read 2026-10-06). Step 0 replaces them with wire recorded by
 * `make bench ARGS="canary --save-wire <dir>"` (a synthetic voice, nothing private), once per
 * model, and `make check` must stay green on the recording: the tests read these files for
 * properties of the protocol, never for the example's words. A recording that fails them is the
 * signal the plan's risk table names (the wire differs from the docs): fix the adapter against the
 * recording, never the recording.
 */

/** One file per model the API's presets name (`assemblyai`, `assemblyai-pro`). */
export const WIRE_FIXTURE_MODELS = ['universal-streaming-english', 'universal-3-6-pro'] as const;

export type WireFixtureModel = (typeof WIRE_FIXTURE_MODELS)[number];

/** The vendor's messages for one model's stream, in order, blank lines skipped. */
export function readWireFixture(model: WireFixtureModel): string[] {
  const text = readFileSync(new URL(`./${model}.jsonl`, import.meta.url), 'utf8');
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}
