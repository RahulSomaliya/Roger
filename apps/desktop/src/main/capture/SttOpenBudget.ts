export interface SttOpenLimits {
  /** Opens per rolling minute (costGuards: sttOpensPerMinute). */
  perMinute: number;
  /** Opens per meeting (costGuards: sttOpensPerMeeting). */
  perMeeting: number;
}

/**
 * What an open draws on:
 * - meeting: a slot in the minute window and one of the meeting's opens (Start, stall and failure
 *   reopens)
 * - minute: a slot in the minute window only, never the meeting's count (the gap re-run, the
 *   silence gate's reopens, which keep a count of their own)
 */
export type SttOpenScope = 'meeting' | 'minute';

export type SttOpenDecision =
  | { ok: true }
  /** The minute is full: an open may go ahead at `retryAtMs` (clock time). */
  | { ok: false; kind: 'per-minute'; retryAtMs: number; message: string }
  /** This meeting has used its opens: nothing reopens until the next Start. */
  | { ok: false; kind: 'per-meeting'; message: string };

/** The vendor's window: AssemblyAI counts sessions started per minute. */
const WINDOW_MS = 60_000;

/**
 * The one gate every vendor session open passes. Every open is billed from its handshake, and
 * AssemblyAI refuses a free account's 6th start in a minute only after that handshake ("Too many
 * concurrent sessions"), so an open loop that ignored this would both spend money and lock Start
 * out.
 *
 * Every caller acquires right before `stt.openStream`, and an adapter never opens a socket on its
 * own (CLAUDE.md, architecture rule 9). These are the callers; a new one is added here and to the
 * rule in the same change:
 * - CaptureSession, on the meeting's allowance (`acquire(count)`): Start's two opens, and every
 *   reopen after a stall or a vendor failure, for both sources.
 * - CaptureSession's silence-gate reopens (M3-T20), in the minute only (`acquire(1, 'minute')`):
 *   the gate keeps its own per-meeting count, so it never spends the opens a failure needs.
 * - The gap re-run (M2-T16), in the minute only, through the one budget createCaptureRuntime.ts
 *   builds and shares with CaptureService: it runs after Stop, when the count still holds the last
 *   meeting's opens, and a meeting with gaps is the one whose failures spent them.
 * - The bench (M3-T11), through a budget of its own.
 *
 * The minute window outlives a meeting on purpose: the vendor counts per account, so Start, Stop,
 * Start inside a minute spends the same window, and so does a re-run after Stop. The per-meeting
 * count restarts at every Start, a crash resume's included (M2 D7).
 */
export class SttOpenBudget {
  /** Clock times of opens in the last WINDOW_MS, oldest first. */
  private recent: number[] = [];
  private meetingOpens = 0;

  constructor(
    private readonly limits: SttOpenLimits,
    private readonly clock: () => number,
  ) {}

  get openedThisMeeting(): number {
    return this.meetingOpens;
  }

  beginMeeting(): void {
    this.meetingOpens = 0;
  }

  /** Whether `count` opens could go ahead now. Takes nothing. */
  check(count = 1, scope: SttOpenScope = 'meeting'): SttOpenDecision {
    const now = this.clock();
    this.recent = this.recent.filter((at) => now - at < WINDOW_MS);
    if (scope === 'meeting' && this.meetingOpens + count > this.limits.perMeeting) {
      return {
        ok: false,
        kind: 'per-meeting',
        message:
          `${this.meetingOpens} speech-to-text sessions opened in this meeting (Roger's limit is ` +
          `${this.limits.perMeeting}, sttOpensPerMeeting)`,
      };
    }
    const mustLeave = this.recent.length + count - this.limits.perMinute;
    if (mustLeave > 0) {
      const retryAtMs = (this.recent[mustLeave - 1] ?? now) + WINDOW_MS;
      return {
        ok: false,
        kind: 'per-minute',
        retryAtMs,
        message:
          `${this.recent.length} speech-to-text sessions opened in the last minute (Roger's limit ` +
          `is ${this.limits.perMinute}, sttOpensPerMinute); the next may open in ` +
          `${Math.ceil((retryAtMs - now) / 1000)} s`,
      };
    }
    return { ok: true };
  }

  /** Takes `count` opens when all of them fit, else none. */
  acquire(count = 1, scope: SttOpenScope = 'meeting'): SttOpenDecision {
    const decision = this.check(count, scope);
    if (!decision.ok) return decision;
    const now = this.clock();
    for (let i = 0; i < count; i += 1) this.recent.push(now);
    if (scope === 'meeting') this.meetingOpens += count;
    return decision;
  }
}
