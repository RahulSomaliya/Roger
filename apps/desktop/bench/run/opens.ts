import { SttOpenBudget } from '../../src/main/capture/SttOpenBudget';
import type { BenchTimers } from './timers';

/**
 * Every vendor session the bench opens takes a slot from its own SttOpenBudget, the app's class
 * (CLAUDE.md, architecture rule 9; M3 design, "Benchmark credentials"). The minute window is the
 * desktop's `sttOpensPerMinute` (ROGER_STT_OPENS_PER_MINUTE, under AssemblyAI's 5 starts a minute on
 * a free account), so `--parallel 3` (six opens at once) waits for slots instead of drawing "Too many
 * concurrent sessions" after a billed handshake. A run is not a meeting: the per-meeting limit is one
 * no run reaches, and nothing here ever calls beginMeeting.
 *
 * Turns go one at a time. A turn waits until the item's sessions fit the minute, fetches its token
 * (so a Deepgram grant, good for 30 s at the handshake, is never fetched before a minute's wait),
 * takes the slots, and the caller opens right away. Between the check and the take nobody else can
 * spend a slot, so the take always fits. When the run stops, a turn still waiting (for the minute,
 * or behind another turn) ends at once with no token fetched; the caller then opens nothing.
 */
export class BenchOpener {
  private readonly budget: SttOpenBudget;
  private readonly opensPerMinute: number;
  private turns: Promise<void> = Promise.resolve();

  constructor(
    limits: { opensPerMinute: number },
    private readonly timers: BenchTimers,
  ) {
    this.opensPerMinute = limits.opensPerMinute;
    this.budget = new SttOpenBudget(
      { perMinute: limits.opensPerMinute, perMeeting: Number.MAX_SAFE_INTEGER },
      () => timers.now(),
    );
  }

  /**
   * Waits for `count` slots in the minute, runs `prepare` (the token fetch), then takes the slots and
   * resolves with what `prepare` returned: the caller opens its `count` sessions next. When `prepare`
   * throws, no slot is taken and the error reaches the caller. When `signal` aborts before
   * `prepare` runs, it rejects without running it. A stop during `prepare` is the caller's to
   * check: the token has come, so the slots are taken, and the caller must not open.
   */
  reserve<T>(count: number, prepare: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const turn = this.turns.then(() => this.take(count, prepare, signal));
    // The queue only orders turns; each turn's own result or error goes to its caller through
    // `turn`, so a failed turn must not stop the ones queued behind it.
    const next = (): void => undefined;
    this.turns = turn.then(next, next);
    return turn;
  }

  private async take<T>(
    count: number,
    prepare: () => Promise<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    if (count > this.opensPerMinute) {
      // check() would never pass, and the item would wait forever.
      throw new Error(
        `an item needs ${count} sessions at once but ROGER_STT_OPENS_PER_MINUTE allows ` +
          `${this.opensPerMinute} a minute`,
      );
    }
    for (;;) {
      // Checked at the turn's start and after every wait: a turn queued behind a stopped one, or
      // woken early by the stop, must not fetch a token for sessions nobody will replay.
      if (signal?.aborted === true) {
        throw new Error('the run stopped while this item waited for open slots');
      }
      const decision = this.budget.check(count);
      if (decision.ok) break;
      if (decision.kind === 'per-meeting') throw new Error(decision.message);
      await this.timers.sleep(decision.retryAtMs - this.timers.now(), signal);
    }
    const prepared = await prepare();
    const taken = this.budget.acquire(count);
    if (!taken.ok) {
      throw new Error(`bench open budget refused slots its turn had checked: ${taken.message}`);
    }
    return prepared;
  }
}
