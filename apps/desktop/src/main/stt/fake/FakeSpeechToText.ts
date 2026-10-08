import { pcmBytesToMs, rmsInt16 } from '../../../shared/pcm';
import {
  type OpenStreamOptions,
  type SpeechToText,
  SttEventEmitter,
  type SttEventListener,
  type SttStream,
} from '../SpeechToText';
import { type SessionUsage, sumUsage, type SttUsage } from '../usage';

export interface FakeSttOptions {
  /** Audio per emitted line. Timing comes from the audio itself, so tests are deterministic. */
  windowMs?: number;
  /** Below this RMS (0..1) a window counts as silence and produces no line. */
  silenceRms?: number;
  clock?: () => number;
}

/**
 * A vendor-free adapter for development and tests. It "transcribes" audio energy: every window of
 * audio that is not silent becomes one final line saying how loud it was. This exercises the whole
 * pipeline (worklet → IPC → session → SQLite → uploader → API → MCP) without a vendor key.
 * It takes the jargon list like any vendor and ignores it: it hears no words to spell, and it never
 * refuses one, so it never fails a connect with SttConnectError.keytermsRejected.
 */
export class FakeSpeechToText implements SpeechToText {
  readonly provider = 'fake';
  readonly vendorName = 'Fake';
  /** Its empty token opens anything: one token at Start serves both sources, as for AssemblyAI. */
  readonly credentialUse = 'reusable';
  private readonly streams: FakeStream[] = [];
  private readonly clock: () => number;

  constructor(private readonly options: FakeSttOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
  }

  openStream(options: OpenStreamOptions): Promise<SttStream> {
    const stream = new FakeStream(
      options,
      this.options.windowMs ?? 2_000,
      this.options.silenceRms ?? 0.01,
      this.clock,
    );
    this.streams.push(stream);
    return Promise.resolve(stream);
  }

  /** Metered like a vendor, so the status line and cost guards behave the same in development. */
  usage(label?: string): SttUsage {
    return sumUsage(
      this.streams
        .filter((stream) => label === undefined || stream.label === label)
        .map((stream) => stream.usage()),
    );
  }
}

class FakeStream implements SttStream {
  readonly label: string;
  private readonly emitter = new SttEventEmitter();
  private readonly sampleRate: number;
  private readonly pricePerHourUsd: number | null;
  private readonly windowSamples: number;
  private readonly openedAtMs: number;
  private closedAtMs: number | null = null;
  private sentBytes = 0;
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private consumedSamples = 0;
  private closed = false;

  constructor(
    options: OpenStreamOptions,
    windowMs: number,
    private readonly silenceRms: number,
    private readonly clock: () => number,
  ) {
    this.label = options.label;
    this.sampleRate = options.settings.sampleRate;
    this.pricePerHourUsd = options.settings.pricePerHourUsd;
    this.windowSamples = Math.round((this.sampleRate * windowMs) / 1000);
    this.openedAtMs = clock();
  }

  usage(): SessionUsage {
    return {
      opened: true,
      connectedMs: (this.closedAtMs ?? this.clock()) - this.openedAtMs,
      audioSentMs: pcmBytesToMs(this.sentBytes, this.sampleRate),
      droppedChunks: 0,
      pricePerHourUsd: this.pricePerHourUsd,
    };
  }

  send(pcm: Uint8Array): void {
    if (this.closed) return;
    this.sentBytes += pcm.byteLength;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    this.pending.push(samples);
    this.pendingSamples += samples.length;
    while (this.pendingSamples >= this.windowSamples) this.flushWindow(this.windowSamples);
  }

  close(): Promise<void> {
    if (!this.closed) {
      if (this.pendingSamples > 0) this.flushWindow(this.pendingSamples);
      this.closed = true;
      this.closedAtMs = this.clock();
      this.emitter.emit({ type: 'closed', code: null, reason: null });
    }
    return Promise.resolve();
  }

  on(listener: SttEventListener): () => void {
    return this.emitter.on(listener);
  }

  private flushWindow(count: number): void {
    const window = new Int16Array(count);
    let filled = 0;
    while (filled < count) {
      const chunk = this.pending[0];
      if (!chunk) break;
      const take = Math.min(chunk.length, count - filled);
      window.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take === chunk.length) this.pending.shift();
      else this.pending[0] = chunk.subarray(take);
    }
    this.pendingSamples -= filled;
    const startMs = Math.round((this.consumedSamples / this.sampleRate) * 1000);
    this.consumedSamples += filled;
    const endMs = Math.round((this.consumedSamples / this.sampleRate) * 1000);
    const level = rmsInt16(window);
    if (level < this.silenceRms) return;
    const seconds = ((endMs - startMs) / 1000).toFixed(1);
    this.emitter.emit({
      type: 'final',
      text: `(fake transcript) heard ${seconds}s of audio at level ${level.toFixed(2)}`,
      startMs,
      endMs,
      confidence: 1,
      words: [],
    });
  }
}
