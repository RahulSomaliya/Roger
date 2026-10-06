import type { Unsubscribe } from '../../src/shared/ipc';

/**
 * What main is to the preview's `window.roger`: every fake answers its requests and sends its
 * events through one hub, so a scenario (M4-S3's preview/control.ts) can push any event, or fail
 * the next request, without editing a fake. Events are keyed by the real channel names
 * (IpcChannel), as webContents.send delivers them.
 */
export class FakeHub {
  private readonly listeners = new Map<string, Set<(payload: never) => void>>();
  private readonly failures: string[] = [];

  /** A main → renderer event: every listener of the channel gets the payload. */
  emit(channel: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) {
      // As in the preload's subscribe(): the API signature fixes the payload type, and a scenario
      // sends what the contract says.
      listener(payload as never);
    }
  }

  /** Listens like the preload's subscribe(); the returned function stops listening. */
  on(channel: string, listener: (payload: never) => void): Unsubscribe {
    const listeners = this.listeners.get(channel) ?? new Set();
    listeners.add(listener);
    this.listeners.set(channel, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  /** The next request through the hub, on any channel, rejects with this message. */
  failNextRequest(message: string): void {
    this.failures.push(message);
  }

  /**
   * Answers a request as main would: asynchronously, or with the rejection a failed
   * ipcRenderer.invoke gives when a failure is queued. Fakes route every invoke through here.
   */
  request<T>(channel: string, answer: () => T): Promise<T> {
    const failure = this.failures.shift();
    if (failure !== undefined) {
      return Promise.reject(
        new Error(`Error invoking remote method '${channel}': Error: ${failure}`),
      );
    }
    return Promise.resolve().then(answer);
  }
}
