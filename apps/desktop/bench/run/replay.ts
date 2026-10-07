import {
  GATE_MIN_OPEN_MS,
  GATE_TOKEN_MIN_INTERVAL_MS,
  GATE_TOKEN_MIN_LEFT_MS,
  GATE_TOKEN_REFRESH_LEAD_MS,
  type GateChunk,
  SilenceGate,
  type SilenceGateSettings,
} from '../../src/main/capture/SilenceGate';
import { errorMessage } from '../../src/main/logger';
import { UnsupportedSttProviderError } from '../../src/main/stt/createSpeechToText';
import type { SpeechToText, SttEvent, SttStream } from '../../src/main/stt/SpeechToText';
import type { AudioSource } from '../../src/shared/transcript';
import type { EventRecord, RunAttempt, RunSession, RunStream } from '../core/events';
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
 *
 * `--gate` (M3-T20, run F) runs each stream through the app's SilenceGate the way CaptureSession
 * does (GatedStream): a session that heard no speech for the hang-over, and is a minute old,
 * closes; the next speech chunk reopens it through the bench's open budget, with a token fetched
 * while it was closed, sending the pre-roll first. Each reopen is a session of its own in run.json,
 * with the item offset its stream time starts at and the backlog it held at its ready signal.
 */

/** The chunk the app's capture sends, and the replay's step. */
export const REPLAY_CHUNK_MS = 100;
const CHUNK_SAMPLES = (WAV_SAMPLE_RATE * REPLAY_CHUNK_MS) / 1000;

/**
 * `--gate`: the desktop's silence gate settings (costGuards.ts, through RunDeps), the reopen
 * buffer a reopen holds on top of its pre-roll, as CaptureSession.hold does, and when each token
 * stops opening sessions.
 */
export interface ReplayGate extends SilenceGateSettings {
  /** costGuards.sttReopenBufferMs. */
  reopenBufferMs: number;
  /**
   * When `accessToken` stops opening sessions (its `expires_in` from when it arrived; run.ts notes
   * it), or null when unknown, which never runs out. BenchCredentials carries no expiry, and
   * credentials.ts has no later writer (build order section 3.1), hence a lookup.
   */
  tokenExpiresAtMs(accessToken: string): number | null;
}

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
  /** `--gate`: replay through M3-T20's SilenceGate, as CaptureSession runs it; null without. */
  gate: ReplayGate | null;
}

export interface ItemAttempt {
  record: RunAttempt;
  /** Every event of each stream that opened, in arrival order. */
  events: Map<AudioSource, EventRecord[]>;
  /** The connect query the core's wire tap reported, token left out; null without a socket. */
  adapterQuery: string | null;
}

/** One stream to replay: its samples and where they go (an open session, or the gate). */
export interface ReplayFeed {
  samples: Int16Array;
  stream: Pick<SttStream, 'send'>;
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

/** One source's sessions during an attempt: the start's, then any the gate reopened. */
interface SourceRun {
  source: AudioSource;
  sessions: ReplaySession[];
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
  const runs: SourceRun[] = item.sources.map((source) => ({ source, sessions: [], events: [] }));
  const openedAtMs = timers.now();
  const opens = await Promise.allSettled(
    runs.map(async (run) => {
      const session = new ReplaySession(run, run.source, 'start', 0, openedAtMs);
      run.sessions.push(session);
      await session.open(stt, credentials, timers, outcome);
    }),
  );
  opens.forEach((open, index) => {
    if (open.status === 'rejected') {
      outcome.fail(`${runs[index]?.source ?? 'stream'}: ${errorMessage(open.reason)}`);
    }
  });

  const replayStartedAtMs = timers.now();
  const gated =
    input.gate === null
      ? null
      : new GateRun(input.gate, {
          stt,
          credentials: input.credentials,
          opener: input.opener,
          timers,
          signal,
          outcome,
        });
  if (outcome.failure === null && !signal.aborted && !wire.leakedToken) {
    const feeds = runs.flatMap((run) => {
      const samples = input.audio.get(run.source);
      const stream = run.sessions[0]?.stream ?? null;
      if (stream === null || samples === undefined) return [];
      return [{ samples, stream: gated === null ? stream : gated.stream(run) }];
    });
    await replayAtRealTime(
      feeds,
      timers,
      replayStartedAtMs,
      () => outcome.failure !== null || signal.aborted || gated?.stopped != null,
    );
    // A gate reopen still on its way opens first: closed below with the rest, it cannot outlive
    // the attempt, and the speech it holds is sent as the app would send it.
    await gated?.settled();
  }

  outcome.closing = true;
  await Promise.all(
    runs.flatMap((run) => run.sessions.map((session) => session.close(timers, outcome))),
  );
  if (gated?.stopped != null) throw gated.stopped;
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
    // Each session opened under its own label (the source, then `mic#1`, ...): the adapter meters
    // by label, so each one's billed time is its own, even when a gate close was still finishing
    // as the next session opened.
    sessions: run.sessions.map((session) => ({
      ...session.record,
      connectedMs: stt.usage(session.label).connectedMs,
    })),
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
 * are one failure), and events after the bench began closing end nothing. `ended` aborts at the
 * first failure, so a gate reopen waiting for an open slot gives up instead of opening a session
 * nobody will replay.
 */
class AttemptOutcome {
  failure: string | null = null;
  closing = false;
  readonly ended = new AbortController();

  fail(message: string): void {
    this.failure ??= message;
    this.ended.abort(message);
  }
}

/** One vendor session of a stream: the start's, or one the gate reopened. */
class ReplaySession {
  stream: SttStream | null = null;
  readonly record: Omit<RunSession, 'connectedMs'>;
  /** Its index in its stream's sessions: what each of its events names. */
  private readonly index: number;
  /** The bench asked it to close: its own "closed" is then no failure. */
  private closeAsked = false;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly run: SourceRun,
    /** Its OpenStreamOptions label, by which the adapter meters it. */
    readonly label: string,
    cause: RunSession['cause'],
    itemOffsetMs: number,
    openedAtMs: number,
  ) {
    this.index = run.sessions.length;
    this.record = {
      cause,
      itemOffsetMs,
      openedAtMs,
      readyAtMs: null,
      closedAtMs: null,
      backlogMs: 0,
    };
  }

  async open(
    stt: SpeechToText,
    credentials: BenchCredentials,
    timers: BenchTimers,
    outcome: AttemptOutcome,
  ): Promise<SttStream> {
    const stream = await stt.openStream({
      accessToken: credentials.accessToken,
      settings: credentials.settings,
      label: this.label,
    });
    this.stream = stream;
    this.record.readyAtMs = timers.now();
    // Listened to as soon as it is ready, not once both are: the other stream may still be
    // connecting, and a fatal error in between would go unseen and score an empty stream.
    stream.on((event) => {
      this.run.events.push({ arrivedAtMs: timers.now(), session: this.index, event });
      if (outcome.closing || this.closeAsked) return;
      const ended = endOfSession(event);
      if (ended !== null) outcome.fail(`${this.run.source}: ${ended}`);
    });
    return stream;
  }

  /** Closes it once, its finish included: a gate close and the attempt's end share one close. */
  close(timers: BenchTimers, outcome: AttemptOutcome): Promise<void> {
    // Before the close: a vendor may send its "closed" from inside close().
    this.closeAsked = true;
    this.closing ??= this.finish(timers, outcome);
    return this.closing;
  }

  private async finish(timers: BenchTimers, outcome: AttemptOutcome): Promise<void> {
    try {
      await this.stream?.close();
    } catch (error) {
      outcome.fail(`${this.run.source}: close failed: ${errorMessage(error)}`);
    }
    this.record.closedAtMs = timers.now();
  }
}

interface GateDeps {
  stt: SpeechToText;
  credentials: BenchCredentialSource;
  opener: BenchOpener;
  timers: BenchTimers;
  signal: AbortSignal;
  outcome: AttemptOutcome;
}

/**
 * The silence gate over one attempt's streams, as one meeting's (CaptureSession): its own reopen
 * count, both sources together, each close taking the reopen it will need; and one token fetched
 * while any stream is closed, kept fresh, that both reopen with (as at Start). The rules are the
 * app's own (SilenceGate.ts), so run F measures what the app does.
 */
class GateRun {
  /** A RunStoppedError met by a token fetch (the API changed vendor): the run stops on it. */
  stopped: RunStoppedError | null = null;
  private closes = 0;
  private token: BenchCredentials | null = null;
  private prefetching: Promise<BenchCredentials | null> | null = null;
  private prefetchNotBeforeMs = 0;
  private readonly streams: GatedStream[] = [];
  private readonly reopens = new Set<Promise<void>>();

  constructor(
    readonly settings: ReplayGate,
    readonly deps: GateDeps,
  ) {}

  /** `run`'s samples go through this, not straight to its start session. */
  stream(run: SourceRun): GatedStream {
    const stream = new GatedStream(run, this);
    this.streams.push(stream);
    return stream;
  }

  /** Takes one of the gate's reopens for a close; false once they are spent (the gate is off). */
  takeClose(): boolean {
    if (this.closes >= this.settings.reopensPerMeeting) return false;
    this.closes += 1;
    return true;
  }

  /** Every reopen is waited for before the attempt closes its sessions (settled). */
  track(reopen: Promise<void>): void {
    this.reopens.add(reopen);
    void reopen.finally(() => {
      this.reopens.delete(reopen);
    });
  }

  async settled(): Promise<void> {
    while (this.reopens.size > 0) await Promise.all([...this.reopens]);
  }

  /**
   * As CaptureSession.keepTokenFresh: fetched at a close and GATE_TOKEN_REFRESH_LEAD_MS before it
   * expires while any stream is closed, at most every GATE_TOKEN_MIN_INTERVAL_MS. A failed fetch
   * is left for the reopen, which fetches at the onset as the app does: its wait then shows in that
   * reopen's backlog in run.json. A token every later item would fail on stops the run.
   */
  keepTokenFresh(): void {
    if (this.prefetching !== null || this.deps.signal.aborted || this.stopped !== null) return;
    if (!this.streams.some((stream) => stream.gated)) return;
    const now = this.deps.timers.now();
    if (now < this.prefetchNotBeforeMs) return;
    if (this.token !== null && this.leftMs(this.token) > GATE_TOKEN_REFRESH_LEAD_MS) return;
    this.prefetchNotBeforeMs = now + GATE_TOKEN_MIN_INTERVAL_MS;
    const fetching = this.deps.credentials.fetch().then(
      (credentials) => {
        this.token = credentials;
        return credentials;
      },
      (error: unknown) => {
        if (error instanceof RunStoppedError) this.stopped ??= error;
        return null;
      },
    );
    this.prefetching = fetching;
    void fetching.finally(() => {
      if (this.prefetching === fetching) this.prefetching = null;
    });
  }

  /** The prefetched token while it has GATE_TOKEN_MIN_LEFT_MS left, else a fetch now. */
  async reopenToken(): Promise<BenchCredentials> {
    const fetched = this.prefetching === null ? null : await this.prefetching;
    const token = fetched ?? this.token;
    if (token !== null && this.leftMs(token) >= GATE_TOKEN_MIN_LEFT_MS) return token;
    return this.deps.credentials.fetch();
  }

  private leftMs(token: BenchCredentials): number {
    const expiresAtMs = this.settings.tokenExpiresAtMs(token.accessToken);
    return expiresAtMs === null ? Number.POSITIVE_INFINITY : expiresAtMs - this.deps.timers.now();
  }
}

/**
 * One stream through the gate, fed at 1x by replayAtRealTime: open, it passes each chunk to its
 * session and closes it once the gate says so and the session is GATE_MIN_OPEN_MS old; gated, the
 * gate keeps the pre-roll and the first speech chunk starts a reopen; connecting, it holds the
 * pre-roll plus reopenBufferMs, as CaptureSession.hold does for a gate reopen, and the reopened
 * session gets all of it at its ready signal (its backlog), paced by the core.
 */
class GatedStream implements Pick<SttStream, 'send'> {
  private readonly gate: SilenceGate;
  private state: 'open' | 'gated' | 'connecting' = 'open';
  private current: ReplaySession | null;
  private held: GateChunk[] = [];
  private heldMs = 0;
  /** Samples handed so far: the item time of the next chunk. */
  private handed = 0;

  constructor(
    private readonly run: SourceRun,
    private readonly shared: GateRun,
  ) {
    const { closeAfterMs, preRollMs } = shared.settings;
    this.gate = new SilenceGate({ closeAfterMs, preRollMs, sampleRate: WAV_SAMPLE_RATE });
    this.current = run.sessions[0] ?? null;
  }

  get gated(): boolean {
    return this.state === 'gated';
  }

  send(pcm: Uint8Array): void {
    // Item time of the chunk's first sample: the gate keeps chunks by it, the pre-roll included.
    const itemMs = (this.handed / WAV_SAMPLE_RATE) * 1000;
    this.handed += pcm.byteLength / 2;
    const heard = this.gate.hear(pcm, itemMs);
    switch (this.state) {
      case 'open':
        this.current?.stream?.send(pcm);
        this.closeIfSilent();
        return;
      case 'gated':
        if (!heard.speech) {
          this.shared.keepTokenFresh();
          return;
        }
        this.state = 'connecting';
        for (const chunk of this.gate.open().preRoll) this.hold(chunk);
        this.hold({ pcm, capturedAtMs: itemMs });
        this.shared.track(this.reopen());
        return;
      case 'connecting':
        this.hold({ pcm, capturedAtMs: itemMs });
        return;
    }
  }

  private closeIfSilent(): void {
    const session = this.current;
    const readyAtMs = session?.record.readyAtMs ?? null;
    if (session === null || readyAtMs === null || !this.gate.shouldClose) return;
    const { timers, outcome } = this.shared.deps;
    if (timers.now() - readyAtMs < GATE_MIN_OPEN_MS || !this.shared.takeClose()) return;
    this.current = null;
    this.state = 'gated';
    this.gate.close();
    void session.close(timers, outcome);
    this.shared.keepTokenFresh();
  }

  private hold(chunk: GateChunk): void {
    const { preRollMs, reopenBufferMs } = this.shared.settings;
    this.held.push(chunk);
    this.heldMs += chunkMs(chunk.pcm);
    while (this.heldMs > preRollMs + reopenBufferMs && this.held.length > 1) {
      const oldest = this.held.shift();
      if (oldest === undefined) break;
      this.heldMs -= chunkMs(oldest.pcm);
    }
  }

  /** Never rejects: a failed reopen fails the attempt, which is retried with a fresh token. */
  private async reopen(): Promise<void> {
    const { stt, opener, timers, signal, outcome } = this.shared.deps;
    const index = this.run.sessions.length;
    try {
      // Through the bench's open budget like every open (CLAUDE.md, rule 9), the token taken
      // in its turn: the prefetched one, or a fetch when it ran out.
      const credentials = await opener.reserve(
        1,
        () => this.shared.reopenToken(),
        AbortSignal.any([signal, outcome.ended.signal]),
      );
      if (outcome.failure !== null || signal.aborted) return;
      const session = new ReplaySession(
        this.run,
        `${this.run.source}#${index}`,
        'gate',
        this.held[0]?.capturedAtMs ?? 0,
        timers.now(),
      );
      this.run.sessions.push(session);
      const stream = await session.open(stt, credentials, timers, outcome);
      // Its stream time 0 is the first chunk it is sent: the bound may have cut the pre-roll's
      // start while it connected.
      session.record.itemOffsetMs = this.held[0]?.capturedAtMs ?? session.record.itemOffsetMs;
      session.record.backlogMs = this.heldMs;
      for (const chunk of this.held) stream.send(chunk.pcm);
      this.held = [];
      this.heldMs = 0;
      this.current = session;
      this.state = 'open';
    } catch (error) {
      if (error instanceof RunStoppedError) {
        this.shared.stopped ??= error;
        return;
      }
      // The attempt failed or the run stopped while it waited for a slot: that is the reason.
      if (outcome.failure !== null || signal.aborted) return;
      outcome.fail(`${this.run.source}: gate reopen failed: ${errorMessage(error)}`);
    }
  }
}

function chunkMs(pcm: Uint8Array): number {
  return (pcm.byteLength / 2 / WAV_SAMPLE_RATE) * 1000;
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
