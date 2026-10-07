import type { Unsubscribe } from '../../../shared/ipc/unsubscribe';

/**
 * A store a page reads with `useSyncExternalStore` and several components share: Home's Today, the
 * banner slot and the meeting banner all read the calendar, and each making its own would read the
 * same IPC channels again and listen to the same events three times.
 *
 * `retain()` starts the store (`start`, which subscribes to main and reads) for the first holder
 * and stops it with the last. The state survives in between, so a fact the page learned (the
 * calendar was just connected) is still there when Home mounts again.
 */
export abstract class RetainedStore<State> {
  private readonly listeners = new Set<() => void>();
  private holders = 0;
  private stop: Unsubscribe | null = null;

  protected constructor(protected state: State) {}

  readonly getState = (): State => this.state;

  readonly subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Starts the store when it is the first holder; call the result to let go. */
  retain(): Unsubscribe {
    this.holders += 1;
    if (this.holders === 1) this.stop = this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders -= 1;
      if (this.holders === 0) {
        this.stop?.();
        this.stop = null;
      }
    };
  }

  /** Follows main's events and reads what they will not repeat; returns what stops both. */
  protected abstract start(): Unsubscribe;

  protected update(change: Partial<State>): void {
    this.state = { ...this.state, ...change };
    for (const listener of [...this.listeners]) listener();
  }
}
