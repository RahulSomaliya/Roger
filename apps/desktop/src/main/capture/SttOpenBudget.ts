export interface SttOpenLimits {
  /** Opens per rolling minute (costGuards: sttOpensPerMinute). */
  perMinute: number;
  /** Opens per meeting (costGuards: sttOpensPerMeeting). */
  perMeeting: number;
}

export type SttOpenDecision =
  | { ok: true }
  /** The minute is full: an open may go ahead at `retryAtMs` (clock time). */
  | { ok: false; kind: 'per-minute'; retryAtMs: number; message: string }
  /** This meeting has used its opens: nothing reopens until the next Start. */
  | { ok: false; kind: 'per-meeting'; message: string };

/** The vendor's window: AssemblyAI counts sessions started per minute. */
const WINDOW_MS = 60_000;

/**
 * The one gate every vendor session open passes: Start's two, a reopen after a stall, a reopen
 * after a vendor failure, for both sources. Every open is billed from its handshake, and AssemblyAI
 * refuses a free account's 6th start in a minute only after that handshake ("Too many concurrent
 * sessions"), so a reopen loop that ignored this would both spend money and lock Start out.
 *
 * The minute window outlives a meeting on purpose: the vendor counts per account, so Start, Stop,
 * Start inside a minute spends the same window. The per-meeting count restarts at every Start.
 * CaptureSession must call acquire() right before stt.openStream and nowhere else; an adapter
 * never opens a socket on its own (CLAUDE.md, architecture rule 9).
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
  check(count = 1): SttOpenDecision {
    const now = this.clock();
    this.recent = this.recent.filter((at) => now - at < WINDOW_MS);
    if (this.meetingOpens + count > this.limits.perMeeting) {
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
  acquire(count = 1): SttOpenDecision {
    const decision = this.check(count);
    if (!decision.ok) return decision;
    const now = this.clock();
    for (let i = 0; i < count; i += 1) this.recent.push(now);
    this.meetingOpens += count;
    return decision;
  }
}
