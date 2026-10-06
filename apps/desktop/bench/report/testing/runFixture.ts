import type { SttEvent } from '../../../src/main/stt/SpeechToText';
import type { AudioSource } from '../../../src/shared/transcript';
import {
  type EventRecord,
  RUN_SCHEMA_VERSION,
  type RunAttempt,
  type RunItemStatus,
  type RunRecord,
} from '../../core/events';
import type { ItemOrigin, ItemSetup } from '../../run/items';
import type { ItemInput } from '../report';

/** Test-only: runs, items and events for `score`, built in memory. */

export const T0 = Date.UTC(2026, 9, 6, 10, 0, 0);

/** A final whose words are spread evenly, `msPerWord` each, from `startMs` (stream time). */
export function finalEvent(text: string, startMs: number, msPerWord = 400): SttEvent {
  const words = text.split(' ').map((word, index) => ({
    text: word,
    startMs: startMs + index * msPerWord,
    endMs: startMs + (index + 1) * msPerWord - 40,
    confidence: 0.9,
  }));
  return {
    type: 'final',
    text,
    startMs,
    endMs: words.at(-1)?.endMs ?? startMs,
    confidence: 0.9,
    words,
  };
}

/** An event that arrived `afterMs` after the replay began. */
export function at(afterMs: number, event: SttEvent, session = 0): EventRecord {
  return { arrivedAtMs: T0 + afterMs, session, event };
}

export interface FixtureItem {
  id: string;
  origin?: ItemOrigin;
  setup?: ItemSetup;
  /** Null: the item has no reference.txt yet. */
  reference?: string | null;
  /** Events of the last attempt per stream; the streams the item has. */
  streams: Partial<Record<AudioSource, EventRecord[]>>;
  /** Default 60 s per stream. */
  audioMs?: number;
  status?: RunItemStatus;
  /** Failed attempts before the last one. */
  failedAttempts?: number;
  pricePerHourUsd?: number | null;
  /** Billed time per session; default the audio plus 1 s. */
  connectedMs?: number;
  /** Left out of the items folder (`forget`). */
  deleted?: boolean;
}

export function runFixture(
  items: readonly FixtureItem[],
  options: { keyterms?: string[]; keytermsOn?: boolean } = {},
): { run: RunRecord; inputs: ItemInput[] } {
  const inputs: ItemInput[] = items.map((fixture) => {
    const sources = (['mic', 'system'] as const).filter(
      (source) => fixture.streams[source] !== undefined,
    );
    const audioMs = fixture.audioMs ?? 60_000;
    const price = fixture.pricePerHourUsd === undefined ? 0.19 : fixture.pricePerHourUsd;
    const lastAttempt: RunAttempt = {
      tokenRequestedAtMs: T0 - 500,
      tokenReceivedAtMs: T0 - 400,
      pricePerHourUsd: price,
      error: fixture.status === 'failed' ? 'system: AssemblyAI: server error (3005)' : null,
      streams: sources.map((source) => ({
        source,
        replayStartedAtMs: T0,
        sessions: [
          {
            cause: 'start' as const,
            itemOffsetMs: 0,
            openedAtMs: T0 - 300,
            readyAtMs: T0,
            closedAtMs: T0 + audioMs + 1_000,
            connectedMs: fixture.connectedMs ?? audioMs + 1_000,
            backlogMs: 0,
          },
        ],
      })),
    };
    const earlier: RunAttempt[] = Array.from({ length: fixture.failedAttempts ?? 0 }, () => ({
      ...lastAttempt,
      error: 'system: AssemblyAI: Too many concurrent sessions (3009)',
      streams: [],
    }));
    return {
      record: {
        itemId: fixture.id,
        status: fixture.status ?? 'ok',
        attempts: [...earlier, lastAttempt],
      },
      item:
        fixture.deleted === true
          ? null
          : {
              id: fixture.id,
              dir: `/bench/items/${fixture.id}`,
              origin: fixture.origin ?? 'backup',
              setup: fixture.setup ?? 'headphones',
              sources,
            },
      reference: fixture.reference ?? null,
      events: new Map(sources.map((source) => [source, fixture.streams[source] ?? []])),
      audioMs: new Map(sources.map((source) => [source, audioMs])),
    };
  });
  const run: RunRecord = {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: '20261006-100000',
    startedAt: new Date(T0 - 1_000).toISOString(),
    finishedAt: new Date(T0 + 600_000).toISOString(),
    provider: 'assemblyai',
    model: 'universal-streaming-english',
    adapterQuery: 'speech_model=universal-streaming-english',
    keyterms: { enabled: options.keytermsOn ?? true, terms: options.keyterms ?? [] },
    normaliserVersion: 1,
    echoFilterVersion: 1,
    gate: false,
    items: inputs.map((input) => input.record),
  };
  return { run, inputs };
}
