import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notesChannels, type NotesFlush } from '../../shared/ipc/notes';
import { createLogger } from '../logger';
import { withTimeout } from '../util/time';
import { NOTES_FLUSH_TIMEOUT_MS, NotesQuitGuard, type FlushWindow } from './notesQuitGuard';

/** A window whose page answers main's flush request after `ackAfterMs`, or never (null). */
function page(id: number, ackAfterMs: number | null, guard: () => NotesQuitGuard) {
  const requests: NotesFlush[] = [];
  let destroyed = false;
  const window: FlushWindow = {
    webContents: {
      id,
      isDestroyed: () => destroyed,
      send: (channel, payload) => {
        if (channel !== notesChannels.NotesFlushRequest) throw new Error(`sent on ${channel}`);
        const request = payload as NotesFlush;
        requests.push(request);
        if (ackAfterMs === null) return;
        setTimeout(() => {
          guard().ack({ requestId: request.requestId });
        }, ackAfterMs);
      },
    },
  };
  return {
    window,
    requests,
    destroy: () => {
      destroyed = true;
    },
  };
}

function setUp(windows: (guard: () => NotesQuitGuard) => FlushWindow[]) {
  const calls: string[] = [];
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) });
  let requests = 0;
  const guard: NotesQuitGuard = new NotesQuitGuard({
    store: {
      close: () => {
        calls.push('close notes.sqlite');
      },
    },
    windows: () => open,
    logger,
    newRequestId: () => `00000000-0000-4000-8000-${String(++requests).padStart(12, '0')}`,
  });
  const open = windows(() => guard);
  guard.stopBeforeClose(
    {
      stop: () => {
        calls.push('stop the generator');
      },
    },
    {
      stop: () => {
        calls.push('stop the sync');
      },
    },
  );
  return {
    guard,
    calls,
    logged: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NotesQuitGuard', () => {
  it("the quit hook waits for each window's flush ack or 1 s, then closes notes.sqlite", async () => {
    let quick!: ReturnType<typeof page>;
    let silent!: ReturnType<typeof page>;
    let gone!: ReturnType<typeof page>;
    const { guard, calls, logged } = setUp((get) => {
      quick = page(7, 300, get);
      silent = page(9, null, get);
      gone = page(11, 0, get);
      gone.destroy();
      return [quick.window, silent.window, gone.window];
    });
    let done = false;

    const quitting = Promise.resolve(guard.quitHook.run()).then(() => {
      done = true;
    });

    // One request per open window, each with its own id; a closed window is not asked.
    expect(quick.requests).toHaveLength(1);
    expect(silent.requests).toHaveLength(1);
    expect(gone.requests).toEqual([]);
    expect(quick.requests[0]?.requestId).not.toBe(silent.requests[0]?.requestId);
    await vi.advanceTimersByTimeAsync(300);
    // The quick page saved, the silent one may still be saving: nothing closes yet.
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(NOTES_FLUSH_TIMEOUT_MS - 301);
    expect(done).toBe(false);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await quitting;

    expect(calls).toEqual(['stop the generator', 'stop the sync', 'close notes.sqlite']);
    expect(logged()).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'notes flush not answered in time',
        windowId: 9,
        timeoutMs: NOTES_FLUSH_TIMEOUT_MS,
      }),
    );
    // Its bound covers the 1 s wait and the closes after it.
    expect(guard.quitHook.timeoutMs).toBeGreaterThan(NOTES_FLUSH_TIMEOUT_MS);
  });

  it('goes on as soon as every window has acked', async () => {
    const { guard, calls } = setUp((get) => [page(7, 20, get).window, page(8, 40, get).window]);

    const quitting = Promise.resolve(guard.quitHook.run());
    await vi.advanceTimersByTimeAsync(40);
    await quitting;

    expect(calls).toEqual(['stop the generator', 'stop the sync', 'close notes.sqlite']);
  });

  it('counts only the ack of its own request', async () => {
    let silent!: ReturnType<typeof page>;
    const { guard } = setUp((get) => {
      silent = page(9, null, get);
      return [silent.window];
    });
    let done = false;
    void guard.saveOpenNotes().then(() => {
      done = true;
    });
    // An ack for an earlier request, or a made-up one, is not this page's answer.
    guard.ack({ requestId: '00000000-0000-4000-8000-000000000999' });
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(false);
    guard.ack({ requestId: silent.requests[0]?.requestId ?? '' });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it("asks the same way for Stop's check, and closes nothing", async () => {
    const { guard, calls } = setUp((get) => [page(7, 10, get).window]);
    const saving = guard.saveOpenNotes();
    await vi.advanceTimersByTimeAsync(10);
    await saving;
    expect(calls).toEqual([]);
  });

  it("fails Stop's save when a window did not answer, under Stop's own 1 s bound too", async () => {
    let silent!: ReturnType<typeof page>;
    const { guard, calls } = setUp((get) => {
      silent = page(9, null, get);
      return [page(7, 10, get).window, silent.window];
    });
    // CaptureService.keepsForNotes waits on it just so, with its own timer of the same length set
    // after the guard's: the guard's fires first, and a wait it ended must not read as a save.
    const saving = withTimeout(guard.saveOpenNotes(), NOTES_FLUSH_TIMEOUT_MS, 'saving notes');
    const outcome = saving.then(
      () => 'saved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await vi.advanceTimersByTimeAsync(NOTES_FLUSH_TIMEOUT_MS);

    await expect(outcome).resolves.toBe(
      `the notes open in window 9 were not saved in ${NOTES_FLUSH_TIMEOUT_MS} ms`,
    );
    expect(silent.requests).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('a window whose page is gone before the request has nothing to save for Stop', async () => {
    const { guard } = setUp((get) => {
      const gone = page(11, 0, get);
      gone.destroy();
      return [gone.window];
    });
    await expect(guard.saveOpenNotes()).resolves.toBeUndefined();
  });

  it('with no window open the quit closes at once', async () => {
    const { guard, calls } = setUp(() => []);
    await guard.quitHook.run();
    expect(calls).toEqual(['stop the generator', 'stop the sync', 'close notes.sqlite']);
  });

  it('a window whose send throws is logged and not waited for', async () => {
    const { guard, logged } = setUp(() => [
      {
        webContents: {
          id: 4,
          isDestroyed: () => false,
          send: () => {
            throw new Error('Object has been destroyed');
          },
        },
      },
    ]);
    await guard.saveOpenNotes();
    expect(logged()).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'notes flush request not sent',
        windowId: 4,
        error: 'Object has been destroyed',
      }),
    );
  });

  it('a stop that throws is logged, and notes.sqlite still closes', async () => {
    const { guard, calls, logged } = setUp(() => []);
    guard.stopBeforeClose({
      stop: () => {
        throw new Error('timer already cleared');
      },
    });
    await guard.quitHook.run();
    expect(calls).toEqual(['stop the generator', 'stop the sync', 'close notes.sqlite']);
    expect(logged()).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'notes service did not stop at quit',
        error: 'timer already cleared',
      }),
    );
  });
});
