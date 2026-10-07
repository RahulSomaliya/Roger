import { describe, expect, it, vi } from 'vitest';
import type {
  NotesStreamMessage,
  PendingGenerateChange,
  SaveNoteRequest,
} from '../../../shared/ipc/notes';
import type {
  LlmRun,
  LocalNote,
  MeetingNotes,
  NoteDoc,
  NotesStreamEvent,
  NoteTemplate,
  PendingGenerateState,
  PendingGenerateStatus,
} from '../../../shared/notes';
import {
  type AiNotesApi,
  AiNotesSession,
  describePending,
  describeRunError,
  editedSinceRun,
  layoutAiNotes,
  orderTemplates,
} from './aiNotesActions';

const MEETING = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';
const OTHER_MEETING = '9e2b4c6d-1a3f-4b5c-8d7e-6f5a4b3c2d1e';
const RUN = '6a0d6a52-6f0c-4c35-9d0e-1c8f7f0f8a11';
const NEXT_RUN = '0b7c3f1e-9a2d-4e5f-8c61-3d4e5f6a7b8c';

const doc = (text: string): NoteDoc => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const LATEST = doc('Year-one price stays at $50k');
const EARLIER = doc('Price discussed; no decision');

function aiNote(overrides: Partial<LocalNote> = {}): LocalNote {
  return {
    meetingId: MEETING,
    kind: 'ai',
    doc: LATEST,
    revisionId: null,
    dirty: false,
    baseVersion: 4,
    templateId: 'client_call',
    lastRunId: RUN,
    generatedVersion: 4,
    conflictCopy: null,
    sync: 'synced',
    updatedAt: '2026-10-06T11:12:00.000Z',
    ...overrides,
  };
}

function pendingGenerate(
  status: PendingGenerateStatus,
  overrides: Partial<PendingGenerateState> = {},
): PendingGenerateState {
  return {
    meetingId: MEETING,
    runId: NEXT_RUN,
    templateId: 'client_call',
    reason: 'after_stop',
    createdAt: '2026-10-06T11:10:00.000Z',
    status,
    ...overrides,
  };
}

function lastRun(overrides: Partial<LlmRun> = {}): LlmRun {
  return {
    id: RUN,
    meetingId: MEETING,
    kind: 'notes',
    status: 'succeeded',
    model: 'xiaomi/mimo-v2.6-pro',
    templateId: 'client_call',
    errorCode: null,
    error: null,
    dropped: [{ text: 'Everyone agreed it went well', reason: 'no_refs' }],
    flaggedCount: 2,
    fromNotesCount: 1,
    inputTokens: 15_000,
    outputTokens: 2_000,
    cachedTokens: null,
    costUsd: 0.008,
    startedAt: '2026-10-06T11:10:05.000Z',
    finishedAt: '2026-10-06T11:10:40.000Z',
    outputDoc: LATEST,
    replacedDoc: EARLIER,
    ...overrides,
  };
}

const TEMPLATES: NoteTemplate[] = [
  { id: 'one_on_one', name: '1:1', description: 'Updates.', sections: [] },
  { id: 'client_call', name: 'Client call', description: 'Clients.', sections: [] },
  { id: 'general', name: 'General', description: 'Any call.', sections: [] },
  { id: 'standup', name: 'Standup', description: 'Daily.', sections: [] },
];

/** Main as the panel reaches it: answers set per test, events pushed by hand. */
class FakeMain {
  ai: LocalNote | null = null;
  pending: PendingGenerateState | null = null;
  readonly noteListeners = new Set<(note: LocalNote) => void>();
  readonly eventListeners = new Set<(message: NotesStreamMessage) => void>();
  readonly pendingListeners = new Set<(change: PendingGenerateChange) => void>();

  readonly api = {
    getNotes: vi.fn<AiNotesApi['getNotes']>((meetingId) =>
      Promise.resolve<MeetingNotes>({ meetingId, user: null, ai: this.ai }),
    ),
    getPendingGenerate: vi.fn<AiNotesApi['getPendingGenerate']>(() =>
      Promise.resolve(this.pending),
    ),
    listNoteTemplates: vi.fn<AiNotesApi['listNoteTemplates']>(() =>
      Promise.resolve(structuredClone(TEMPLATES)),
    ),
    getNotesRun: vi.fn<AiNotesApi['getNotesRun']>(({ runId }) =>
      Promise.resolve(lastRun({ id: runId })),
    ),
    generateNotes: vi.fn<AiNotesApi['generateNotes']>(({ meetingId, templateId }) =>
      Promise.resolve(
        pendingGenerate({ phase: 'running' }, { meetingId, templateId, reason: 'button' }),
      ),
    ),
    cancelNotesGenerate: vi.fn<AiNotesApi['cancelNotesGenerate']>(() => Promise.resolve()),
    saveNote: vi.fn<AiNotesApi['saveNote']>((request: SaveNoteRequest) =>
      Promise.resolve(aiNote({ doc: request.doc, revisionId: 'r-1', dirty: true })),
    ),
    onNoteChanged: (listener: (note: LocalNote) => void) =>
      this.listen(this.noteListeners, listener),
    onNotesEvent: (listener: (message: NotesStreamMessage) => void) =>
      this.listen(this.eventListeners, listener),
    onPendingGenerateChanged: (listener: (change: PendingGenerateChange) => void) =>
      this.listen(this.pendingListeners, listener),
  } satisfies AiNotesApi;

  noteChanged(note: LocalNote): void {
    for (const listener of [...this.noteListeners]) listener(note);
  }

  event(event: NotesStreamEvent, runId = NEXT_RUN, meetingId = MEETING): void {
    for (const listener of [...this.eventListeners]) listener({ meetingId, runId, event });
  }

  pendingChanged(pending: PendingGenerateState | null, meetingId = MEETING): void {
    for (const listener of [...this.pendingListeners]) listener({ meetingId, pending });
  }

  private listen<T>(set: Set<(value: T) => void>, listener: (value: T) => void): () => void {
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
}

/** Lets every answered request's `then` run. */
const answered = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function opened(main: FakeMain): Promise<AiNotesSession> {
  const session = new AiNotesSession(main.api, MEETING);
  session.start();
  await answered();
  return session;
}

describe('the waiting and ask states', () => {
  it('shows the waiting state from the pending row', async () => {
    const main = new FakeMain();
    main.pending = pendingGenerate({ phase: 'waiting_for_lines', waitingLines: 12 });
    const session = await opened(main);
    expect(layoutAiNotes(session.getState()).prompt).toEqual({
      kind: 'waiting',
      text: 'Notes will generate when 12 lines finish uploading.',
    });

    main.pendingChanged(pendingGenerate({ phase: 'waiting_for_notes', cause: 'offline' }));
    expect(layoutAiNotes(session.getState()).prompt).toEqual({
      kind: 'waiting',
      text: 'Roger is offline; notes will generate when it is back.',
    });
    expect(layoutAiNotes(session.getState()).stop).toBe('cancel');

    main.pendingChanged(pendingGenerate({ phase: 'needs_template' }, { templateId: null }));
    expect(layoutAiNotes(session.getState()).prompt).toEqual({ kind: 'ask' });
    // The question has its own "Not now".
    expect(layoutAiNotes(session.getState()).stop).toBeNull();
  });

  it('says what each wait is for', () => {
    const say = (status: PendingGenerateStatus): unknown =>
      describePending(pendingGenerate(status));
    expect(say({ phase: 'waiting_for_lines', waitingLines: 1 })).toEqual({
      kind: 'waiting',
      text: 'Notes will generate when 1 line finishes uploading.',
    });
    expect(say({ phase: 'waiting_for_notes', cause: 'meeting' })).toEqual({
      kind: 'waiting',
      text: 'Notes will generate once the call has ended and reached your workspace.',
    });
    expect(say({ phase: 'waiting_for_notes', cause: 'conflict' })).toEqual({
      kind: 'waiting',
      text: 'Resolve the conflict in My notes first: notes generate once you pick a version.',
    });
    expect(say({ phase: 'running' })).toEqual({ kind: 'running', text: 'Writing your notes...' });
    // A failure is the banner's, with Retry, not a prompt.
    expect(say({ phase: 'failed', code: 'llm_provider_error', message: 'x' })).toBeNull();
    expect(describePending(null)).toBeNull();
  });

  it('a failed generate offers Retry with its template; Retry clears the old banner', async () => {
    const main = new FakeMain();
    const session = await opened(main);
    main.event({ type: 'run', runId: NEXT_RUN, model: 'm', templateId: 'standup', lineCount: 9 });
    main.event({ type: 'section', index: 0, heading: 'Done' });
    main.event({ type: 'error', code: 'llm_provider_error', message: 'Provider returned 503.' });
    main.pendingChanged(
      pendingGenerate(
        { phase: 'failed', code: 'llm_provider_error', message: 'Provider returned 503.' },
        { templateId: 'standup' },
      ),
    );
    const layout = layoutAiNotes(session.getState());
    expect(layout.failure).toEqual({
      source: 'pending',
      title: 'The AI service could not write the notes.',
      detail: 'Provider returned 503.',
      retryTemplateId: 'standup',
    });
    expect(layout.prompt).toBeNull();

    // main's own local failure is not stored, and Retry keeps its run id.
    main.pendingChanged(
      pendingGenerate({
        phase: 'failed',
        code: 'internal_error',
        message: 'Roger could not generate the notes. It will try again.',
      }),
    );
    expect(layoutAiNotes(session.getState()).failure?.title).toBe(
      'Roger could not generate the notes.',
    );

    expect(await session.generate('standup')).toBe(true);
    expect(main.api.generateNotes).toHaveBeenCalledWith({
      meetingId: MEETING,
      templateId: 'standup',
    });
    expect(session.getState().stream).toBeNull();
  });
});

describe('regenerate and restore', () => {
  it('asks before regenerating AI notes edited since their run', async () => {
    const main = new FakeMain();
    main.ai = aiNote({ dirty: true, sync: 'saved_locally', revisionId: 'r-7' });
    const session = await opened(main);

    expect(await session.regenerate('standup')).toBe(false);
    expect(main.api.generateNotes).not.toHaveBeenCalled();
    expect(session.getState().confirm).toEqual({ action: 'regenerate', templateId: 'standup' });

    expect(await session.confirmAction()).toBe(true);
    expect(main.api.generateNotes).toHaveBeenCalledWith({
      meetingId: MEETING,
      templateId: 'standup',
    });
    expect(session.getState().confirm).toBeNull();

    // Notes as their run wrote them are replaced without a question.
    main.noteChanged(aiNote());
    expect(await session.regenerate('general')).toBe(true);
    expect(main.api.generateNotes).toHaveBeenLastCalledWith({
      meetingId: MEETING,
      templateId: 'general',
    });

    // "Keep my edits" drops the question and sends nothing.
    main.noteChanged(aiNote({ baseVersion: 5 }));
    await session.regenerate('standup');
    session.dismissConfirm();
    expect(session.getState().confirm).toBeNull();
    expect(main.api.generateNotes).toHaveBeenCalledTimes(2);
  });

  it('restore previous notes puts the replaced doc back as a new version', async () => {
    const main = new FakeMain();
    main.ai = aiNote({ revisionId: null, baseVersion: 4 });
    const session = await opened(main);
    expect(main.api.getNotesRun).toHaveBeenCalledWith({ meetingId: MEETING, runId: RUN });
    expect(layoutAiNotes(session.getState()).restorable).toEqual(EARLIER);

    expect(await session.restorePrevious()).toBe(true);
    // A save of the earlier doc on the note on show: main stores it as a new local revision and
    // NotesSync uploads it as the next version. The editor then loads it as a doc from elsewhere.
    expect(main.api.saveNote).toHaveBeenCalledWith({
      meetingId: MEETING,
      kind: 'ai',
      doc: EARLIER,
      base: { revisionId: null, version: 4 },
    });

    // Once on show, there is nothing earlier to put back.
    main.noteChanged(aiNote({ doc: EARLIER, revisionId: 'r-1', dirty: true }));
    expect(layoutAiNotes(session.getState()).restorable).toBeNull();
  });

  it('asks before restoring over AI notes edited since their run', async () => {
    const main = new FakeMain();
    main.ai = aiNote({ baseVersion: 6 });
    const session = await opened(main);
    expect(await session.restorePrevious()).toBe(false);
    expect(session.getState().confirm).toEqual({ action: 'restore' });
    expect(main.api.saveNote).not.toHaveBeenCalled();
    expect(await session.confirmAction()).toBe(true);
    expect(main.api.saveNote).toHaveBeenCalledWith(
      expect.objectContaining({ doc: EARLIER, base: { revisionId: null, version: 6 } }),
    );
  });

  it('offers no restore for a first run, while a run is on its way, or before its run is read', async () => {
    const main = new FakeMain();
    main.ai = aiNote();
    main.api.getNotesRun.mockResolvedValueOnce(lastRun({ replacedDoc: null }));
    const session = await opened(main);
    expect(layoutAiNotes(session.getState()).restorable).toBeNull();
    expect(layoutAiNotes(session.getState()).canRegenerate).toBe(true);

    // A regeneration: its run kept the notes it replaced.
    main.noteChanged(aiNote({ lastRunId: NEXT_RUN, baseVersion: 5, generatedVersion: 5 }));
    await answered();
    expect(main.api.getNotesRun).toHaveBeenLastCalledWith({ meetingId: MEETING, runId: NEXT_RUN });
    expect(layoutAiNotes(session.getState()).restorable).toEqual(EARLIER);

    main.pendingChanged(pendingGenerate({ phase: 'running' }, { runId: RUN }));
    const running = layoutAiNotes(session.getState());
    expect(running.restorable).toBeNull();
    expect(running.canRegenerate).toBe(false);

    // Notes of a run whose record has not arrived yet: nothing to offer until it does.
    main.pendingChanged(null);
    main.api.getNotesRun.mockReturnValueOnce(new Promise<LlmRun>(() => undefined));
    main.noteChanged(aiNote({ lastRunId: RUN, baseVersion: 6, generatedVersion: 6 }));
    expect(layoutAiNotes(session.getState()).restorable).toBeNull();
    expect(layoutAiNotes(session.getState()).removed).toEqual([]);
  });

  it('knows which AI notes were edited since their run', () => {
    expect(editedSinceRun(null)).toBe(false);
    expect(editedSinceRun(aiNote())).toBe(false);
    expect(editedSinceRun(aiNote({ dirty: true }))).toBe(true);
    expect(editedSinceRun(aiNote({ baseVersion: 5 }))).toBe(true);
    expect(editedSinceRun(aiNote({ conflictCopy: EARLIER }))).toBe(true);
    // No run wrote these: typed by hand.
    expect(editedSinceRun(aiNote({ lastRunId: null, generatedVersion: null }))).toBe(true);
  });
});

describe('the session', () => {
  it('reads the pending generate, the AI note, the last run and the templates', async () => {
    const main = new FakeMain();
    main.ai = aiNote();
    main.pending = null;
    const session = await opened(main);
    const state = session.getState();
    expect(state.status).toBe('ready');
    expect(state.note).toEqual(aiNote());
    expect(state.templates).toEqual({ status: 'ready', value: orderTemplates(TEMPLATES) });
    const layout = layoutAiNotes(state);
    expect(layout.editor).toBe('shown');
    expect(layout.readOnly).toBe(false);
    expect(layout.removed).toEqual([{ text: 'Everyone agreed it went well', reason: 'no_refs' }]);
    expect(layout.about).toEqual({ templateId: 'client_call', flagged: 2 });
    expect(layout.empty).toBe(false);
  });

  it('describes notes only as their run wrote them, or the run streaming now', async () => {
    const main = new FakeMain();
    main.ai = aiNote();
    const session = await opened(main);
    expect(layoutAiNotes(session.getState()).about).toEqual({
      templateId: 'client_call',
      flagged: 2,
    });

    // A regeneration as General streams over the hidden notes: the bar names the new template.
    main.pendingChanged(pendingGenerate({ phase: 'running' }, { templateId: 'general' }));
    expect(layoutAiNotes(session.getState()).about).toBeNull();
    main.event({ type: 'run', runId: NEXT_RUN, model: 'm', templateId: 'general', lineCount: 9 });
    expect(layoutAiNotes(session.getState()).about).toEqual({ templateId: 'general', flagged: 0 });
    main.event({ type: 'error', code: 'cancelled', message: 'Notes generation was cancelled.' });
    main.pendingChanged(null);

    // Restored earlier notes, or notes the user edited: the run's template and count no longer
    // describe the doc on show.
    main.noteChanged(aiNote({ dirty: true, revisionId: 'r-2' }));
    expect(layoutAiNotes(session.getState()).about).toBeNull();
    main.noteChanged(aiNote({ baseVersion: 5 }));
    expect(layoutAiNotes(session.getState()).about).toBeNull();
  });

  it('shows the empty state with nothing written and nothing pending', async () => {
    const session = await opened(new FakeMain());
    const layout = layoutAiNotes(session.getState());
    expect(layout.empty).toBe(true);
    expect(layout.editor).toBeNull();
    expect(layout.canRegenerate).toBe(false);
  });

  it('a change that arrives before the first read answers wins', async () => {
    const main = new FakeMain();
    main.pending = pendingGenerate({ phase: 'running' });
    main.ai = aiNote({ baseVersion: 2, generatedVersion: 2 });
    const session = new AiNotesSession(main.api, MEETING);
    session.start();
    main.pendingChanged(null);
    main.noteChanged(aiNote());
    await answered();
    expect(session.getState().pending).toBeNull();
    expect(session.getState().note?.baseVersion).toBe(4);
  });

  it('says why it could not open, and tries again', async () => {
    const main = new FakeMain();
    main.api.getPendingGenerate.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'notes:get-pending-generate': Error: database closed",
      ),
    );
    const session = await opened(main);
    expect(session.getState().status).toBe('failed');
    expect(session.getState().loadError).toBe('database closed');
    session.reload();
    await answered();
    expect(session.getState().status).toBe('ready');
  });

  it("ignores other meetings' notes, events and generates", async () => {
    const main = new FakeMain();
    const session = await opened(main);
    const before = session.getState();
    main.noteChanged(aiNote({ meetingId: OTHER_MEETING }));
    main.noteChanged({ ...aiNote(), kind: 'user' });
    main.event(
      { type: 'run', runId: NEXT_RUN, model: 'm', templateId: 'general', lineCount: 1 },
      NEXT_RUN,
      OTHER_MEETING,
    );
    main.pendingChanged(pendingGenerate({ phase: 'running' }), OTHER_MEETING);
    expect(session.getState()).toBe(before);
  });

  it('follows a run: read-only while it streams, its lines over the hidden editor', async () => {
    const main = new FakeMain();
    main.ai = aiNote();
    const session = await opened(main);
    main.pendingChanged(pendingGenerate({ phase: 'running' }));
    let layout = layoutAiNotes(session.getState());
    // Flushing the notes first: the old notes stay on show, read-only.
    expect(layout.prompt).toEqual({ kind: 'running', text: 'Writing your notes...' });
    expect(layout.editor).toBe('shown');
    expect(layout.readOnly).toBe(true);
    expect(layout.stop).toBe('stop');

    main.event({ type: 'run', runId: NEXT_RUN, model: 'm', templateId: 'general', lineCount: 9 });
    main.event({ type: 'section', index: 0, heading: 'Summary' });
    main.event({ type: 'dropped', text: 'It went well', reason: 'unknown_refs' });
    layout = layoutAiNotes(session.getState());
    expect(layout.stream).toBe('live');
    expect(layout.editor).toBe('hidden');
    expect(layout.readOnly).toBe(true);
    expect(layout.removed).toEqual([{ text: 'It went well', reason: 'unknown_refs' }]);

    // The run's notes land in the store; the generate ends.
    main.noteChanged(aiNote({ lastRunId: NEXT_RUN, baseVersion: 5, generatedVersion: 5 }));
    main.pendingChanged(null);
    layout = layoutAiNotes(session.getState());
    expect(layout.stream).toBeNull();
    expect(layout.editor).toBe('shown');
    expect(layout.readOnly).toBe(false);
  });

  it('gives the notes back when a lost stream leaves its generate waiting offline', async () => {
    const main = new FakeMain();
    main.ai = aiNote();
    const session = await opened(main);
    main.pendingChanged(pendingGenerate({ phase: 'running' }));
    main.event({ type: 'run', runId: NEXT_RUN, model: 'm', templateId: 'general', lineCount: 9 });
    main.event({ type: 'section', index: 0, heading: 'Summary' });
    main.event({ type: 'item', section: 0, text: 'Pilot went well', citations: [], support: 'ok' });
    expect(layoutAiNotes(session.getState()).editor).toBe('hidden');

    // The stream dropped with no event; main's poll could not reach the API.
    main.pendingChanged(pendingGenerate({ phase: 'waiting_for_notes', cause: 'offline' }));
    let layout = layoutAiNotes(session.getState());
    expect(layout.stream).toBeNull();
    expect(layout.editor).toBe('shown');
    expect(layout.readOnly).toBe(false);
    expect(layout.prompt).toEqual({
      kind: 'waiting',
      text: 'Roger is offline; notes will generate when it is back.',
    });
    expect(layout.stop).toBe('cancel');

    // Back online: the next attempt re-sends the run id and replays from its `run` event.
    main.pendingChanged(pendingGenerate({ phase: 'running' }));
    main.event({ type: 'run', runId: NEXT_RUN, model: 'm', templateId: 'general', lineCount: 9 });
    layout = layoutAiNotes(session.getState());
    expect(layout.stream).toBe('live');
    expect(layout.editor).toBe('hidden');
  });

  it('keeps partial notes with a banner after an error, until dismissed', async () => {
    const main = new FakeMain();
    const session = await opened(main);
    main.pendingChanged(pendingGenerate({ phase: 'running' }));
    main.event({ type: 'run', runId: NEXT_RUN, model: 'm', templateId: 'general', lineCount: 9 });
    main.event({ type: 'section', index: 0, heading: 'Summary' });
    main.event({ type: 'item', section: 0, text: 'Pilot went well', citations: [], support: 'ok' });
    main.event({ type: 'error', code: 'cut_off', message: 'The notes were cut off.' });
    main.pendingChanged(null);
    const layout = layoutAiNotes(session.getState());
    expect(layout.stream).toBe('partial');
    expect(layout.failure).toEqual({
      source: 'stream',
      title: 'The notes ran too long and were cut off, so Roger kept the earlier AI notes.',
      detail: 'The notes were cut off.',
      retryTemplateId: null,
    });
    // Nothing waits any more: the notes can be generated again.
    expect(layout.empty).toBe(true);

    session.dismissFailure();
    expect(layoutAiNotes(session.getState()).failure).toBeNull();
    expect(layoutAiNotes(session.getState()).stream).toBeNull();
  });

  it("shows main's reason when a generate is refused", async () => {
    const main = new FakeMain();
    main.api.generateNotes.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'notes:generate': Error: the notes of meeting " +
          `${MEETING} may already be generating as general: cancel them before picking another template`,
      ),
    );
    const session = await opened(main);
    expect(await session.generate('standup')).toBe(false);
    const { actionError, busy } = session.getState();
    expect(busy).toBeNull();
    expect(actionError).toMatch(/^Roger could not start the notes: the notes of meeting /);
    expect(actionError).toContain('cancel them before picking another template');
    session.dismissError();
    expect(session.getState().actionError).toBeNull();
  });

  it('Stop does not wait for the API, and says so when the cancel fails', async () => {
    const main = new FakeMain();
    main.pending = pendingGenerate({ phase: 'running' });
    // The cancel resolves only once the API holds the run, up to 130 s.
    main.api.cancelNotesGenerate.mockReturnValueOnce(new Promise<void>(() => undefined));
    const session = await opened(main);
    session.cancel();
    expect(main.api.cancelNotesGenerate).toHaveBeenCalledWith(MEETING);
    expect(session.getState().cancelling).toBe(true);
    expect(session.getState().busy).toBeNull();
    // The page hears the cancel and the generate's end meanwhile.
    main.event({ type: 'error', code: 'cancelled', message: 'Notes generation was cancelled.' });
    main.pendingChanged(null);
    expect(session.getState().cancelling).toBe(false);

    main.pendingChanged(pendingGenerate({ phase: 'waiting_for_lines', waitingLines: 3 }));
    main.api.cancelNotesGenerate.mockRejectedValueOnce(
      new Error("Error invoking remote method 'notes:cancel-generate': ApiError: offline"),
    );
    session.cancel();
    await answered();
    expect(session.getState().cancelling).toBe(false);
    expect(session.getState().actionError).toBe('Roger could not stop the notes: offline');
  });

  it('says when the last run cannot be read, and reads it again', async () => {
    const main = new FakeMain();
    main.ai = aiNote();
    main.api.getNotesRun.mockRejectedValueOnce(
      new Error("Error invoking remote method 'notes:get-run': ApiError: Roger is offline"),
    );
    const session = await opened(main);
    let layout = layoutAiNotes(session.getState());
    expect(layout.runProblem).toBe('Roger is offline');
    expect(layout.removed).toEqual([]);
    session.reloadRun();
    await answered();
    layout = layoutAiNotes(session.getState());
    expect(layout.runProblem).toBeNull();
    expect(layout.removed).toHaveLength(1);
  });

  it('templates: General leads, the rest keep the API order; a failed list can be read again', async () => {
    expect(orderTemplates(TEMPLATES).map((template) => template.id)).toEqual([
      'general',
      'one_on_one',
      'client_call',
      'standup',
    ]);
    const main = new FakeMain();
    main.api.listNoteTemplates.mockRejectedValueOnce(
      new Error("Error invoking remote method 'notes:list-templates': ApiError: Roger is offline"),
    );
    const session = await opened(main);
    expect(session.getState().templates).toEqual({ status: 'failed', error: 'Roger is offline' });
    session.reloadTemplates();
    await answered();
    expect(session.getState().templates.status).toBe('ready');
  });

  it('stops following main once stopped', async () => {
    const main = new FakeMain();
    const session = new AiNotesSession(main.api, MEETING);
    const stop = session.start();
    await answered();
    stop();
    const before = session.getState();
    main.pendingChanged(pendingGenerate({ phase: 'running' }));
    main.noteChanged(aiNote());
    expect(session.getState()).toBe(before);
    expect(main.noteListeners.size).toBe(0);
    expect(main.eventListeners.size).toBe(0);
    expect(main.pendingListeners.size).toBe(0);
  });
});

describe('describeRunError', () => {
  it('names the failure, with what main or the API said when it adds something', () => {
    expect(
      describeRunError({ code: 'cancelled', message: 'Notes generation was cancelled.' }),
    ).toEqual({
      title: 'Notes generation was cancelled.',
      detail: null,
    });
    // A cancel is the user's own doing: whatever main says, there is nothing to add.
    expect(describeRunError({ code: 'cancelled', message: 'Cancelled.' }).detail).toBeNull();
    expect(
      describeRunError({
        code: 'empty_meeting',
        message: 'The meeting has no lines and no notes.',
      }),
    ).toEqual({
      title: 'There is nothing to write notes from yet: no transcript lines and no notes.',
      detail: 'The meeting has no lines and no notes.',
    });
    expect(describeRunError({ code: 'network_error', message: 'connect ECONNREFUSED' })).toEqual({
      title: 'Roger could not reach its server.',
      detail: 'connect ECONNREFUSED',
    });
    expect(describeRunError({ code: 'teapot', message: 'I am a teapot' })).toEqual({
      title: 'Roger could not generate the notes.',
      detail: 'I am a teapot',
    });
  });
});
