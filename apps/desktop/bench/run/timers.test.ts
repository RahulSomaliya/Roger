import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { REAL_TIMERS } from './timers';

describe('REAL_TIMERS.sleep', () => {
  it('ends a long wait at once when its signal aborts', async () => {
    const abort = new AbortController();
    const startedAt = performance.now();

    const slept = REAL_TIMERS.sleep(60_000, abort.signal);
    abort.abort('the run stopped');
    await slept;

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });

  it('does not wait at all on a signal already aborted', async () => {
    const abort = new AbortController();
    abort.abort('the run stopped');
    const startedAt = performance.now();

    await REAL_TIMERS.sleep(60_000, abort.signal);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it('leaves no listener on the signal once a wait ends on time', async () => {
    const abort = new AbortController();

    await REAL_TIMERS.sleep(1, abort.signal);
    await REAL_TIMERS.sleep(1, abort.signal);

    // The run's one signal sees every wait of a run; a listener left per wait would pile up.
    expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  });
});
