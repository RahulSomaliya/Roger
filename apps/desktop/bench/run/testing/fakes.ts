import type { SttTokenApi, SttTokenResponse } from '../../../src/main/api/ApiClient';
import {
  type OpenStreamOptions,
  type SpeechToText,
  SttConnectError,
  type SttCredentialUse,
  SttEventEmitter,
  type SttEventListener,
  type SttStream,
} from '../../../src/main/stt/SpeechToText';
import { type SessionUsage, sumUsage, type SttUsage } from '../../../src/main/stt/usage';
import type { BenchAdapterFactory, BenchWireTap } from '../adapters';
import type { BenchTimers } from '../timers';

/**
 * Test-only doubles for the bench: a token API and a vendor adapter that never touch the network,
 * on the bench's injected clock, so every test of the runner and the canary runs offline.
 */

export interface TokenOptions {
  provider?: string;
  model?: string;
  token?: string;
  sampleRate?: number;
  /** Undefined: the field is left out, as an API older than the price sends it. */
  pricePerHourUsd?: number | null;
  keyterms?: string[];
}

export function tokenResponse(options: TokenOptions = {}): SttTokenResponse {
  const stream: SttTokenResponse['stream'] = {
    model: options.model ?? 'universal-streaming-english',
    language: 'en',
    sample_rate: options.sampleRate ?? 16_000,
    encoding: 'linear16',
    keyterms: options.keyterms ?? ['Linkt', 'Roger'],
  };
  if (options.pricePerHourUsd !== undefined) stream.price_per_hour_usd = options.pricePerHourUsd;
  return {
    provider: options.provider ?? 'assemblyai',
    access_token: options.token ?? 'tok-1',
    expires_in: 30,
    stream,
  };
}

/** A token API that answers each call with the next scripted response; the last one repeats. */
export class ScriptedTokenApi implements SttTokenApi {
  calls = 0;
  private readonly responses: (SttTokenResponse | Error | ((call: number) => SttTokenResponse))[];

  constructor(...responses: (SttTokenResponse | Error | ((call: number) => SttTokenResponse))[]) {
    this.responses = responses;
  }

  getSttToken(): Promise<SttTokenResponse> {
    const call = this.calls;
    this.calls += 1;
    const response = this.responses[Math.min(call, this.responses.length - 1)];
    if (response === undefined) return Promise.reject(new Error('no token response scripted'));
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(typeof response === 'function' ? response(call) : response);
  }
}

/** A fresh token per call: tok-1, tok-2, ... */
export function freshTokens(options: TokenOptions = {}): (call: number) => SttTokenResponse {
  return (call) => tokenResponse({ ...options, token: `tok-${call + 1}` });
}

export interface FakeVendorScript {
  /** Called at each openStream; throw to refuse the connect (a 3009, a 400). */
  onOpen?: (options: OpenStreamOptions, openIndex: number) => void;
  /** Ms the connect takes on the manual clock. */
  connectMs?: number;
  /**
   * Called with each chunk a stream receives and the stream time in ms at the chunk's end; it may
   * answer at once with `stream.emit(...)`.
   */
  onAudio?: (stream: FakeVendorStream, chunkEndMs: number) => void;
  /** Wire records to hand the tap at each connect (the core's `connect` record). */
  connectQuery?: (options: OpenStreamOptions) => string | null;
  /**
   * What one token may open; default `reusable`. As `single-connection` it plays xAI: an open
   * with a token an earlier open used is refused with HTTP 401 (the 2026-10-08 probe).
   */
  credentialUse?: SttCredentialUse;
}

/** One stream of FakeVendor: records what it was sent, emits what the test says. */
export class FakeVendorStream implements SttStream {
  readonly sentAtMs: number[] = [];
  sentBytes = 0;
  closed = false;
  private readonly emitter = new SttEventEmitter();
  private readonly openedAtMs: number;
  private closedAtMs: number | null = null;

  constructor(
    readonly options: OpenStreamOptions,
    private readonly timers: BenchTimers,
    private readonly script: FakeVendorScript,
    private readonly wireTap: BenchWireTap,
  ) {
    this.openedAtMs = timers.now();
  }

  get label(): string {
    return this.options.label;
  }

  send(pcm: Uint8Array): void {
    if (this.closed) return;
    this.sentAtMs.push(this.timers.now());
    this.sentBytes += pcm.byteLength;
    this.script.onAudio?.(this, (this.sentBytes / 2 / 16_000) * 1000);
  }

  emit(...events: Parameters<SttEventListener>): void {
    for (const event of events) this.emitter.emit(event);
  }

  /** A text message from the vendor, as the core's wire tap reports it. */
  receive(text: string): void {
    this.wireTap({ kind: 'text', label: this.label, direction: 'received', text });
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.closedAtMs = this.timers.now();
      this.emitter.emit({ type: 'closed', code: 1000, reason: null });
    }
    return Promise.resolve();
  }

  on(listener: SttEventListener): () => void {
    return this.emitter.on(listener);
  }

  usage(): SessionUsage {
    return {
      opened: true,
      connectedMs: (this.closedAtMs ?? this.timers.now()) - this.openedAtMs,
      audioSentMs: (this.sentBytes / 2 / 16_000) * 1000,
      droppedChunks: 0,
      pricePerHourUsd: this.options.settings.pricePerHourUsd,
    };
  }
}

/** Builds adapters that record every stream they open, for the bench's adapter factory. */
export class FakeVendor {
  readonly streams: FakeVendorStream[] = [];
  readonly providers: string[] = [];
  opens = 0;
  private readonly tokensUsed = new Set<string>();

  constructor(
    private readonly timers: BenchTimers,
    private readonly script: FakeVendorScript = {},
  ) {}

  readonly adapters: BenchAdapterFactory = (provider, wireTap) => {
    this.providers.push(provider);
    return this.adapter(provider, wireTap);
  };

  private adapter(provider: string, wireTap: BenchWireTap): SpeechToText {
    const opened: FakeVendorStream[] = [];
    const credentialUse = this.script.credentialUse ?? 'reusable';
    return {
      provider,
      vendorName: 'Fake vendor',
      credentialUse,
      openStream: async (options) => {
        const index = this.opens;
        this.opens += 1;
        const spent = this.tokensUsed.has(options.accessToken);
        this.tokensUsed.add(options.accessToken);
        if (spent && credentialUse === 'single-connection') {
          throw new SttConnectError('Fake vendor: rejected with HTTP 401', 401);
        }
        const query = this.script.connectQuery?.(options) ?? null;
        if (query !== null) wireTap({ kind: 'connect', label: options.label, query });
        if (this.script.connectMs !== undefined) await this.timers.sleep(this.script.connectMs);
        this.script.onOpen?.(options, index);
        const stream = new FakeVendorStream(options, this.timers, this.script, wireTap);
        opened.push(stream);
        this.streams.push(stream);
        return stream;
      },
      usage: (label): SttUsage =>
        sumUsage(
          opened
            .filter((stream) => label === undefined || stream.label === label)
            .map((stream) => stream.usage()),
        ),
    };
  }
}
