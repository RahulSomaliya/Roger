import { errorMessage } from '../../src/main/logger';
import { UnsupportedSttProviderError } from '../../src/main/stt/createSpeechToText';
import type { SpeechToText, SttEvent, SttStream } from '../../src/main/stt/SpeechToText';
import type { AudioSource } from '../../src/shared/transcript';
import type { EventRecord, RunAttempt, RunStream } from '../core/events';
import { WAV_SAMPLE_RATE } from '../core/wav';
import type { BenchAdapterFactory, BenchWireTap } from './adapters';
import { type BenchCredentialSource, type BenchCredentials, RunStoppedError } from './credentials';
import type { BenchItem } from './items';
import type { BenchOpener } from './opens';
import type { BenchTimers } from './timers';

/**
 * One attempt at one item: a fresh token, both streams opened through the bench's open budget, the
 * item's WAV files fed to them at real time, every event kept with its arrival time, both closed
 * (M3 design, "Benchmark replay"). Live accuracy and lag are what a person sees, so the audio goes
 * out as the app's capture would send it: 100 ms chunks, each once its last sample would have been
 * captured, both streams on one schedule. Faster than real time would also draw AssemblyAI's 3007
 * close; the core paces what it is handed (M3-T18) and this schedule never hands it more.
 *
 * The capture clock of every word is `replayStartedAtMs` plus its item offset (RunStream), on the
 * same clock as each event's arrival, so `score` measures word latency with the app's LatencyMeter.
 */

/** The chunk the app's capture sends, and the replay's step. */
export const REPLAY_CHUNK_MS = 100;
const CHUNK_SAMPLES = (WAV_SAMPLE_RATE * REPLAY_CHUNK_MS) / 1000;

export interface ItemAttemptInput {
  item: BenchItem;
  /** The samples of each of the item's streams (16 kHz mono PCM16). */
  audio: ReadonlyMap<AudioSource, Int16Array>;
  credentials: BenchCredentialSource;
  opener: BenchOpener;
  adapters: BenchAdapterFactory;
  timers: BenchTimers;
  /**
   * Aborted when the run stops. An attempt still waiting for open slots or for its token opens
   * nothing (each open is a billed handshake) and rejects; one already open ends early, closes its
   * sessions and says why.
   */
  signal: AbortSignal;
}

export interface ItemAttempt {
  record: RunAttempt;
  /** Every event of each stream that opened, in arrival order. */
  events: Map<AudioSource, EventRecord[]>;
  /** The connect query the core's wire tap reported, token left out; null without a socket. */
  adapterQuery: string | null;
}

/** One stream to replay: its samples and the open session they go to. */
export interface ReplayFeed {
  samples: Int16Array;
  stream: SttStream;
}

/**
 * Hands every feed its samples at 1x from `startedAtMs`: chunk k once item time (k+1) x 100 ms has
 * passed (a short last chunk at its own end), every feed on the one schedule, the wait measured
 * from the clock each time so the schedule never drifts. Stops early once `shouldStop` says so.
 */
export async function replayAtRealTime(
  feeds: readonly ReplayFeed[],
  timers: BenchTimers,
  startedAtMs: number,
  shouldStop: () => boolean,
): Promise<void> {
  const longest = Math.max(0, ...feeds.map((feed) => feed.samples.length));
  for (let from = 0; from < longest; from += CHUNK_SAMPLES) {
    const to = Math.min(from + CHUNK_SAMPLES, longest);
    const dueAtMs = startedAtMs + (to / WAV_SAMPLE_RATE) * 1000;
    const waitMs = dueAtMs - timers.now();
    if (waitMs > 0) await timers.sleep(waitMs);
    if (shouldStop()) return;
    for (const feed of feeds) {
      if (from >= feed.samples.length) continue;
      const chunk = feed.samples.subarray(from, to);
      // The samples' own bytes: Int16Array is host-endian, and every Mac Roger runs on is
      // little-endian, the PCM16 the vendors are told (`linear16`).
      feed.stream.send(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
  }
}

/** One source's session during an attempt. */
interface SourceRun {
  source: AudioSource;
  stream: SttStream | null;
  readyAtMs: number | null;
  closedAtMs: number | null;
  events: EventRecord[];
}

/**
 * Runs one attempt. Resolves with the attempt's record, failed or not (a failure is retried by the
 * caller with a fresh token); rejects with RunStoppedError for a problem every item would hit, and
 * when the run stopped before the attempt opened anything (there is then nothing to record).
 */
export async function replayItemAttempt(input: ItemAttemptInput): Promise<ItemAttempt> {
  const { item, timers, signal } = input;
  // For a failed attempt's record: set inside the open budget's turn, read when it throws.
  const times: { requestedAtMs: number | null; receivedAtMs: number | null } = {
    requestedAtMs: null,
    receivedAtMs: null,
  };
  let prepared: {
    credentials: BenchCredentials;
    stt: SpeechToText;
    wire: ConnectQueries;
    requestedAtMs: number;
    receivedAtMs: number;
  };
  try {
    prepared = await input.opener.reserve(
      item.sources.length,
      async () => {
        const requestedAtMs = timers.now();
        times.requestedAtMs = requestedAtMs;
        const credentials = await input.credentials.fetch();
        const receivedAtMs = timers.now();
        times.receivedAtMs = receivedAtMs;
        const wire = new ConnectQueries(credentials.accessToken);
        const stt = adapterFor(input.adapters, credentials.provider, wire.tap);
        return { credentials, stt, wire, requestedAtMs, receivedAtMs };
      },
      signal,
    );
  } catch (error) {
    if (error instanceof RunStoppedError) throw error;
    if (times.requestedAtMs === null) {
      // No token was asked for: the run stopped while the item waited for open slots, or the open
      // budget refused, which every item would hit too.
      throw new RunStoppedError(signal.aborted ? stoppedBy(signal) : errorMessage(error));
    }
    // The token came, so the failure is not the API's: a bug, which must not pass for a retry.
    if (times.receivedAtMs !== null) throw error;
    return {
      record: {
        tokenRequestedAtMs: times.requestedAtMs,
        tokenReceivedAtMs: times.receivedAtMs,
        pricePerHourUsd: null,
        error: `token request failed: ${errorMessage(error)}`,
        streams: [],
      },
      events: new Map(),
      adapterQuery: null,
    };
  }
  // The run stopped while the token was on its way. Nothing opens: each open is a billed handshake,
  // and an item that never replayed is left out of run.json. The check before the replay below
  // comes too late for this: by then both sessions are open.
  throwIfStopped(signal);
  const { credentials, stt, wire } = prepared;

  const outcome = new AttemptOutcome();
  const runs: SourceRun[] = item.sources.map((source) => ({
    source,
    stream: null,
    readyAtMs: null,
    closedAtMs: null,
    events: [],
  }));
  const openedAtMs = timers.now();
  const opens = await Promise.allSettled(
    runs.map(async (run) => {
      const stream = await stt.openStream({
        accessToken: credentials.accessToken,
        settings: credentials.settings,
        label: run.source,
      });
      run.stream = stream;
      run.readyAtMs = timers.now();
      // Listened to as soon as it is ready, not once both are: the other stream may still be
      // connecting, and a fatal error in between would go unseen and score an empty stream.
      stream.on((event) => {
        run.events.push({ arrivedAtMs: timers.now(), session: 0, event });
        if (outcome.closing) return;
        const ended = endOfSession(event);
        if (ended !== null) outcome.fail(`${run.source}: ${ended}`);
      });
    }),
  );
  opens.forEach((open, index) => {
    if (open.status === 'rejected') {
      outcome.fail(`${runs[index]?.source ?? 'stream'}: ${errorMessage(open.reason)}`);
    }
  });

  const replayStartedAtMs = timers.now();
  if (outcome.failure === null && !signal.aborted && !wire.leakedToken) {
    const feeds = runs.flatMap((run) => {
      const samples = input.audio.get(run.source);
      return run.stream === null || samples === undefined ? [] : [{ samples, stream: run.stream }];
    });
    await replayAtRealTime(
      feeds,
      timers,
      replayStartedAtMs,
      () => outcome.failure !== null || signal.aborted,
    );
  }

  outcome.closing = true;
  await Promise.all(
    runs.map(async (run) => {
      try {
        await run.stream?.close();
      } catch (error) {
        outcome.fail(`${run.source}: close failed: ${errorMessage(error)}`);
      }
      run.closedAtMs = timers.now();
    }),
  );
  if (wire.leakedToken) {
    // Never written anywhere: run.json would publish a live credential with the run.
    throw new RunStoppedError(
      "the core's wire tap gave a connect query that holds the access token; nothing of it was " +
        'stored. Fix queryWithoutToken in src/main/stt/core/SttConnection.ts before any run.',
    );
  }
  if (signal.aborted) outcome.fail(stoppedBy(signal));

  const streams: RunStream[] = runs.map((run) => ({
    source: run.source,
    // When the attempt failed at the connect no audio went out; time 0 is then when it noticed.
    replayStartedAtMs,
    sessions: [
      {
        cause: 'start',
        itemOffsetMs: 0,
        openedAtMs,
        readyAtMs: run.readyAtMs,
        closedAtMs: run.closedAtMs,
        connectedMs: stt.usage(run.source).connectedMs,
        backlogMs: 0,
      },
    ],
  }));
  return {
    record: {
      tokenRequestedAtMs: prepared.requestedAtMs,
      tokenReceivedAtMs: prepared.receivedAtMs,
      pricePerHourUsd: credentials.settings.pricePerHourUsd,
      error: outcome.failure,
      streams,
    },
    events: new Map(runs.map((run) => [run.source, run.events])),
    adapterQuery: wire.query,
  };
}

/**
 * How an attempt is going: the first failure wins (a vendor's error frame and the close after it
 * are one failure), and events after the bench began closing end nothing.
 */
class AttemptOutcome {
  failure: string | null = null;
  closing = false;

  fail(message: string): void {
    this.failure ??= message;
  }
}

/** The adapter for the token's provider; one the desktop does not have stops the run. */
function adapterFor(
  adapters: BenchAdapterFactory,
  provider: string,
  wireTap: BenchWireTap,
): SpeechToText {
  try {
    return adapters(provider, wireTap);
  } catch (error) {
    if (error instanceof UnsupportedSttProviderError) throw new RunStoppedError(error.message);
    throw error;
  }
}

/** Why an event ends the session before the bench closed it, or null when it does not. */
function endOfSession(event: SttEvent): string | null {
  if (event.type === 'error' && event.fatal) return event.message;
  if (event.type !== 'closed') return null;
  const parts = [event.code === null ? 'no code' : `code ${event.code}`];
  if (event.reason !== null) parts.push(event.reason);
  return `the vendor closed the session (${parts.join(', ')})`;
}

/**
 * A function, not `if (signal.aborted) throw` inline: TypeScript would keep that narrowing past
 * every later await, and lint would then call the checks after the opens and the replay (where the
 * signal may well have aborted) always true or always false.
 */
function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new RunStoppedError(stoppedBy(signal));
}

/** `run stopped: <why>`, from the reason the run aborted its signal with. */
function stoppedBy(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  return `run stopped: ${typeof reason === 'string' ? reason : errorMessage(reason)}`;
}

/**
 * Keeps the first connect query the wire tap reports, for run.json. The core leaves the token out
 * (M3-T5); a query that still holds it is refused here too, raw or percent-encoded, because run.json
 * is a file the owner shares numbers from.
 */
class ConnectQueries {
  query: string | null = null;
  leakedToken = false;

  constructor(private readonly accessToken: string) {}

  readonly tap: BenchWireTap = (record) => {
    if (record.kind !== 'connect' || typeof record.query !== 'string') return;
    if (this.holdsToken(record.query)) {
      this.leakedToken = true;
      return;
    }
    this.query ??= record.query;
  };

  private holdsToken(query: string): boolean {
    if (this.accessToken === '') return false;
    if (query.includes(this.accessToken)) return true;
    try {
      return decodeURIComponent(query.replaceAll('+', ' ')).includes(this.accessToken);
    } catch {
      // Not valid percent-encoding, so it cannot be checked for the token: never stored.
      return true;
    }
  }
}
