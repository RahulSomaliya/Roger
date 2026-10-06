import { describe, expect, it } from 'vitest';
import { LatestRead } from './latestRead';

/** A read the test answers by hand, one promise per call, in any order. */
function manualReads<T>() {
  const pending: { resolve: (value: T) => void; reject: (error: unknown) => void }[] = [];
  const read = (): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  const call = (index: number) => {
    const entry = pending[index];
    if (entry === undefined) throw new Error(`no read ${index} was started`);
    return entry;
  };
  return { read, call, started: () => pending.length };
}

const describeFailure = (error: unknown): string =>
  `Could not read: ${error instanceof Error ? error.message : String(error)}`;

/** Lets every settled promise run its callbacks. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('LatestRead', () => {
  it('holds nothing until the first answer, then the answer', async () => {
    const reads = manualReads<string>();
    const store = new LatestRead(reads.read, describeFailure);
    expect(store.getSnapshot()).toEqual({ value: undefined, error: null });
    store.refresh();
    reads.call(0).resolve('first');
    await flush();
    expect(store.getSnapshot()).toEqual({ value: 'first', error: null });
  });

  it('keeps showing the last answer while a refresh runs', async () => {
    const reads = manualReads<string>();
    const store = new LatestRead(reads.read, describeFailure);
    store.refresh();
    reads.call(0).resolve('first');
    await flush();
    store.refresh();
    expect(store.getSnapshot().value).toBe('first');
  });

  it('drops an answer older than the latest read, whichever comes back first', async () => {
    const reads = manualReads<string>();
    const store = new LatestRead(reads.read, describeFailure);
    store.refresh();
    store.refresh();
    reads.call(1).resolve('newer');
    await flush();
    reads.call(0).resolve('older');
    await flush();
    expect(store.getSnapshot().value).toBe('newer');
  });

  it('reports a failed read with its reason and keeps the last answer', async () => {
    const reads = manualReads<string>();
    const store = new LatestRead(reads.read, describeFailure);
    store.refresh();
    reads.call(0).resolve('first');
    await flush();
    store.refresh();
    reads.call(1).reject(new Error('database is locked'));
    await flush();
    expect(store.getSnapshot()).toEqual({
      value: 'first',
      error: 'Could not read: database is locked',
    });
    store.refresh();
    reads.call(2).resolve('again');
    await flush();
    expect(store.getSnapshot()).toEqual({ value: 'again', error: null });
  });

  it('turns a read that throws before it returns a promise into a failure', async () => {
    const store = new LatestRead<string>(() => {
      throw new Error('window.roger has no getMeeting');
    }, describeFailure);
    store.refresh();
    await flush();
    expect(store.getSnapshot().error).toBe('Could not read: window.roger has no getMeeting');
  });

  it('tells subscribers each change, and stops once they unsubscribe', async () => {
    const reads = manualReads<string>();
    const store = new LatestRead(reads.read, describeFailure);
    let changes = 0;
    const unsubscribe = store.subscribe(() => {
      changes += 1;
    });
    store.refresh();
    reads.call(0).resolve('first');
    await flush();
    expect(changes).toBe(1);
    unsubscribe();
    store.refresh();
    reads.call(1).resolve('second');
    await flush();
    expect(changes).toBe(1);
    expect(reads.started()).toBe(2);
  });
});
