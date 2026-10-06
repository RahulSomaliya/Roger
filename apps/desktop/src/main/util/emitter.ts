/** Tiny typed event emitter. Enough for the handful of events main-process services expose. */
export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => {
      set.delete(listener);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) (listener as (payload: Events[K]) => void)(payload);
  }
}
