/** What a LatestRead shows: its latest answer, and why the latest read failed. */
export interface ReadState<T> {
  /** The latest answer; undefined until the first read answers. */
  readonly value: T | undefined;
  /** Why the latest read failed, for the page; null once a read answers again. */
  readonly error: string | null;
}

/**
 * One read from main that the page repeats when what it shows may have changed (the meeting, the
 * recent meetings), for useSyncExternalStore. A refresh keeps the last answer on screen until the
 * next one lands, so the page never flashes back to empty; an answer older than the latest read
 * is dropped, so a slow read never overwrites a newer one; a failure is kept as `error` beside the
 * last answer, never dropped. Reading starts only on refresh() or readFor(), never on construction:
 * React makes this during render, also under renderToString, where there is no `window.roger`.
 */
export class LatestRead<T> {
  private state: ReadState<T> = { value: undefined, error: null };
  private latest = 0;
  /** The key of the last readFor; null before the first. */
  private readKey: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly read: () => Promise<T>,
    private readonly describeFailure: (error: unknown) => string,
  ) {}

  readonly getSnapshot = (): ReadState<T> => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Reads unless the last readFor had this same key: useLatestRead's effect calls it with its
   * refreshKey, so the page reads when the key changes, and once when StrictMode runs that effect
   * twice on mount (the dev build and the preview). refresh() reads whatever the key (Try again).
   */
  readonly readFor = (key: string): void => {
    if (key === this.readKey) return;
    this.readKey = key;
    this.refresh();
  };

  readonly refresh = (): void => {
    this.latest += 1;
    const id = this.latest;
    // A read that throws instead of rejecting fails the same way.
    void new Promise<T>((resolve) => {
      resolve(this.read());
    }).then(
      (value) => {
        if (id === this.latest) this.set({ value, error: null });
      },
      (error: unknown) => {
        if (id === this.latest)
          this.set({ value: this.state.value, error: this.describeFailure(error) });
      },
    );
  };

  private set(next: ReadState<T>): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}
