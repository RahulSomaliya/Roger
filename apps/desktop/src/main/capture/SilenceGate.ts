import { pcmBytesToMs, rmsInt16 } from '../../shared/pcm';

/**
 * The level of one chunk with no level at all (exact zeros) or under one least significant bit of
 * Int16 (1/32768, -90.3 dBFS): digital silence. The noise floor never reads lower, so a waiting
 * room's exact zeros followed by a dither of one bit is not taken for a voice 9 dB over the floor.
 */
export const DIGITAL_SILENCE_DB = -90;

/** Louder than this is speech whatever the room (M3 design, "Silence-gated streaming"). */
export const SPEECH_LEVEL_DB = -40;

/** A chunk more than this over the noise floor is speech: a soft voice in a quiet room. */
export const SPEECH_OVER_FLOOR_DB = 9;

/** The noise floor is this percentile of the chunk levels of the last FLOOR_WINDOW_MS. */
const FLOOR_PERCENTILE = 0.1;
const FLOOR_WINDOW_MS = 30_000;

/** Bytes per sample of the PCM every source sends (Int16 mono). */
const SAMPLE_BYTES = 2;

/**
 * The gate never closes a session younger than this: at most one gate reopen per source per
 * minute, the open budget's window, and every gated session has billed a minute anyway.
 * CaptureSession and the bench's gated replay both keep it.
 */
export const GATE_MIN_OPEN_MS = 60_000;

/**
 * The token a gate reopen opens with is fetched while the source is closed (prefetched), so speech
 * after a silence needs no API call at the onset. It is fetched again this long before it expires.
 */
export const GATE_TOKEN_REFRESH_LEAD_MS = 10_000;

/** A gate reopen opens with the prefetched token only when it has this long left; else it fetches. */
export const GATE_TOKEN_MIN_LEFT_MS = 5_000;

/**
 * Prefetches are at least this far apart: a failed one is tried again after it, and a token that
 * lives less than the refresh lead (the API's fake names 0 s) is not fetched again at every chunk.
 */
export const GATE_TOKEN_MIN_INTERVAL_MS = 10_000;

/** The silence gate's settings, from costGuards.ts: what CaptureSession and the bench run it with. */
export interface SilenceGateSettings {
  /** The hang-over: chunks with no speech for this long close the session (sttSilenceCloseMs). */
  closeAfterMs: number;
  /** Audio kept while closed, sent first on the reopen (sttSilencePreRollMs). */
  preRollMs: number;
  /** The gate's own reopens per meeting, both sources (sttSilenceReopensPerMeeting). */
  reopensPerMeeting: number;
}

export interface SilenceGateOptions {
  /** The hang-over: audio with no speech chunk in it after which the source may close (> 0). */
  closeAfterMs: number;
  /** Audio kept while closed, sent first when speech reopens it. */
  preRollMs: number;
  sampleRate: number;
}

/** A chunk the ring kept, with the wall clock of its first sample, as CaptureSession holds it. */
export interface GateChunk {
  pcm: Uint8Array;
  capturedAtMs: number;
}

/** What hear() made of one chunk. */
export interface Heard {
  speech: boolean;
  levelDb: number;
}

/** A gated window that speech ended (open()). */
export interface GatedWindow {
  /** The pre-roll, oldest first: the newest preRollMs of audio before the speech chunk. */
  preRoll: GateChunk[];
  /** The loudest chunk while closed, in dBFS; null when none arrived. */
  peakDb: number | null;
}

/**
 * The level of a 16-bit PCM chunk in dBFS (rmsInt16), never below DIGITAL_SILENCE_DB. A chunk that
 * starts at an odd byte offset (a slice of a pooled Node buffer) is copied first: an Int16Array
 * view needs an even one.
 */
export function chunkLevelDb(pcm: Uint8Array): number {
  const samples =
    pcm.byteOffset % SAMPLE_BYTES === 0
      ? new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / SAMPLE_BYTES))
      : new Int16Array(pcm.slice().buffer, 0, Math.floor(pcm.byteLength / SAMPLE_BYTES));
  const rms = rmsInt16(samples);
  if (rms === 0) return DIGITAL_SILENCE_DB;
  return Math.max(DIGITAL_SILENCE_DB, 20 * Math.log10(rms));
}

/**
 * One source's silence gate (M3-T20), pure: no clock, no session. It reads each chunk's level
 * against a running noise floor (the 10th percentile of the last 30 s) and calls it speech when it
 * is more than 9 dB over the floor or louder than -40 dBFS. A wrong "speech" only keeps a session
 * open (money), a wrong "silence" loses words, so the test leans to speech and the hang-over is
 * long. CaptureSession owns what happens: it closes the source's session once shouldClose says so
 * (and its own rules allow), calls close(), and on the next speech chunk calls open() and sends
 * the pre-roll ahead of that chunk.
 *
 * The hang-over counts audio since the last speech chunk, not the clock: a stall sends no chunk,
 * and that is CaptureService's stall close (G2), not silence.
 */
export class SilenceGate {
  /** Levels of the last FLOOR_WINDOW_MS of chunks, oldest first, with each chunk's length. */
  private readonly levels: { db: number; ms: number }[] = [];
  private levelsMs = 0;
  private silentMs = 0;
  private closed = false;
  private ring: GateChunk[] = [];
  private ringMs = 0;
  private peakDb: number | null = null;

  constructor(private readonly options: SilenceGateOptions) {
    const { closeAfterMs, preRollMs, sampleRate } = options;
    if (!(closeAfterMs > 0) || !(preRollMs >= 0) || !(sampleRate > 0)) {
      throw new RangeError(
        `The silence gate needs a hang-over over 0, a pre-roll of 0 or more and a sample rate ` +
          `(got ${closeAfterMs} ms, ${preRollMs} ms, ${sampleRate} Hz).`,
      );
    }
  }

  /** True between close() and open(): the source's session is closed for silence. */
  get gated(): boolean {
    return this.closed;
  }

  /** Audio, in ms, since the last speech chunk (since the first chunk, before any). */
  get silentForMs(): number {
    return this.silentMs;
  }

  /** The hang-over has passed with the session open: CaptureSession may close it. */
  get shouldClose(): boolean {
    return !this.closed && this.silentMs >= this.options.closeAfterMs;
  }

  /** The noise floor in dBFS: the 10th percentile of the last 30 s of chunk levels. */
  get floorDb(): number {
    if (this.levels.length === 0) return DIGITAL_SILENCE_DB;
    const sorted = this.levels.map((level) => level.db).sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * FLOOR_PERCENTILE));
    return sorted[index] ?? DIGITAL_SILENCE_DB;
  }

  /**
   * Reads one chunk: speech or not, against the floor of the chunks before it (so an onset is
   * measured against the room, not against itself), then counts it into the floor and the
   * hang-over. While closed, a chunk that is not speech goes into the pre-roll ring (the newest
   * preRollMs kept); a speech chunk does not: the caller sends it after the pre-roll.
   */
  hear(pcm: Uint8Array, capturedAtMs: number): Heard {
    const levelDb = chunkLevelDb(pcm);
    const ms = pcmBytesToMs(pcm.byteLength, this.options.sampleRate);
    const speech = levelDb > SPEECH_LEVEL_DB || levelDb > this.floorDb + SPEECH_OVER_FLOOR_DB;
    this.levels.push({ db: levelDb, ms });
    this.levelsMs += ms;
    while (this.levelsMs > FLOOR_WINDOW_MS && this.levels.length > 1) {
      const oldest = this.levels.shift();
      if (oldest === undefined) break;
      this.levelsMs -= oldest.ms;
    }
    this.silentMs = speech ? 0 : this.silentMs + ms;
    if (this.closed && !speech) this.keep({ pcm, capturedAtMs }, ms, levelDb);
    return { speech, levelDb };
  }

  /** The source's session closed for silence: hear() keeps the pre-roll from now on. */
  close(): void {
    this.closed = true;
    this.ring = [];
    this.ringMs = 0;
    this.peakDb = null;
  }

  /** Speech ended the gated window: its pre-roll and peak, handed over once. */
  open(): GatedWindow {
    const window: GatedWindow = { preRoll: this.ring, peakDb: this.peakDb };
    this.closed = false;
    this.ring = [];
    this.ringMs = 0;
    this.peakDb = null;
    return window;
  }

  private keep(chunk: GateChunk, ms: number, levelDb: number): void {
    this.peakDb = Math.max(this.peakDb ?? levelDb, levelDb);
    this.ring.push(chunk);
    this.ringMs += ms;
    while (this.ringMs > this.options.preRollMs && this.ring.length > 0) {
      const oldest = this.ring.shift();
      if (oldest === undefined) break;
      this.ringMs -= pcmBytesToMs(oldest.pcm.byteLength, this.options.sampleRate);
    }
  }
}
