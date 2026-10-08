import type { PromptApi, PromptPanelState } from '../../../shared/ipc/prompt';
import type { Unsubscribe } from '../../../shared/ipc/unsubscribe';

/** What the panel page knows about main's state: the state, or why it has none. */
export interface PromptFeed {
  /** The latest state main sent; null until the first read answers, or when it failed. */
  state: PromptPanelState | null;
  /**
   * The first read failed (an untrusted sender, a main that is gone). A flag, not the cause: the
   * cause is an IPC error text ("Error invoking remote method 'prompt:...'") that is not for a person
   * floating over their call (redesign sweep, P2), and this page has no channel to the log.
   */
  readFailed: boolean;
}

/**
 * Keeps the page on main's state: the read when the page loads, then every change. Returns the
 * stop. Main owns the state and the page holds none (shared/ipc/prompt.ts), so there is nothing to
 * merge, only an order to keep:
 * - Subscribe BEFORE reading: a change main sends between the two would otherwise be lost, and the
 *   panel would show cards that are already gone (the contract on `PromptApi.getState`).
 * - A read that answers after a change is dropped: the change is newer.
 * - A read that answers after the stop is dropped, as React's StrictMode stops and reruns effects.
 */
export function followPromptState(
  api: Pick<PromptApi, 'getState' | 'onStateChanged'>,
  onFeed: (feed: PromptFeed) => void,
): Unsubscribe {
  let stopped = false;
  let changed = false;
  const unsubscribe = api.onStateChanged((state) => {
    changed = true;
    onFeed({ state, readFailed: false });
  });
  api.getState().then(
    (state) => {
      if (!stopped && !changed) onFeed({ state, readFailed: false });
    },
    () => {
      if (stopped || changed) return;
      onFeed({ state: null, readFailed: true });
    },
  );
  return () => {
    stopped = true;
    unsubscribe();
  };
}
