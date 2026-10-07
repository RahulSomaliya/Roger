import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notesChannels, type NotesFlush } from '../../shared/ipc/notes';
import {
  CaptureService,
  type RecordingEnded,
  type RecordingListener,
} from '../capture/CaptureService';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import { FakeSpeechToText } from '../stt/fake/FakeSpeechToText';
import { TranscriptUploader } from '../upload/TranscriptUploader';
import { withTimeout } from '../util/time';
import { NOTES_RECHECK_MS, NotesGenerator } from './NotesGenerator';
import {
  KeptSilentMeetings,
  NOTES_FLUSH_TIMEOUT_MS,
  NotesQuitGuard,
  type FlushWindow,
} from './notesQuitGuard';
import { SqliteNotesStore } from './SqliteNotesStore';

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

/**
 * Stop, the uploader, the generator, the guard and the watch as main wires them (index.ts), with a
 * page that never answers the flush request: none does until M4-T20 mounts the responder, and a
 * busy page may not answer in time after that.
 */
function stopWithAnUnansweredFlush() {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) });
  /** Every API request made; none is expected. */
  const requests: string[] = [];
  const unexpected = (what: string) => (): Promise<never> => {
    requests.push(what);
    return Promise.reject(new Error(`no ${what} expected`));
  };
  const transcripts = new InMemoryTranscriptStore();
  const notes = new SqliteNotesStore(':memory:');
  const unanswered: FlushWindow = {
    webContents: { id: 7, isDestroyed: () => false, send: () => undefined },
  };
  const guard = new NotesQuitGuard({ store: notes, windows: () => [unanswered], logger });
  const uploader = new TranscriptUploader({
    store: transcripts,
    api: {
      createMeeting: unexpected('meeting create'),
      appendSegments: unexpected('line upload'),
      endMeeting: unexpected('meeting end'),
    },
    logger,
    hasNotes: (meetingId) => notes.hasNotes(meetingId),
    saveOpenNotes: () => guard.saveOpenNotes(),
  });
  const capture = new CaptureService({
    store: transcripts,
    api: { getSttToken: unexpected('speech-to-text token') },
    uploader,
    createSpeechToText: () => new FakeSpeechToText(),
    ensureMicrophoneAccess: () => Promise.resolve('granted'),
    logger,
    sttProviderOverride: 'fake',
    startupError: null,
  });
  const generator = new NotesGenerator({
    store: notes,
    sync: { flushMeeting: unexpected('notes flush'), pullMeeting: unexpected('notes pull') },
    streams: { streamNotes: unexpected('notes run'), cancelNotes: unexpected('notes cancel') },
    api: { getRun: unexpected('run read'), cancelRun: unexpected('run cancel') },
    transcripts,
    uploads: uploader,
    recordings: capture,
    window: () => null,
    logger,
  });
  const kept = new KeptSilentMeetings({
    recordings: capture,
    uploads: uploader,
    transcripts,
    pendingGenerates: notes,
    generator,
    logger,
  });
  // index.ts's order: the watch, then the generator.
  kept.start();
  generator.start();
  const ended: RecordingEnded[] = [];
  capture.onRecording({
    ended: (recording) => {
      ended.push(recording);
    },
  });
  /** What the page is told of the meeting's generate: each phase, then `null` once it is gone. */
  const told: (string | null)[] = [];
  generator.onPendingChanged((change) => {
    told.push(change.pending?.status.phase ?? null);
  });
  return {
    transcripts,
    notes,
    capture,
    generator,
    ended,
    told,
    requests,
    logged: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    stopAll: () => {
      kept.stop();
      generator.stop();
      uploader.stop();
    },
  };
}

describe('a silent meeting Stop kept because a window did not save its notes', () => {
  it('loses the generate pressed during the recording once the upload at Stop discards it as empty', async () => {
    const h = stopWithAnUnansweredFlush();
    await h.capture.start();
    const meetingId = h.capture.getStatus().meetingId ?? '';
    expect(h.transcripts.getMeeting(meetingId)).not.toBeNull();
    // Write notes pressed mid-call: Stop writes no row of its own, so this is the only one.
    h.generator.generate(meetingId, 'general');

    // Nobody spoke. Stop asks the page to save, waits its 1 s, and keeps the meeting unchecked.
    const stopping = h.capture.stop();
    await vi.advanceTimersByTimeAsync(NOTES_FLUSH_TIMEOUT_MS);
    await stopping;

    expect(h.ended).toEqual([{ meetingId, reason: 'user', discarded: false, stopFailed: false }]);
    expect(h.logged()).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'kept a meeting whose notes could not be checked',
        meetingId,
      }),
    );
    // Stop's upload found no line and no notes in the meeting and discarded it as empty, and the
    // generate went with it.
    expect(h.transcripts.getMeeting(meetingId)).toBeNull();
    expect(h.logged()).toContainEqual(
      expect.objectContaining({ message: 'empty meeting discarded', meetingId }),
    );
    expect(h.told).toEqual(['waiting_for_notes', null]);
    expect(h.notes.listPendingGenerates()).toEqual([]);
    expect(h.generator.getPending(meetingId)).toBeNull();

    // Nothing waits to be re-checked, and nothing was ever sent for the gone meeting.
    await vi.advanceTimersByTimeAsync(NOTES_RECHECK_MS);
    expect(h.notes.listPendingGenerates()).toEqual([]);
    expect(h.requests).toEqual([]);
    h.stopAll();
  });
});

const KEPT = '5d2c7a10-8e4b-4f6a-9c3d-2b1e0f9a8c7d';
const SPOKEN = '6e3d8b21-9f5c-4a7b-8d4e-3c2f1a0b9d8e';

/** KeptSilentMeetings over roger.sqlite's in-memory twin, with Stop, uploads and generates faked. */
function keptSetUp(options: { generates?: string[] } = {}) {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) });
  const transcripts = new InMemoryTranscriptStore();
  const recordingListeners = new Set<RecordingListener>();
  const statusListeners = new Set<() => void>();
  /** Meetings with a pending generate. */
  const generates = new Set(options.generates ?? []);
  const cancels: string[] = [];
  let refusal: Error | null = null;
  /** notes.sqlite reads that fail before one succeeds. */
  let failedReads = 0;
  const kept = new KeptSilentMeetings({
    recordings: {
      onRecording: (listener) => {
        recordingListeners.add(listener);
        return () => {
          recordingListeners.delete(listener);
        };
      },
    },
    uploads: {
      onStatus: (listener) => {
        statusListeners.add(listener);
        return () => {
          statusListeners.delete(listener);
        };
      },
    },
    transcripts,
    pendingGenerates: {
      listPendingGenerates: () =>
        [...generates].map((meetingId) => ({
          meetingId,
          runId: '00000000-0000-4000-8000-000000000042',
          templateId: 'general',
          reason: 'button',
          createdAt: '2026-10-07T09:00:00.000Z',
          lastError: null,
        })),
    },
    generator: {
      getPending: (meetingId) => {
        if (failedReads > 0) {
          failedReads -= 1;
          throw new Error('database is locked');
        }
        return generates.has(meetingId)
          ? {
              meetingId,
              runId: '00000000-0000-4000-8000-000000000042',
              templateId: 'general',
              reason: 'button',
              createdAt: '2026-10-07T09:00:00.000Z',
              status: { phase: 'waiting_for_notes', cause: 'meeting' },
            }
          : null;
      },
      cancel: (meetingId) => {
        cancels.push(meetingId);
        if (refusal !== null) return Promise.reject(refusal);
        generates.delete(meetingId);
        return Promise.resolve();
      },
    },
    logger,
  });
  /** A meeting Stop ended: still pending in the uploader, with `lines` lines. */
  const ended = (meetingId: string, lineCount = 0): void => {
    transcripts.createMeeting({
      id: meetingId,
      title: 'Standup',
      startedAt: '2026-10-07T09:00:00Z',
    });
    for (let n = 1; n <= lineCount; n += 1) {
      transcripts.appendSegment({
        id: `${meetingId.slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`,
        meetingId,
        source: 'mic',
        speaker: 'me',
        startMs: n * 1000,
        endMs: n * 1000 + 500,
        text: `line ${n}`,
        confidence: null,
        words: null,
        createdAt: '2026-10-07T09:00:00.000Z',
      });
    }
    transcripts.markMeetingEnded(meetingId, '2026-10-07T09:30:00.000Z');
  };
  return {
    kept,
    transcripts,
    generates,
    cancels,
    ended,
    /** CaptureService telling its listeners how Stop went. */
    stopped: (meetingId: string, outcome: Partial<RecordingEnded> = {}) => {
      for (const listener of recordingListeners) {
        listener.ended?.({
          meetingId,
          reason: 'user',
          discarded: false,
          stopFailed: false,
          ...outcome,
        });
      }
    },
    /** The uploader ending a tick. */
    uploaded: () => {
      for (const listener of statusListeners) listener();
    },
    refuseCancels: (error: Error) => {
      refusal = error;
    },
    failReads: (count: number) => {
      failedReads = count;
    },
    listening: () => recordingListeners.size + statusListeners.size,
    logged: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('KeptSilentMeetings', () => {
  it('drops the generate of a kept silent meeting once the uploader discards it, once', () => {
    const h = keptSetUp({ generates: [KEPT] });
    h.kept.start();
    h.ended(KEPT);
    h.stopped(KEPT);
    // A tick that has not decided it yet (it waits for notes.sqlite, or for a backoff).
    h.uploaded();
    expect(h.cancels).toEqual([]);

    expect(h.transcripts.deleteMeetingIfEmpty(KEPT)).toBe(true);
    h.uploaded();
    h.uploaded();

    expect(h.cancels).toEqual([KEPT]);
    expect(h.generates.size).toBe(0);
    expect(h.logged()).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'pending generate dropped: its meeting was discarded as empty',
        meetingId: KEPT,
      }),
    );
  });

  it('lets a kept meeting go once the uploader created it, or it has a line', () => {
    const h = keptSetUp({ generates: [KEPT, SPOKEN] });
    h.kept.start();
    h.ended(KEPT);
    h.ended(SPOKEN);
    h.stopped(KEPT);
    h.stopped(SPOKEN);
    // Kept for its notes and created in Postgres; the other got a line (a gap re-run).
    h.transcripts.setMeetingRemoteState(KEPT, 'created');
    h.transcripts.appendSegment({
      id: '6e3d8b21-0000-4000-8000-000000000001',
      meetingId: SPOKEN,
      source: 'system',
      speaker: 'them',
      startMs: 0,
      endMs: 500,
      text: 'Morning all',
      confidence: null,
      words: null,
      createdAt: '2026-10-07T09:00:00.000Z',
    });
    h.uploaded();
    // Neither is followed any more: a delete now (none can come) would cancel nothing.
    h.transcripts.setMeetingRemoteState(KEPT, 'pending');
    h.transcripts.deleteMeetingIfEmpty(KEPT);
    h.uploaded();

    expect(h.cancels).toEqual([]);
  });

  it('follows neither a meeting Stop discarded, nor one whose Stop failed, nor one with a line', () => {
    const h = keptSetUp({ generates: [KEPT, SPOKEN] });
    h.kept.start();
    h.ended(KEPT);
    h.ended(SPOKEN, 2);
    // NotesGenerator drops a discarded meeting's generate itself; a failed Stop's meeting may be
    // open, for CrashRecovery to decide.
    h.stopped(KEPT, { discarded: true });
    h.stopped(KEPT, { stopFailed: true });
    h.stopped(SPOKEN);
    h.transcripts.deleteMeetingIfEmpty(KEPT);
    h.uploaded();

    expect(h.cancels).toEqual([]);
  });

  it('follows from launch a silent meeting an earlier launch kept with a generate', () => {
    const h = keptSetUp({ generates: [KEPT, SPOKEN] });
    // Kept by a quit's Stop, which uploads nothing; the first tick of this launch decides it.
    h.ended(KEPT);
    h.ended(SPOKEN, 1);
    h.kept.start();
    h.transcripts.deleteMeetingIfEmpty(KEPT);
    h.uploaded();

    expect(h.cancels).toEqual([KEPT]);
  });

  it('cancels nothing for a discarded meeting with no generate, and logs a refused cancel', async () => {
    const h = keptSetUp({ generates: [SPOKEN] });
    h.kept.start();
    h.ended(KEPT);
    h.ended(SPOKEN);
    h.stopped(KEPT);
    h.stopped(SPOKEN);
    h.refuseCancels(new Error('POST run cancel failed'));
    h.transcripts.deleteMeetingIfEmpty(KEPT);
    h.transcripts.deleteMeetingIfEmpty(SPOKEN);
    h.uploaded();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.cancels).toEqual([SPOKEN]);
    expect(h.logged()).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'pending generate of a discarded meeting not dropped',
        meetingId: SPOKEN,
        error: 'POST run cancel failed',
      }),
    );
  });

  it('checks again at the next status a discarded meeting whose generate could not be read', () => {
    const h = keptSetUp({ generates: [KEPT] });
    h.kept.start();
    h.ended(KEPT);
    h.stopped(KEPT);
    h.transcripts.deleteMeetingIfEmpty(KEPT);
    h.failReads(1);
    h.uploaded();
    expect(h.cancels).toEqual([]);
    expect(h.logged()).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'kept meeting not checked',
        meetingId: KEPT,
        error: 'database is locked',
      }),
    );

    h.uploaded();
    expect(h.cancels).toEqual([KEPT]);
  });

  it('stops listening at quit', () => {
    const h = keptSetUp({ generates: [KEPT] });
    h.kept.start();
    h.ended(KEPT);
    h.stopped(KEPT);
    h.kept.stop();

    expect(h.listening()).toBe(0);
  });
});
