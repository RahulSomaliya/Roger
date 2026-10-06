/**
 * `realtime`: the vendor closes a session that is sent audio faster than real time (AssemblyAI,
 * close code 3007, "Audio Transmission Rate Exceeded"), so audio is never sent ahead of the wall
 * time since the session's ready signal by more than one frame. `none`: every frame goes at once.
 */
export type AudioPacing = 'realtime' | 'none';

export interface AudioPacerOptions {
  pacing: AudioPacing;
  /** Of the Int16 mono PCM it paces: a frame's duration comes from its byte length. */
  sampleRate: number;
}

/**
 * When each audio frame of one vendor session may go. Pure: time is the `nowMs` each call is
 * given, so it runs on any clock; SttConnection owns the queue's timer and the socket.
 *
 * The rule, under `realtime`: a frame goes once the audio sent before it fits in the time since
 * `start()` (the ready signal), so what was sent is never ahead of that time by more than the one
 * frame in flight. Live audio arrives once it was captured, so it is never held. A backlog (the
 * audio CaptureSession held while the session reopened) goes out at 1x and is never caught up:
 * AssemblyAI documents no tolerance above 1x, so that backlog stays as lag on the session until it
 * closes. The count is cumulative since ready: a source that sent nothing for a while (a stall, a
 * wake) has that time to spend, and its late audio goes as fast as it fits.
 */
export class AudioPacer {
  private readonly pacing: AudioPacing;
  /** Bytes of PCM per second, so the comparisons below stay in whole numbers. */
  private readonly bytesPerSecond: number;
  private startedAtMs: number | null = null;
  private sentBytes = 0;
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;

  constructor(options: AudioPacerOptions) {
    this.pacing = options.pacing;
    this.bytesPerSecond = options.sampleRate * 2;
  }

  /** The vendor's ready signal: real time counts from here. Nothing goes before it. */
  start(atMs: number): void {
    this.startedAtMs = atMs;
  }

  enqueue(frame: Uint8Array): void {
    this.queue.push(frame);
    this.queuedBytes += frame.byteLength;
  }

  /** The frames that may go at `nowMs`, oldest first. They count as sent. */
  take(nowMs: number): Uint8Array[] {
    const due: Uint8Array[] = [];
    for (;;) {
      const frame = this.queue[0];
      if (frame === undefined || !this.mayGo(nowMs)) return due;
      this.queue.shift();
      this.sentBytes += frame.byteLength;
      this.queuedBytes -= frame.byteLength;
      due.push(frame);
    }
  }

  /** The clock time the next queued frame may go, or null when nothing waits (or before ready). */
  nextAtMs(): number | null {
    if (this.startedAtMs === null || this.queue.length === 0) return null;
    if (this.pacing === 'none') return this.startedAtMs;
    return this.startedAtMs + (this.sentBytes * 1000) / this.bytesPerSecond;
  }

  /** Audio waiting to go, in ms. */
  get queuedMs(): number {
    return (this.queuedBytes * 1000) / this.bytesPerSecond;
  }

  /** Drops every queued frame (the session is over) and returns how much audio that was, in ms. */
  discard(): number {
    const discardedMs = this.queuedMs;
    this.queue.length = 0;
    this.queuedBytes = 0;
    return discardedMs;
  }

  /** sentMs <= elapsedMs, multiplied out so a 44.1 kHz stream compares whole numbers too. */
  private mayGo(nowMs: number): boolean {
    if (this.startedAtMs === null) return false;
    if (this.pacing === 'none') return true;
    return this.sentBytes * 1000 <= (nowMs - this.startedAtMs) * this.bytesPerSecond;
  }
}
