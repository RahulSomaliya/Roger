import type { SttCredentialUse } from '../stt/SpeechToText';
import {
  GATE_TOKEN_MIN_INTERVAL_MS,
  GATE_TOKEN_MIN_LEFT_MS,
  GATE_TOKEN_REFRESH_LEAD_MS,
} from './SilenceGate';

export interface GateTokensOptions<T> {
  /** What one token may open: the adapter's declaration (SpeechToText.credentialUse). */
  credentialUse: SttCredentialUse;
  /** One fresh token from the API. */
  fetch(): Promise<T>;
  /** How long `token` has left now; Infinity for one with no known expiry. */
  leftMs(token: T): number;
  now(): number;
  /**
   * A prefetch failed. It is tried again `retryInMs` from now (GATE_TOKEN_MIN_INTERVAL_MS after it
   * began); meanwhile a reopen fetches at the onset.
   */
  onPrefetchFailed(error: unknown, retryInMs: number): void;
}

interface Slot<T> {
  token: T | null;
  /** The prefetch on its way: a reopen at the onset waits for it rather than fetch twice. */
  fetching: Promise<void> | null;
  /** No prefetch before this time (GATE_TOKEN_MIN_INTERVAL_MS after the last one began). */
  notBeforeMs: number;
}

/**
 * The silence gate's prefetched tokens (M3-T20), for CaptureSession and the bench's gated replay
 * (bench/run/replay.ts GateRun): fetched while a source is gated, and again
 * GATE_TOKEN_REFRESH_LEAD_MS before each expires, so speech after a silence opens with no API call
 * at the onset. Driven by the caller (each gated chunk), never a timer, and never while the caller
 * may fetch nothing (closing, suspended): it decides when to call keepFresh.
 *
 * How many it keeps is the vendor's declaration (SttCredentialUse), never this class's choice:
 * - `reusable` (AssemblyAI): ONE token every gated source reopens with, kept until it runs low, as
 *   Start's one token opens both sources.
 * - `single-connection` (xAI): one per gated source, handed to exactly one reopen and forgotten.
 *   A token shared here opens the first reopen and gets the second refused with HTTP 401 (the
 *   2026-10-08 probe); a token taken by a reopen that went stale is dropped, never handed on.
 *   Start (CaptureSession.open), the other reopens (CaptureSession.reopen and connect) and the gap
 *   re-run (GapRetranscriber.open) keep the same rule each in their own place.
 */
export class GateTokens<T> {
  private readonly slots = new Map<string, Slot<T>>();

  constructor(private readonly options: GateTokensOptions<T>) {}

  /**
   * Keeps a token fresh for each source in `gated` (the ones the gate holds closed now): one for
   * all of them, or one each (class comment). At most one fetch per slot is on its way, and fetches
   * of a slot are at least GATE_TOKEN_MIN_INTERVAL_MS apart, so a failed one is tried again then
   * and a token shorter-lived than the lead is not fetched at every chunk.
   */
  keepFresh(gated: readonly string[]): void {
    for (const key of new Set(gated.map((source) => this.slotKey(source)))) this.refresh(key);
  }

  /**
   * The token `source`'s gate reopen opens with: the prefetched one (waiting for a prefetch still
   * on its way) while it has GATE_TOKEN_MIN_LEFT_MS or more left, else a fetch now, as any reopen
   * does. A single-connection token leaves its slot here, used or not.
   */
  async take(source: string): Promise<T> {
    const slot = this.slots.get(this.slotKey(source));
    if (slot === undefined) return this.options.fetch();
    if (slot.fetching !== null) await slot.fetching;
    // Read after the wait, never the prefetch's own result: two reopens waiting on one
    // single-connection prefetch would both get its token.
    const token = slot.token;
    if (this.options.credentialUse === 'single-connection') slot.token = null;
    if (token !== null && this.options.leftMs(token) >= GATE_TOKEN_MIN_LEFT_MS) return token;
    return this.options.fetch();
  }

  private slotKey(source: string): string {
    return this.options.credentialUse === 'reusable' ? 'shared' : source;
  }

  private refresh(key: string): void {
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = { token: null, fetching: null, notBeforeMs: 0 };
      this.slots.set(key, slot);
    }
    if (slot.fetching !== null) return;
    const now = this.options.now();
    if (now < slot.notBeforeMs) return;
    if (slot.token !== null && this.options.leftMs(slot.token) > GATE_TOKEN_REFRESH_LEAD_MS) return;
    const target = slot;
    target.notBeforeMs = now + GATE_TOKEN_MIN_INTERVAL_MS;
    const fetching = this.options.fetch().then(
      (token) => {
        target.token = token;
      },
      (error: unknown) => {
        this.options.onPrefetchFailed(error, Math.max(0, target.notBeforeMs - this.options.now()));
      },
    );
    target.fetching = fetching;
    void fetching.finally(() => {
      if (target.fetching === fetching) target.fetching = null;
    });
  }
}
