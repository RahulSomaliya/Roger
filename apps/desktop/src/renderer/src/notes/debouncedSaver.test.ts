import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotesApi, NotesFlush } from '../../../shared/ipc/notes';
import type { NoteDoc } from '../../../shared/notes';
import {
  DebouncedSaver,
  type DebouncedSaverOptions,
  NotesFlushResponder,
  SAVE_DEBOUNCE_MS,
  type SaverState,
} from './debouncedSaver';

const docSaying = (text: string): NoteDoc => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** A write main answers when the test says: `land()` the oldest, or `refuse()` it. */
function slowWrites() {
  const pending: { doc: NoteDoc; resolve: () => void; reject: (error: Error) => void }[] = [];
  const written: NoteDoc[] = [];
  return {
    written,
    pending,
    write: (doc: NoteDoc) =>
      new Promise<void>((resolve, reject) => {
        written.push(doc);
        pending.push({ doc, resolve, reject });
      }),
    land: async () => {
      pending.shift()?.resolve();
      await flushMicrotasks();
    },
    refuse: async (message: string) => {
      pending.shift()?.reject(new Error(message));
      await flushMicrotasks();
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let round = 0; round < 10; round += 1) await Promise.resolve();
}

/** main's flush channels, with the request sent when the test says. */
function fakeFlushApi() {
  const listeners = new Set<(request: NotesFlush) => void>();
  const acks: NotesFlush[] = [];
  const api: Pick<NotesApi, 'onNotesFlushRequest' | 'ackNotesFlush'> = {
    onNotesFlushRequest: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ackNotesFlush: (ack) => {
      acks.push(ack);
    },
  };
  return {
    api,
    acks,
    listeners,
    request: async (requestId: string) => {
      for (const listener of listeners) listener({ requestId });
      await flushMicrotasks();
    },
  };
}

/** A saver over a doc the test types into, with every trigger wired to fakes. */
function setUp(overrides: Partial<DebouncedSaverOptions> = {}) {
  let current = docSaying('');
  const writes = slowWrites();
  const page = new EventTarget();
  const flush = fakeFlushApi();
  const responder = new NotesFlushResponder(flush.api);
  const states: SaverState[] = [];
  const saver = new DebouncedSaver({
    read: () => current,
    write: writes.write,
    page,
    responder,
    onState: (state) => states.push(state),
    ...overrides,
  });
  return {
    saver,
    writes,
    page,
    flush,
    responder,
    states,
    type: (text: string) => {
      current = docSaying(text);
      saver.edited();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DebouncedSaver', () => {
  it('saves 400 ms after the last edit', async () => {
    const { writes, type } = setUp();
    expect(SAVE_DEBOUNCE_MS).toBe(400);
    type('B');
    await vi.advanceTimersByTimeAsync(300);
    type('Be');
    await vi.advanceTimersByTimeAsync(399);
    expect(writes.written).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // One save, of the doc as it stands when the pause ends.
    expect(writes.written).toEqual([docSaying('Be')]);
  });

  it('flushes on blur, unmount, pagehide and beforeunload', () => {
    // Blur: the editor calls blurred() from TipTap's onBlur.
    const blur = setUp();
    blur.type('on blur');
    blur.saver.blurred();
    expect(blur.writes.written).toEqual([docSaying('on blur')]);

    // Unmount: the editor's effect cleanup calls dispose(), which saves what is left.
    const unmount = setUp();
    unmount.type('on unmount');
    void unmount.saver.dispose();
    expect(unmount.writes.written).toEqual([docSaying('on unmount')]);

    // A reload or a closing window: no unmount runs, so the page events save.
    for (const event of ['pagehide', 'beforeunload']) {
      const page = setUp();
      page.type(`on ${event}`);
      page.page.dispatchEvent(new Event(event));
      // At once, not after an await: the page may be gone a moment later.
      expect(page.writes.written).toEqual([docSaying(`on ${event}`)]);
    }
  });

  it('answers a flush request from main after the save lands', async () => {
    const { flush, writes, type } = setUp();
    type('typed just before Cmd-Q');
    await flush.request('quit-1');
    expect(writes.written).toEqual([docSaying('typed just before Cmd-Q')]);
    expect(flush.acks).toEqual([]);
    await writes.land();
    expect(flush.acks).toEqual([{ requestId: 'quit-1' }]);
  });

  it('acks a flush request once, after every open editor saved', async () => {
    const flush = fakeFlushApi();
    const responder = new NotesFlushResponder(flush.api);
    const mine = slowWrites();
    const theirs = slowWrites();
    const editors = [mine, theirs].map(
      (writes, index) =>
        new DebouncedSaver({
          read: () => docSaying(`editor ${index}`),
          write: writes.write,
          responder,
        }),
    );
    for (const editor of editors) editor.edited();
    // One subscription for the page, however many editors are open.
    expect(flush.listeners.size).toBe(1);
    await flush.request('quit-2');
    await mine.land();
    expect(flush.acks).toEqual([]);
    await theirs.land();
    expect(flush.acks).toEqual([{ requestId: 'quit-2' }]);
  });

  it('acks at once in a page where no editor ever opened, and joins editors that open later', async () => {
    const flush = fakeFlushApi();
    const responder = new NotesFlushResponder(flush.api);
    // Subscribed as it is made: main's quit must not wait its 1 s on a page with no notes open.
    await flush.request('quit-0');
    expect(flush.acks).toEqual([{ requestId: 'quit-0' }]);
    const writes = slowWrites();
    const saver = new DebouncedSaver({
      read: () => docSaying('opened later'),
      write: writes.write,
      responder,
    });
    saver.edited();
    await flush.request('quit-1');
    expect(flush.listeners.size).toBe(1);
    expect(flush.acks).toEqual([{ requestId: 'quit-0' }]);
    await writes.land();
    expect(flush.acks).toEqual([{ requestId: 'quit-0' }, { requestId: 'quit-1' }]);
  });

  it('acks a flush request at once when nothing is unsaved', async () => {
    const { flush, writes } = setUp();
    await flush.request('quit-3');
    expect(writes.written).toEqual([]);
    expect(flush.acks).toEqual([{ requestId: 'quit-3' }]);
  });

  it('acks after a refused save too: main must not wait on a save that cannot land', async () => {
    const { flush, writes, type } = setUp();
    type('too deep');
    await flush.request('quit-4');
    await writes.refuse('note not saved: nested deeper than 32 levels');
    expect(flush.acks).toEqual([{ requestId: 'quit-4' }]);
  });

  it('keeps an unmounted editor in the flush until its last save lands', async () => {
    const { saver, flush, writes, type } = setUp();
    type('closing the meeting');
    void saver.dispose();
    await flush.request('quit-5');
    expect(flush.acks).toEqual([]);
    await writes.land();
    expect(flush.acks).toEqual([{ requestId: 'quit-5' }]);
    // Gone from the flush once that save landed.
    await flush.request('quit-6');
    expect(flush.acks).toEqual([{ requestId: 'quit-5' }, { requestId: 'quit-6' }]);
  });

  it('stops listening to the page once disposed', async () => {
    const { saver, page, writes, type } = setUp();
    await saver.dispose();
    type('after unmount');
    page.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(writes.written).toEqual([]);
  });

  it('shows a refused save, keeps the edits unsaved, and saves them on the next edit', async () => {
    const { saver, states, writes, type } = setUp();
    type('first');
    saver.blurred();
    await writes.refuse('note not saved: nested deeper than 32 levels');
    expect(states.at(-1)).toEqual({
      phase: 'failed',
      message: 'note not saved: nested deeper than 32 levels',
    });
    expect(saver.unsaved).toBe(true);
    // A flush retries the same edits.
    saver.blurred();
    expect(writes.written).toEqual([docSaying('first'), docSaying('first')]);
    await writes.land();
    expect(states.at(-1)).toEqual({ phase: 'saved' });
    expect(saver.unsaved).toBe(false);
  });

  it('shows a doc the editor cannot hand over as a refused save, and keeps the edits', async () => {
    const writes = slowWrites();
    const states: SaverState[] = [];
    let tooDeep = true;
    const saver = new DebouncedSaver({
      read: () => {
        if (tooDeep) throw new Error('nested deeper than 32 levels');
        return docSaying('fixed');
      },
      write: writes.write,
      onState: (state) => states.push(state),
    });
    saver.edited();
    await saver.flush();
    expect(writes.written).toEqual([]);
    expect(states.at(-1)).toEqual({ phase: 'failed', message: 'nested deeper than 32 levels' });
    expect(saver.unsaved).toBe(true);
    tooDeep = false;
    saver.edited();
    saver.blurred();
    await writes.land();
    expect(states.at(-1)).toEqual({ phase: 'saved' });
  });

  it("shows main's message without Electron's IPC wrapper", async () => {
    const { saver, states, writes, type } = setUp();
    type('x');
    saver.blurred();
    await writes.refuse(
      "Error invoking remote method 'notes:save': Error: note not saved: larger than 524288 bytes",
    );
    expect(states.at(-1)).toEqual({
      phase: 'failed',
      message: 'note not saved: larger than 524288 bytes',
    });
  });

  it('moves through pending, saving and saved', async () => {
    const { states, writes, type } = setUp();
    type('a');
    expect(states).toEqual([{ phase: 'pending' }]);
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(states.at(-1)).toEqual({ phase: 'saving' });
    await writes.land();
    expect(states.at(-1)).toEqual({ phase: 'saved' });
  });

  it('settled() waits for the saves on their way and counts them, sending nothing new', async () => {
    const { saver, writes, type } = setUp();
    type('one');
    saver.blurred();
    type('one two');
    let settled = false;
    void saver.settled().then(() => {
      settled = true;
    });
    expect(saver.saving).toBe(true);
    await writes.land();
    expect(settled).toBe(true);
    expect(saver.saving).toBe(false);
    // "two" was typed after the save started: still unsaved, and not sent by settled().
    expect(writes.written).toEqual([docSaying('one')]);
    expect(saver.unsaved).toBe(true);
  });

  it('sends edits made during a save in a second save, never the same edits twice', async () => {
    const { saver, writes, type } = setUp();
    type('one');
    saver.blurred();
    // A flush while that save is on its way, with nothing new: nothing more to send.
    saver.blurred();
    expect(writes.written).toHaveLength(1);
    type('one two');
    saver.blurred();
    expect(writes.written).toEqual([docSaying('one'), docSaying('one two')]);
    await writes.land();
    expect(saver.unsaved).toBe(true);
    await writes.land();
    expect(saver.unsaved).toBe(false);
  });

  it('a newer save that lands keeps an older refused one from showing', async () => {
    const { saver, states, writes, type } = setUp();
    type('one');
    saver.blurred();
    type('one two');
    saver.blurred();
    // The older one is refused after the newer one landed: the newer covers its edits.
    const [older, newer] = writes.pending;
    newer?.resolve();
    await flushMicrotasks();
    older?.reject(new Error('disk full'));
    await flushMicrotasks();
    expect(saver.unsaved).toBe(false);
    expect(states.at(-1)).toEqual({ phase: 'saved' });
  });
});
