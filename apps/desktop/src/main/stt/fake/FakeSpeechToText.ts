import { rmsInt16 } from '../../../shared/pcm';
import {
  type OpenStreamOptions,
  type SpeechToText,
  SttEventEmitter,
  type SttEventListener,
  type SttStream,
} from '../SpeechToText';

export interface FakeSttOptions {
  /** Audio per emitted line. Timing comes from the audio itself, so tests are deterministic. */
  windowMs?: number;
  /** Below this RMS (0..1) a window counts as silence and produces no line. */
  silenceRms?: number;
}

/**
 * A vendor-free adapter for development and tests. It "transcribes" audio energy: every window of
 * audio that is not silent becomes one final line saying how loud it was. This exercises the whole
 * pipeline (worklet → IPC → session → SQLite → uploader → API → MCP) without a vendor key.
 */
export class FakeSpeechToText implements SpeechToText {
  readonly provider = 'fake';

  constructor(private readonly options: FakeSttOptions = {}) {}

  openStream(options: OpenStreamOptions): Promise<SttStream> {
    return Promise.resolve(
      new FakeStream(
        options.settings.sampleRate,
        this.options.windowMs ?? 2_000,
        this.options.silenceRms ?? 0.01,
      ),
    );
  }
}

class FakeStream implements SttStream {
  private readonly emitter = new SttEventEmitter();
  private readonly windowSamples: number;
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private consumedSamples = 0;
  private closed = false;

  constructor(
    private readonly sampleRate: number,
    windowMs: number,
    private readonly silenceRms: number,
  ) {
    this.windowSamples = Math.round((sampleRate * windowMs) / 1000);
  }

  send(pcm: Uint8Array): void {
    if (this.closed) return;
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    this.pending.push(samples);
    this.pendingSamples += samples.length;
    while (this.pendingSamples >= this.windowSamples) this.flushWindow(this.windowSamples);
  }

  close(): Promise<void> {
    if (!this.closed) {
      if (this.pendingSamples > 0) this.flushWindow(this.pendingSamples);
      this.closed = true;
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
