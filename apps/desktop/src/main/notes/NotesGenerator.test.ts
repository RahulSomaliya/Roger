import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotesStreamMessage, PendingGenerateChange } from '../../shared/ipc/notes';
import type { LlmRun, LlmRunStatus, Note, NoteDoc, NoteKind } from '../../shared/notes';
import type { NotesWhenUnsure } from '../../shared/preferences';
import { templateTitleKey } from '../../shared/suggestTemplate';
import type { TranscriptSegment } from '../../shared/transcript';
import { ApiError } from '../api/http';
import type {
  LlmRunSummary,
  NotesClient,
  NotesSyncApi,
  PutNoteRequest,
  ServerNotes,
} from '../api/notesClient';
import {
  defaultMeetingTitle,
  type RecordingEnded,
  type RecordingListener,
} from '../capture/CaptureService';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import type { LlmStreams, NotesStreamRequest, StreamEnd, StreamWindow } from './LlmStreams';
import { NOTES_RECHECK_MS, NotesGenerator } from './NotesGenerator';
import { NotesSync } from './NotesSync';
import { SqliteNotesStore } from './SqliteNotesStore';

const MEETING = '0b8e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_MEETING = '5f4e3d2c-1b0a-4f9e-8d7c-6b5a4f3e2d1c';
const RUN_IDS = [
  '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
  'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f',
  'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b',
] as const;
const [RUN_1, RUN_2] = RUN_IDS;
const T0 = Date.parse('2026-10-06T10:00:00.000Z');

const silentLogger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

function paragraphs(...lines: string[]): NoteDoc {
  return {
    type: 'doc',
    content: lines.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
  };
}

function note(kind: NoteKind, version: number, doc: NoteDoc, runId: string | null = null): Note {
  return {
    kind,
    doc,
    version,
    templateId: runId === null ? null : 'standup',
    lastRunId: runId,
    generatedVersion: runId === null ? null : version,
    updatedAt: '2026-10-06T09:00:00Z',
  };
}

function segment(meetingId: string, n: number): TranscriptSegment {
  return {
    id: `${meetingId.slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`,
    meetingId,
    source: n % 2 === 0 ? 'mic' : 'system',
    speaker: n % 2 === 0 ? 'me' : 'them',
    startMs: n * 1000,
    endMs: n * 1000 + 500,
    text: `line ${n}`,
    confidence: null,
    words: null,
    createdAt: '2026-10-06T09:30:00.000Z',
  };
}

function aRun(
  runId: string,
  status: LlmRunStatus,
  error?: { code: string; message: string },
): LlmRun {
  return {
    id: runId,
    meetingId: MEETING,
    kind: 'notes',
    status,
    model: 'fake',
    templateId: 'standup',
    errorCode: error?.code ?? null,
    error: error?.message ?? null,
    dropped: [],
    flaggedCount: 0,
    fromNotesCount: 0,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    costUsd: null,
    startedAt: '2026-10-06T10:00:00.000Z',
    finishedAt: status === 'running' ? null : '2026-10-06T10:00:30.000Z',
    outputDoc: null,
    replacedDoc: null,
  };
}

/**
 * The notes routes NotesSync uses, as the API answers them: a `PUT` on a stale base version is a
 * `409`, a re-sent revision the stored note. Every call goes into the shared log, so a test reads
 * the order of uploads and generate requests.
 */
class FakeNotesApi implements NotesSyncApi {
  down = false;
  private readonly stored = new Map<string, { note: Note; revisionId: string | null }>();

  constructor(private readonly log: string[]) {}

  seed(meetingId: string, seeded: Note): void {
    this.stored.set(`${meetingId}/${seeded.kind}`, { note: seeded, revisionId: null });
  }

  getNotes(meetingId: string): Promise<ServerNotes> {
    this.log.push('GET notes');
    this.refuse();
    return Promise.resolve({
      user: this.stored.get(`${meetingId}/user`)?.note ?? null,
      ai: this.stored.get(`${meetingId}/ai`)?.note ?? null,
    });
  }

  putNote(meetingId: string, kind: NoteKind, request: PutNoteRequest): Promise<Note> {
    this.log.push(`PUT ${kind} base=${request.baseVersion}`);
    this.refuse();
    const key = `${meetingId}/${kind}`;
    const current = this.stored.get(key);
    if (current?.revisionId === request.revisionId) return Promise.resolve(current.note);
    const version = current?.note.version ?? 0;
    if (request.baseVersion !== version) {
      throw new ApiError(409, 'conflict', `Note version ${version} is stored`);
    }
    const stored = note(kind, version + 1, request.doc);
    this.stored.set(key, { note: stored, revisionId: request.revisionId });
    return Promise.resolve(stored);
  }

  private refuse(): void {
    if (this.down) throw new ApiError(0, 'network_error', 'The API did not answer');
  }
}

/** One notes stream the generator opened; the test ends it. */
interface StreamCall {
  request: NotesStreamRequest;
  window: StreamWindow | null;
  end: (end: StreamEnd<Note>) => void;
}

/** LlmStreams with the API's side played by the test. */
class FakeStreams implements Pick<LlmStreams, 'streamNotes' | 'cancelNotes'> {
  readonly calls: StreamCall[] = [];
  readonly cancels: string[] = [];

  constructor(private readonly log: string[]) {}

  streamNotes(request: NotesStreamRequest, window: StreamWindow | null): Promise<StreamEnd<Note>> {
    this.log.push(
      `generate run=${request.runId} template=${request.templateId} ` +
        `user=${request.userNotesVersion} ai=${request.aiBaseVersion}`,
    );
    return new Promise((resolve) => {
      this.calls.push({ request, window, end: resolve });
    });
  }

  cancelNotes(meetingId: string): Promise<boolean> {
    this.cancels.push(meetingId);
    return Promise.resolve(true);
  }

  last(): StreamCall {
    const call = this.calls.at(-1);
    if (call === undefined) throw new Error('no notes stream was opened');
    return call;
  }
}

/**
 * `GET` and cancel of one run. `GET` answers from `answers`, in order, then repeats the last;
 * cancel answers the run in `cancelAnswer`'s status (the run beat the cancel when not
 * `cancelled`), or fails with it.
 */
class FakeRuns implements Pick<NotesClient, 'getRun' | 'cancelRun'> {
  answers: (LlmRun | ApiError)[] = [];
  cancelAnswer: LlmRunStatus | ApiError = 'cancelled';
  readonly cancels: string[] = [];

  constructor(private readonly log: string[]) {}

  getRun(_meetingId: string, runId: string): Promise<LlmRun> {
    this.log.push(`GET run ${runId}`);
    const answer = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
    if (answer === undefined) throw new Error('the test gave no answer for GET run');
    if (answer instanceof ApiError) return Promise.reject(answer);
    return Promise.resolve(answer);
  }

  cancelRun(_meetingId: string, runId: string): Promise<LlmRunSummary> {
    this.log.push(`cancel run ${runId}`);
    this.cancels.push(runId);
    const answer = this.cancelAnswer;
    if (answer instanceof ApiError) return Promise.reject(answer);
    return Promise.resolve(aRun(runId, answer));
  }
}

function fakeWindow() {
  const sent: NotesStreamMessage[] = [];
  const window: StreamWindow = {
    id: 1,
    isDestroyed: () => false,
    send: (_channel, payload) => {
      sent.push(payload as NotesStreamMessage);
    },
    once: () => undefined,
  };
  return { window, sent };
}

interface HarnessOptions {
  /** notes.sqlite on disk, to reopen it as the next launch would. */
  storePath?: string;
  title?: string;
  /** Unsynced lines the meeting holds at the start. */
  waitingLines?: number;
  remoteState?: 'pending' | 'created' | 'ended';
  /** MEETING is still recording: no end in roger.sqlite, and created (not ended) in Postgres. */
  recording?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const log: string[] = [];
  const clock = (): Date => new Date(Date.now());
  let revision = 0;
  const store = new SqliteNotesStore(options.storePath ?? ':memory:', {
    clock,
    newRevisionId: () => `rev-${++revision}`,
  });
  const transcripts = new InMemoryTranscriptStore(clock);
  for (const meetingId of [MEETING, OTHER_MEETING]) {
    transcripts.createMeeting({
      id: meetingId,
      title: options.title ?? 'Acme client call',
      startedAt: '2026-10-06T09:30:00.000Z',
    });
    if (options.recording === true && meetingId === MEETING) {
      transcripts.setMeetingRemoteState(meetingId, 'created');
      continue;
    }
    transcripts.markMeetingEnded(meetingId, '2026-10-06T09:59:00.000Z');
    transcripts.setMeetingRemoteState(meetingId, options.remoteState ?? 'ended');
  }
  for (let n = 1; n <= (options.waitingLines ?? 0); n += 1) {
    transcripts.appendSegment(segment(MEETING, n));
  }
  const uploadListeners = new Set<() => void>();
  const uploads = {
    onStatus: (listener: () => void) => {
      uploadListeners.add(listener);
      return () => {
        uploadListeners.delete(listener);
      };
    },
  };
  const api = new FakeNotesApi(log);
  const sync = new NotesSync({
    store,
    api,
    meetings: {
      remoteState: (meetingId) => transcripts.getMeeting(meetingId)?.remoteState ?? null,
      onChange: (listener) => uploads.onStatus(listener),
    },
    onMeetingMissing: () => undefined,
    logger: silentLogger,
    clock,
  });
  const streams = new FakeStreams(log);
  const runs = new FakeRuns(log);
  const recordingListeners = new Set<RecordingListener>();
  const recordings = {
    onRecording: (listener: RecordingListener) => {
      recordingListeners.add(listener);
      return () => {
        recordingListeners.delete(listener);
      };
    },
  };
  const preferences = { autoGenerate: true, whenUnsure: 'ask' as NotesWhenUnsure };
  const page = fakeWindow();
  let runIds = 0;
  const generator = new NotesGenerator({
    store,
    sync,
    streams,
    api: runs,
    transcripts,
    uploads,
    recordings,
    preferences: {
      autoGenerate: () => preferences.autoGenerate,
      whenUnsure: () => preferences.whenUnsure,
    },
    window: () => page.window,
    logger: silentLogger,
    clock,
    newRunId: () => {
      const runId = RUN_IDS[runIds];
      runIds += 1;
      if (runId === undefined) throw new Error('the test ran out of run ids');
      return runId;
    },
  });
  const changes: PendingGenerateChange[] = [];
  generator.onPendingChanged((change) => changes.push(change));
  return {
    log,
    store,
    transcripts,
    api,
    sync,
    streams,
    runs,
    preferences,
    page,
    generator,
    changes,
    /** An uploader status event. */
    uploaderStatus: () => {
      for (const listener of uploadListeners) listener();
    },
    /** CaptureService telling its listeners a recording ended. */
    stop: (ended: Partial<RecordingEnded> = {}) => {
      const recording: RecordingEnded = {
        meetingId: MEETING,
        reason: 'user',
        discarded: false,
        stopFailed: false,
        ...ended,
      };
      for (const listener of recordingListeners) listener.ended?.(recording);
    },
  };
}

/** A promise the test resolves: `open()` lets whatever waits on `wait` go on. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Lets every promise chain that waits on no timer run to its end. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function syncAll(transcripts: InMemoryTranscriptStore, meetingId: string): void {
  const ids = transcripts.listUnsyncedSegments(meetingId, 1_000).map((line) => line.id);
  transcripts.markSegmentsSynced(ids, new Date(Date.now()).toISOString());
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NotesGenerator: after Stop', () => {
  it('Stop with auto-generate on writes one pending row with a run id', () => {
    // A line still to upload keeps the generate waiting, so only the row is under test here.
    const h = harness({ waitingLines: 1 });
    h.generator.start();

    h.stop();

    expect(h.store.listPendingGenerates()).toEqual([
      {
        meetingId: MEETING,
        runId: RUN_1,
        // The title rule: "Acme client call".
        templateId: 'client_call',
        reason: 'after_stop',
        createdAt: new Date(T0).toISOString(),
        lastError: null,
      },
    ]);
    expect(h.changes).toEqual([
      {
        meetingId: MEETING,
        pending: {
          meetingId: MEETING,
          runId: RUN_1,
          templateId: 'client_call',
          reason: 'after_stop',
          createdAt: new Date(T0).toISOString(),
          status: { phase: 'waiting_for_lines', waitingLines: 1 },
        },
      },
    ]);

    // A second Stop of the same meeting (a resume) keeps the row and its run id: an attempt may
    // already have reached the API, and a new id would pay for a second run.
    h.stop();
    expect(h.store.listPendingGenerates().map((row) => row.runId)).toEqual([RUN_1]);
    expect(h.log).toEqual([]);
  });

  it('writes nothing when auto-generate is off, or the meeting was discarded or did not stop', () => {
    const h = harness({ waitingLines: 1 });
    h.generator.start();

    h.preferences.autoGenerate = false;
    h.stop();
    h.preferences.autoGenerate = true;
    // Its meeting may still be open: CrashRecovery decides at the next launch.
    h.stop({ meetingId: OTHER_MEETING, stopFailed: true });
    expect(h.store.listPendingGenerates()).toEqual([]);

    // A discarded meeting is gone: a row for it (the Generate button during a recording, waiting
    // for its line) would never run, and is deleted.
    h.transcripts.appendSegment(segment(OTHER_MEETING, 1));
    h.generator.generate(OTHER_MEETING, 'standup');
    h.stop({ meetingId: OTHER_MEETING, discarded: true });
    expect(h.store.listPendingGenerates()).toEqual([]);
    expect(h.changes.at(-1)).toEqual({ meetingId: OTHER_MEETING, pending: null });
  });

  it('asks for a template when no rule applies', async () => {
    const h = harness({ title: defaultMeetingTitle(new Date(T0)) });
    h.generator.start();

    h.stop();

    expect(h.generator.getPending(MEETING)).toMatchObject({
      runId: RUN_1,
      templateId: null,
      status: { phase: 'needs_template' },
    });
    await settle();
    // Nothing is flushed or sent until the user picks.
    expect(h.log).toEqual([]);

    // The pick keeps the run id and the reason, and runs.
    expect(h.generator.generate(MEETING, 'one_on_one')).toMatchObject({
      runId: RUN_1,
      templateId: 'one_on_one',
      reason: 'after_stop',
      status: { phase: 'running' },
    });
    await settle();
    expect(h.streams.last().request).toMatchObject({ runId: RUN_1, templateId: 'one_on_one' });
  });

  it('uses General when Roger cannot tell and the preference says so', () => {
    const h = harness({ title: defaultMeetingTitle(new Date(T0)), waitingLines: 1 });
    h.generator.start();
    h.preferences.whenUnsure = 'general';

    h.stop();

    expect(h.store.getPendingGenerate(MEETING)?.templateId).toBe('general');
  });

  it('remembers a pick under the title, and suggests it at the next Stop', () => {
    const h = harness({ title: 'Weekly sync', waitingLines: 1 });
    h.generator.start();

    h.generator.generate(MEETING, 'one_on_one');
    expect(h.store.getTemplateChoice('weekly sync')).toBe('one_on_one');

    h.stop({ meetingId: OTHER_MEETING });
    expect(h.store.getPendingGenerate(OTHER_MEETING)?.templateId).toBe('one_on_one');
  });

  it('never remembers a pick for the title main gives a manual start', () => {
    // `defaultMeetingTitle` (CaptureService.ts) and the pattern in shared/suggestTemplate.ts must
    // agree, in every month: a remembered pick under a title no other meeting will have is noise.
    for (let month = 0; month < 12; month += 1) {
      const title = defaultMeetingTitle(new Date(Date.UTC(2026, month, 15, 9, 30)));
      expect(templateTitleKey(title), title).toBeNull();
    }
  });
});

describe('NotesGenerator: preconditions', () => {
  it('waits while lines are waiting and reports the count', async () => {
    const h = harness({ waitingLines: 11 });
    // A mic line held for its call-audio twin is not uploadable yet, and still waits.
    h.transcripts.appendSegment(segment(MEETING, 12));
    h.transcripts.holdSegment(segment(MEETING, 12).id, '2026-10-06T10:02:00.000Z');
    h.generator.start();

    expect(h.generator.generate(MEETING, 'standup').status).toEqual({
      phase: 'waiting_for_lines',
      waitingLines: 12,
    });
    await settle();
    expect(h.log).toEqual([]);

    const lines = h.transcripts.listUnsyncedSegments(MEETING, 100).map((line) => line.id);
    h.transcripts.markSegmentsSynced(lines.slice(0, 10), new Date(T0).toISOString());
    h.uploaderStatus();
    expect(h.changes.at(-1)?.pending?.status).toEqual({
      phase: 'waiting_for_lines',
      waitingLines: 2,
    });

    syncAll(h.transcripts, MEETING);
    h.transcripts.releaseSegments([segment(MEETING, 12).id]);
    syncAll(h.transcripts, MEETING);
    h.uploaderStatus();
    await settle();

    expect(h.streams.calls).toHaveLength(1);
    expect(h.generator.getPending(MEETING)?.status).toEqual({ phase: 'running' });
  });

  it('an echo-suppressed line does not block generate', async () => {
    const h = harness({ waitingLines: 2 });
    const [said, echo] = h.transcripts.listUnsyncedSegments(MEETING, 10);
    h.transcripts.markSegmentsSynced([said!.id], new Date(T0).toISOString());
    // Hidden as an echo of call audio: it never uploads, so it never counts as waiting.
    expect(h.transcripts.suppressSegment(echo!.id, 'echo', said!.id)).toBe(true);
    h.generator.start();

    h.generator.generate(MEETING, 'standup');
    await settle();

    expect(h.streams.calls).toHaveLength(1);
  });

  it('holds a generate pressed during the recording until Stop', async () => {
    for (const autoGenerate of [true, false]) {
      const h = harness({ recording: true });
      h.preferences.autoGenerate = autoGenerate;
      h.generator.start();

      // Mid-call, every line so far is up between two upload batches: a run now would write up
      // part of the call, and Stop would keep its row, so nothing would ever cover the rest.
      expect(h.generator.generate(MEETING, 'standup').status, `auto ${autoGenerate}`).toEqual({
        phase: 'waiting_for_notes',
        cause: 'meeting',
      });
      h.uploaderStatus();
      await vi.advanceTimersByTimeAsync(NOTES_RECHECK_MS);
      expect(h.log, `auto ${autoGenerate}`).toEqual([]);

      // Stop ends the meeting before it tells its listeners: the same row runs on the whole call.
      h.transcripts.markMeetingEnded(MEETING, new Date(Date.now()).toISOString());
      h.stop();
      await settle();
      expect(
        h.streams.calls.map((call) => call.request.runId),
        `auto ${autoGenerate}`,
      ).toEqual([RUN_1]);
      h.generator.stop();
    }
  });

  it('waits for the meeting to be created in Postgres', async () => {
    const h = harness({ remoteState: 'pending' });
    h.generator.start();

    expect(h.generator.generate(MEETING, 'standup').status).toEqual({
      phase: 'waiting_for_notes',
      cause: 'meeting',
    });
    await settle();
    expect(h.log).toEqual([]);

    h.transcripts.setMeetingRemoteState(MEETING, 'ended');
    h.uploaderStatus();
    await settle();
    expect(h.streams.calls).toHaveLength(1);
  });

  it('flushes dirty user and AI notes before generating', async () => {
    const h = harness();
    h.api.seed(MEETING, note('ai', 2, paragraphs('ai v2'), RUN_2));
    h.store.applyServerNote(MEETING, note('ai', 2, paragraphs('ai v2'), RUN_2));
    h.store.saveLocal(MEETING, 'ai', paragraphs('ai v2, edited'));
    h.store.saveLocal(MEETING, 'user', paragraphs('typed in the last seconds'));
    h.generator.start();

    h.generator.generate(MEETING, 'standup');
    await settle();

    expect(h.log).toEqual([
      'PUT user base=0',
      'PUT ai base=2',
      `generate run=${RUN_1} template=standup user=1 ai=3`,
    ]);
    expect(h.store.getNote(MEETING, 'user')?.dirty).toBe(false);
    expect(h.store.getNote(MEETING, 'ai')?.dirty).toBe(false);
  });

  it('sends both versions with the request', async () => {
    const h = harness();
    h.store.applyServerNote(MEETING, note('user', 4, paragraphs('my notes')));
    h.generator.start();

    h.generator.generate(MEETING, 'client_call');
    await settle();

    expect(h.streams.last().request).toEqual({
      meetingId: MEETING,
      runId: RUN_1,
      templateId: 'client_call',
      userNotesVersion: 4,
      // No AI notes yet.
      aiBaseVersion: 0,
    });
    // To the window that shows notes runs.
    expect(h.streams.last().window).toBe(h.page.window);
  });

  it('does not start while notes cannot upload and says why', async () => {
    const h = harness();
    h.api.down = true;
    h.store.saveLocal(MEETING, 'user', paragraphs('offline notes'));
    h.generator.start();

    h.generator.generate(MEETING, 'standup');
    await settle();
    expect(h.generator.getPending(MEETING)?.status).toEqual({
      phase: 'waiting_for_notes',
      cause: 'offline',
    });

    // A conflict copy holds the run back until the user picks.
    h.store.saveLocal(OTHER_MEETING, 'user', paragraphs('mine'));
    h.store.applyServerNote(OTHER_MEETING, note('user', 3, paragraphs('theirs')));
    h.generator.generate(OTHER_MEETING, 'standup');
    await settle();
    expect(h.generator.getPending(OTHER_MEETING)?.status).toEqual({
      phase: 'waiting_for_notes',
      cause: 'conflict',
    });

    expect(h.streams.calls).toEqual([]);
  });

  it("re-checks on changes that can unblock a run, never on its own flush's", async () => {
    const h = harness();
    h.api.down = true;
    h.store.saveLocal(MEETING, 'user', paragraphs('offline notes'));
    const flushes = vi.spyOn(h.sync, 'flushMeeting');
    h.sync.start();
    h.generator.start();

    h.generator.generate(MEETING, 'standup');
    await settle();
    // Each attempt writes the note's sync state twice (syncing, offline), and each write is a
    // note change: re-checking on those would flush again, and again.
    expect(flushes).toHaveBeenCalledTimes(1);
    expect(h.log).toEqual(['PUT user base=0']);

    // NotesSync's own retry fails too (syncing, offline): nothing there can unblock the run.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.log).toEqual(['PUT user base=0', 'PUT user base=0']);
    expect(flushes).toHaveBeenCalledTimes(1);

    // The API is back: NotesSync's next retry stores the note, which unblocks the run.
    h.api.down = false;
    await vi.advanceTimersByTimeAsync(4_000);
    await settle();
    expect(flushes).toHaveBeenCalledTimes(2);
    expect(h.log.slice(-2)).toEqual([
      'PUT user base=0',
      `generate run=${RUN_1} template=standup user=1 ai=0`,
    ]);
    h.sync.stop();
  });
});

describe('NotesGenerator: the run', () => {
  it('done updates notes.sqlite through applyServerNote', async () => {
    const h = harness();
    h.store.applyServerNote(MEETING, note('ai', 1, paragraphs('previous notes'), RUN_2));
    h.generator.start();
    h.generator.generate(MEETING, 'standup');
    await settle();

    h.streams.last().end({ kind: 'done', result: note('ai', 2, paragraphs('new notes'), RUN_1) });
    await settle();

    expect(h.store.getNote(MEETING, 'ai')).toMatchObject({
      doc: paragraphs('new notes'),
      baseVersion: 2,
      lastRunId: RUN_1,
      generatedVersion: 2,
      dirty: false,
    });
    expect(h.store.listPendingGenerates()).toEqual([]);
    expect(h.generator.getPending(MEETING)).toBeNull();
    expect(h.changes.at(-1)).toEqual({ meetingId: MEETING, pending: null });
  });

  it('a pending generate survives a restart and fires exactly once', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'roger-notes-generator-')), 'notes.sqlite');
    const first = harness({ storePath: path });
    first.generator.start();
    first.stop();
    await settle();
    // Roger quits while the run streams: the run goes on in the API.
    expect(first.streams.calls.map((call) => call.request.runId)).toEqual([RUN_1]);
    first.generator.stop();
    first.store.close();

    const next = harness({ storePath: path });
    next.generator.start();
    await settle();

    // The same run id: the API attaches to the run or replays its stored result.
    expect(next.streams.calls.map((call) => call.request.runId)).toEqual([RUN_1]);
    next.streams.last().end({ kind: 'done', result: note('ai', 1, paragraphs('notes'), RUN_1) });
    await settle();
    expect(next.store.listPendingGenerates()).toEqual([]);

    await vi.advanceTimersByTimeAsync(NOTES_RECHECK_MS * 3);
    next.uploaderStatus();
    await settle();
    expect(next.streams.calls).toHaveLength(1);
    next.generator.stop();
    next.store.close();
  });

  it('a retry re-sends the same run id', async () => {
    const h = harness();
    h.generator.start();
    h.generator.generate(MEETING, 'standup');
    await settle();

    // The API was not reached: the run may or may not exist, so its id is kept.
    h.streams.last().end({
      kind: 'error',
      code: 'network_error',
      message: 'The API did not answer',
      status: 0,
    });
    await settle();
    expect(h.store.getPendingGenerate(MEETING)).toMatchObject({ runId: RUN_1, lastError: null });
    expect(h.generator.getPending(MEETING)?.status).toEqual({
      phase: 'waiting_for_notes',
      cause: 'offline',
    });

    // Not on every uploader tick: the next try waits for the 30 s re-check.
    h.uploaderStatus();
    await settle();
    expect(h.streams.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(NOTES_RECHECK_MS);
    expect(h.streams.calls.map((call) => call.request.runId)).toEqual([RUN_1, RUN_1]);

    // A server error before the stream, then the Generate button on the waiting row: same id.
    h.streams.last().end({ kind: 'error', code: 'internal_error', message: 'Oops', status: 503 });
    await settle();
    expect(h.generator.generate(MEETING, 'general')).toMatchObject({
      runId: RUN_1,
      templateId: 'general',
      reason: 'button',
    });
    await settle();
    expect(h.streams.calls.map((call) => call.request.runId)).toEqual([RUN_1, RUN_1, RUN_1]);
  });

  it('a stream that ends without done polls the run and loads the notes', async () => {
    const h = harness();
    h.api.seed(MEETING, note('ai', 1, paragraphs('generated notes'), RUN_1));
    h.generator.start();
    h.generator.generate(MEETING, 'standup');
    await settle();
    h.runs.answers = [
      ...Array.from({ length: 6 }, () => aRun(RUN_1, 'running')),
      aRun(RUN_1, 'succeeded'),
    ];

    h.streams.last().end({ kind: 'dropped', runId: RUN_1, cause: 'network_error' });
    await settle();
    expect(h.generator.getPending(MEETING)?.status).toEqual({ phase: 'running' });

    // Every 2 s for 10 s, then every 5 s.
    const polls = (): number => h.log.filter((line) => line === `GET run ${RUN_1}`).length;
    await vi.advanceTimersByTimeAsync(1_999);
    expect(polls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(polls()).toBe(5);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(polls()).toBe(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(6);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls()).toBe(7);

    // Succeeded: the notes are loaded into notes.sqlite (which the page hears as a note change)
    // and the pending generate ends. No event is made up for the page: only the API sends them.
    expect(h.log.at(-1)).toBe('GET notes');
    expect(h.store.getNote(MEETING, 'ai')).toMatchObject({
      doc: paragraphs('generated notes'),
      lastRunId: RUN_1,
      dirty: false,
    });
    expect(h.store.listPendingGenerates()).toEqual([]);
    expect(h.changes.at(-1)).toEqual({ meetingId: MEETING, pending: null });
    expect(h.page.sent).toEqual([]);
  });

  it('a poll that finds the run failed tells the page and ends or keeps the generate', async () => {
    const h = harness();
    h.generator.start();
    h.generator.generate(MEETING, 'standup');
    await settle();
    h.runs.answers = [
      aRun(RUN_1, 'failed', { code: 'cut_off', message: 'The notes were cut off' }),
    ];

    h.streams.last().end({ kind: 'dropped', runId: RUN_1, cause: 'stream_ended' });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.store.listPendingGenerates()).toEqual([]);
    expect(h.page.sent.at(-1)).toEqual({
      meetingId: MEETING,
      runId: RUN_1,
      event: { type: 'error', code: 'cut_off', message: 'The notes were cut off' },
    });

    // llm_provider_error keeps it for Retry.
    h.generator.generate(MEETING, 'standup');
    await settle();
    h.runs.answers = [
      aRun(RUN_2, 'failed', { code: 'llm_provider_error', message: 'The model is away' }),
    ];
    h.streams.last().end({ kind: 'dropped', runId: RUN_2, cause: 'stream_ended' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.generator.getPending(MEETING)?.status).toEqual({
      phase: 'failed',
      code: 'llm_provider_error',
      message: 'The model is away',
    });
  });

  it('stops polling a run that stays running and re-attaches with the same run id', async () => {
    const h = harness();
    h.generator.start();
    h.generator.generate(MEETING, 'standup');
    await settle();
    h.runs.answers = [aRun(RUN_1, 'running')];

    h.streams.last().end({ kind: 'dropped', runId: RUN_1, cause: 'network_error' });
    // Two minutes of polls, then the next 30 s re-check re-sends the id.
    await vi.advanceTimersByTimeAsync(2 * 60_000 + NOTES_RECHECK_MS);

    expect(h.streams.calls.map((call) => call.request.runId)).toEqual([RUN_1, RUN_1]);
    const polls = h.log.filter((line) => line === `GET run ${RUN_1}`).length;
    expect(polls).toBeGreaterThan(20);
    expect(polls).toBeLessThan(30);
  });

  it('llm_provider_error keeps the pending generate for Retry, which takes a new run id', async () => {
    const h = harness();
    h.generator.start();
    h.generator.generate(MEETING, 'standup');
    await settle();

    h.streams.last().end({
      kind: 'error',
      code: 'llm_provider_error',
      message: 'The notes model did not answer',
      status: null,
    });
    await settle();
    expect(h.generator.getPending(MEETING)).toMatchObject({
      runId: RUN_1,
      status: {
        phase: 'failed',
        code: 'llm_provider_error',
        message: 'The notes model did not answer',
      },
    });
    // It waits for Retry: no re-check sends it again.
    await vi.advanceTimersByTimeAsync(NOTES_RECHECK_MS);
    expect(h.streams.calls).toHaveLength(1);

    // Retry: the API would replay the stored failure to RUN_1.
    expect(h.generator.generate(MEETING, 'standup')).toMatchObject({
      runId: RUN_2,
      reason: 'button',
      status: { phase: 'running' },
    });
    await settle();
    expect(h.streams.last().request.runId).toBe(RUN_2);
  });

  it('ends the pending generate on cancelled and on errors Retry cannot fix', async () => {
    const endings: StreamEnd<Note>[] = [
      { kind: 'error', code: 'cancelled', message: 'Cancelled.', status: null },
      { kind: 'error', code: 'cut_off', message: 'Cut off.', status: null },
      { kind: 'error', code: 'internal_error', message: 'Failed.', status: null },
      { kind: 'error', code: 'empty_meeting', message: 'Nothing to write up.', status: 422 },
      { kind: 'error', code: 'not_found', message: 'No such meeting.', status: 404 },
    ];
    for (const ending of endings) {
      const h = harness();
      h.generator.start();
      h.generator.generate(MEETING, 'standup');
      await settle();

      h.streams.last().end(ending);
      await settle();

      expect(h.store.listPendingGenerates(), ending.kind === 'error' ? ending.code : '').toEqual(
        [],
      );
      h.generator.stop();
    }
  });

  it('keeps the pending generate on a refusal a later try may fix', async () => {
    // A token the API no longer takes (rotated, or the API restarted with another one): the user
    // fixes it and relaunches, and the after-Stop generate must still be there to run.
    const refusals: StreamEnd<Note>[] = [
      { kind: 'error', code: 'unauthorized', message: 'Bad token.', status: 401 },
      { kind: 'error', code: 'forbidden', message: 'Not allowed.', status: 403 },
      { kind: 'error', code: 'rate_limited', message: 'Slow down.', status: 429 },
    ];
    for (const refusal of refusals) {
      const label = refusal.kind === 'error' ? refusal.code : '';
      const h = harness();
      h.generator.start();
      h.generator.generate(MEETING, 'standup');
      await settle();

      h.streams.last().end(refusal);
      await settle();

      expect(h.store.getPendingGenerate(MEETING), label).toMatchObject({
        runId: RUN_1,
        lastError: null,
      });
      expect(h.generator.getPending(MEETING)?.status, label).toEqual({
        phase: 'waiting_for_notes',
        cause: 'offline',
      });
      // As after an unreachable API: the 30 s re-check sends the same run id.
      await vi.advanceTimersByTimeAsync(NOTES_RECHECK_MS);
      expect(
        h.streams.calls.map((call) => call.request.runId),
        label,
      ).toEqual([RUN_1, RUN_1]);
      h.generator.stop();
    }
  });

  it('on a stale-version 409 it pulls the notes, flushes again and retries once', async () => {
    const h = harness();
    // Postgres holds AI notes this Mac never pulled: the flush answers aiBaseVersion 0.
    h.api.seed(MEETING, note('ai', 3, paragraphs('ai notes from elsewhere'), RUN_2));
    h.generator.start();
    h.generator.generate(MEETING, 'standup');
    await settle();
    expect(h.streams.last().request.aiBaseVersion).toBe(0);

    h.streams.last().end({
      kind: 'error',
      code: 'conflict',
      message: 'ai_base_version 0 is not the stored version 3',
      status: 409,
    });
    await settle();

    expect(h.log.slice(-2)).toEqual([
      'GET notes',
      `generate run=${RUN_1} template=standup user=0 ai=3`,
    ]);

    // A second 409 (another run holds the meeting, say) is not retried: the page got its `error`
    // event from the stream, and the generate ends.
    h.streams.last().end({ kind: 'error', code: 'conflict', message: 'Still stale', status: 409 });
    await settle();
    expect(h.streams.calls).toHaveLength(2);
    expect(h.store.listPendingGenerates()).toEqual([]);
  });

  it('rejects a second generate while a run streams', async () => {
    const h = harness();
    h.generator.start();
    h.generator.generate(MEETING, 'standup');
    await settle();

    expect(() => h.generator.generate(MEETING, 'general')).toThrow('already running');
    expect(h.store.getPendingGenerate(MEETING)?.templateId).toBe('standup');
  });
});

describe('NotesGenerator: cancel', () => {
  it('drops a waiting generate', async () => {
    const h = harness({ waitingLines: 3 });
    h.generator.start();
    h.stop();

    await h.generator.cancel(MEETING);

    expect(h.store.listPendingGenerates()).toEqual([]);
    expect(h.changes.at(-1)).toEqual({ meetingId: MEETING, pending: null });
    // Its run id was never sent: there is no run in the API to stop.
    expect(h.runs.cancels).toEqual([]);
  });

  it('a cancelled stream that ends cancelled ends the generate', async () => {
    const h = harness();
    h.generator.start();
    h.generator.generate(MEETING, 'standup');
    await settle();

    await h.generator.cancel(MEETING);
    expect(h.streams.cancels).toEqual([MEETING]);
    h.streams.last().end({ kind: 'error', code: 'cancelled', message: 'Cancelled.', status: null });
    await settle();

    expect(h.store.listPendingGenerates()).toEqual([]);
  });

  it('a run that beat the cancel is loaded, never taken as cancelled', async () => {
    // The stream ends `done`: the run saved its notes before the cancel reached it.
    const won = harness();
    won.generator.start();
    won.generator.generate(MEETING, 'standup');
    await settle();
    await won.generator.cancel(MEETING);
    won.streams.last().end({ kind: 'done', result: note('ai', 1, paragraphs('saved'), RUN_1) });
    await settle();
    expect(won.store.getNote(MEETING, 'ai')?.doc).toEqual(paragraphs('saved'));
    expect(won.store.listPendingGenerates()).toEqual([]);

    // The API did not confirm the cancel (`cancel_unconfirmed`): the run is polled and its saved
    // notes loaded.
    const unconfirmed = harness();
    unconfirmed.api.seed(MEETING, note('ai', 1, paragraphs('saved anyway'), RUN_1));
    unconfirmed.generator.start();
    unconfirmed.generator.generate(MEETING, 'standup');
    await settle();
    await unconfirmed.generator.cancel(MEETING);
    unconfirmed.runs.answers = [aRun(RUN_1, 'succeeded')];
    unconfirmed.streams.last().end({ kind: 'dropped', runId: RUN_1, cause: 'cancel_unconfirmed' });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(unconfirmed.store.getNote(MEETING, 'ai')?.doc).toEqual(paragraphs('saved anyway'));
    expect(unconfirmed.store.listPendingGenerates()).toEqual([]);
  });

  it('cancel after the poll stopped asks the API to stop the run', async () => {
    const answers: readonly (readonly [cancel: LlmRunStatus | ApiError, stays: boolean])[] = [
      ['cancelled', false],
      // The run beat the cancel: its saved notes are loaded, never taken as cancelled.
      ['succeeded', false],
      // The API holds no such run: nothing to stop, and the row goes.
      [new ApiError(404, 'not_found', 'No such run'), false],
      // The cancel did not reach the API: it rejects, and the generate goes on.
      [new ApiError(0, 'network_error', 'The API did not answer'), true],
    ];
    for (const [cancel, stays] of answers) {
      const label = cancel instanceof ApiError ? cancel.code : cancel;
      const h = harness();
      h.api.seed(MEETING, note('ai', 1, paragraphs('saved before the cancel'), RUN_1));
      h.generator.start();
      // Off the 30 s re-check's beat: the cancel lands after the poll stopped, before a re-check.
      await vi.advanceTimersByTimeAsync(10_000);
      h.generator.generate(MEETING, 'standup');
      await settle();
      h.runs.answers = [aRun(RUN_1, 'running')];
      h.streams.last().end({ kind: 'dropped', runId: RUN_1, cause: 'network_error' });
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      // No stream and no poll: only the API holds the run now.
      expect(h.generator.getPending(MEETING)?.status, label).toEqual({ phase: 'running' });
      expect(h.streams.calls, label).toHaveLength(1);
      h.runs.cancelAnswer = cancel;

      const cancelled = h.generator.cancel(MEETING);
      if (stays) await expect(cancelled, label).rejects.toThrow('did not answer');
      else await cancelled;
      await settle();

      expect(h.runs.cancels, label).toEqual([RUN_1]);
      expect(h.store.listPendingGenerates().length, label).toBe(stays ? 1 : 0);
      if (cancel === 'succeeded') {
        expect(h.store.getNote(MEETING, 'ai')?.doc).toEqual(paragraphs('saved before the cancel'));
      }
      h.generator.stop();
    }
  });

  it('cancel during the flush of a run an earlier launch sent asks the API to stop it', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'roger-notes-generator-')), 'notes.sqlite');
    const first = harness({ storePath: path });
    first.generator.start();
    first.stop();
    await settle();
    expect(first.streams.calls.map((call) => call.request.runId)).toEqual([RUN_1]);
    first.generator.stop();
    first.store.close();

    // The next launch re-sends RUN_1 once its notes are flushed; the user cancels meanwhile.
    const next = harness({ storePath: path });
    const flush = gate();
    const flushMeeting = next.sync.flushMeeting.bind(next.sync);
    vi.spyOn(next.sync, 'flushMeeting').mockImplementationOnce(async (meetingId) => {
      await flush.wait;
      return flushMeeting(meetingId);
    });
    next.generator.start();
    await settle();

    await next.generator.cancel(MEETING);
    expect(next.runs.cancels).toEqual([RUN_1]);
    flush.open();
    await settle();

    expect(next.streams.calls).toEqual([]);
    expect(next.store.listPendingGenerates()).toEqual([]);
    expect(next.changes.at(-1)).toEqual({ meetingId: MEETING, pending: null });
    next.generator.stop();
    next.store.close();
  });

  it('cancel while polling asks the API to stop the run', async () => {
    const h = harness();
    h.generator.start();
    h.generator.generate(MEETING, 'standup');
    await settle();
    h.runs.answers = [aRun(RUN_1, 'running')];
    h.streams.last().end({ kind: 'dropped', runId: RUN_1, cause: 'network_error' });
    await vi.advanceTimersByTimeAsync(2_000);

    await h.generator.cancel(MEETING);
    expect(h.runs.cancels).toEqual([RUN_1]);
    h.runs.answers = [aRun(RUN_1, 'cancelled')];
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.store.listPendingGenerates()).toEqual([]);
  });
});
