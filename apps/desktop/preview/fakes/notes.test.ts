import { describe, expect, it } from 'vitest';
import {
  notesChannels,
  noteSaveBase,
  type NotesStreamMessage,
  type PendingGenerateChange,
} from '../../src/shared/ipc/notes';
import type {
  LocalNote,
  Note,
  NoteDoc,
  NotesStreamEvent,
  PendingGenerateState,
} from '../../src/shared/notes';
import { PreviewHub } from '../control';
import { FakeHub } from './hub';
import { createNotesFake } from './notes';

const MEETING = '2f6a7d0e-58d4-4c4b-9a0e-0d6f1f7a3c11';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function doc(text: string): NoteDoc {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function localNote(fields: Partial<LocalNote>): LocalNote {
  return {
    meetingId: MEETING,
    kind: 'user',
    doc: doc('Ask about the Q3 renewal'),
    revisionId: null,
    dirty: false,
    baseVersion: 3,
    templateId: null,
    lastRunId: null,
    generatedVersion: null,
    conflictCopy: null,
    sync: 'synced',
    updatedAt: '2026-10-06T10:00:00.000Z',
    ...fields,
  };
}

function setUp() {
  const hub = new FakeHub();
  const notes = createNotesFake(hub);
  const changed: LocalNote[] = [];
  const pending: PendingGenerateChange[] = [];
  const events: NotesStreamMessage[] = [];
  notes.onNoteChanged((note) => changed.push(note));
  notes.onPendingGenerateChanged((change) => pending.push(change));
  notes.onNotesEvent((message) => events.push(message));
  const stream = (runId: string, event: NotesStreamEvent): void => {
    hub.emit(notesChannels.NotesEvent, { meetingId: MEETING, runId, event });
  };
  return { hub, notes, changed, pending, events, stream };
}

describe('the notes fake', () => {
  it('saves a note on this Mac and announces it, as main does', async () => {
    const { notes, changed } = setUp();
    const saved = await notes.saveNote({
      meetingId: MEETING,
      kind: 'user',
      doc: doc('Pilot'),
      base: null,
    });

    expect(saved).toMatchObject({ kind: 'user', dirty: true, sync: 'saved_locally' });
    expect(saved.revisionId).toMatch(UUID);
    expect(saved.baseVersion).toBe(0);
    expect(changed).toEqual([saved]);
    await expect(notes.getNotes(MEETING)).resolves.toEqual({
      meetingId: MEETING,
      user: saved,
      ai: null,
    });
  });

  it('refuses a doc main would refuse, and keeps nothing', async () => {
    const { notes, changed } = setUp();
    const broken = JSON.parse('{"type":"doc","__proto__":{}}') as NoteDoc;
    await expect(
      notes.saveNote({ meetingId: MEETING, kind: 'user', doc: broken, base: null }),
    ).rejects.toThrow('holds a "__proto__" key');
    expect(changed).toEqual([]);
    await expect(notes.getNotes(MEETING)).resolves.toMatchObject({ user: null });
  });

  it('keeps a save built on a note it has replaced since as the conflict copy, as main does', async () => {
    const { hub, notes, changed } = setUp();
    const loaded = localNote({ doc: doc('Agenda'), baseVersion: 2 });
    hub.emit(notesChannels.NotesChanged, loaded);
    const base = noteSaveBase(loaded);
    // Two saves sent before either answered both build on the loaded note, and are taken.
    await notes.saveNote({ meetingId: MEETING, kind: 'user', doc: doc('Agenda, a'), base });
    await notes.saveNote({ meetingId: MEETING, kind: 'user', doc: doc('Agenda, a b'), base });
    // A scenario pushes the server's newer doc, as a 409 would bring it in.
    const theirs = localNote({ doc: doc('Theirs'), baseVersion: 3 });
    hub.emit(notesChannels.NotesChanged, theirs);

    const kept = await notes.saveNote({
      meetingId: MEETING,
      kind: 'user',
      doc: doc('Agenda, a b c'),
      base,
    });

    expect(kept).toMatchObject({
      doc: doc('Theirs'),
      revisionId: null,
      conflictCopy: doc('Agenda, a b c'),
      sync: 'conflict',
    });
    expect(changed.at(-1)).toEqual(kept);
    // Saves built on the server's doc are taken again.
    await expect(
      notes.saveNote({
        meetingId: MEETING,
        kind: 'user',
        doc: doc('Theirs, edited'),
        base: noteSaveBase(theirs),
      }),
    ).resolves.toMatchObject({ doc: doc('Theirs, edited'), conflictCopy: doc('Agenda, a b c') });
  });

  it('answers with the note a scenario last pushed', async () => {
    const { hub, notes } = setUp();
    const pushed = localNote({ sync: 'offline', dirty: true });
    hub.emit(notesChannels.NotesChanged, pushed);
    await expect(notes.getNotes(MEETING)).resolves.toMatchObject({ user: pushed });
  });

  it('resolves a conflict with the local copy ("Use mine") or the server doc', async () => {
    const { hub, notes } = setUp();
    const mine = doc('My version');
    hub.emit(notesChannels.NotesChanged, localNote({ sync: 'conflict', conflictCopy: mine }));
    const kept = await notes.resolveNoteConflict({
      meetingId: MEETING,
      kind: 'user',
      keep: 'mine',
    });
    expect(kept).toMatchObject({ doc: mine, conflictCopy: null, dirty: true, baseVersion: 3 });
    expect(kept.sync).toBe('saved_locally');
    expect(kept.revisionId).toMatch(UUID);

    const theirs = localNote({ kind: 'ai', sync: 'conflict', conflictCopy: mine });
    hub.emit(notesChannels.NotesChanged, theirs);
    await expect(
      notes.resolveNoteConflict({ meetingId: MEETING, kind: 'ai', keep: 'theirs' }),
    ).resolves.toEqual({ ...theirs, conflictCopy: null, sync: 'synced' });

    await expect(
      notes.resolveNoteConflict({ meetingId: MEETING, kind: 'ai', keep: 'mine' }),
    ).rejects.toThrow('no conflict');
  });

  it('lists the four built-in templates', async () => {
    const { notes } = setUp();
    const templates = await notes.listNoteTemplates();
    expect(templates.map((template) => template.id)).toEqual([
      'general',
      'standup',
      'client_call',
      'one_on_one',
    ]);
    for (const template of templates) expect(template.sections.length).toBeGreaterThan(0);
  });

  it('starts a generate with a new run id, and refuses a second while it runs', async () => {
    const { notes, pending } = setUp();
    const started = await notes.generateNotes({ meetingId: MEETING, templateId: 'standup' });
    expect(started).toMatchObject({
      meetingId: MEETING,
      templateId: 'standup',
      reason: 'button',
      status: { phase: 'running' },
    });
    expect(started.runId).toMatch(UUID);
    expect(pending).toEqual([{ meetingId: MEETING, pending: started }]);
    await expect(notes.getPendingGenerate(MEETING)).resolves.toEqual(started);
    await expect(
      notes.generateNotes({ meetingId: MEETING, templateId: 'general' }),
    ).rejects.toThrow('already running');
  });

  it('keeps the run id and reason of a generate waiting for lines or notes', async () => {
    // An attempt may already have reached the API (a crash, a stale-version 409): a new id would
    // start a second paid run.
    const { hub, notes } = setUp();
    const waits: PendingGenerateState['status'][] = [
      { phase: 'waiting_for_lines', waitingLines: 12 },
      { phase: 'waiting_for_notes', cause: 'offline' },
    ];
    for (const status of waits) {
      const waiting: PendingGenerateState = {
        meetingId: MEETING,
        runId: '0b5a3c2d-1e4f-4a6b-8c7d-9e0f1a2b3c4d',
        templateId: 'standup',
        reason: 'after_stop',
        createdAt: '2026-10-06T10:30:00.000Z',
        status,
      };
      hub.emit(notesChannels.NotesPendingGenerateChanged, { meetingId: MEETING, pending: waiting });
      await expect(
        notes.generateNotes({ meetingId: MEETING, templateId: 'general' }),
      ).resolves.toEqual({ ...waiting, templateId: 'general', status: { phase: 'running' } });
    }
  });

  it('retries a failed generate under a new run id, never the failed one', async () => {
    // The API replays a finished run's stored result to a re-sent run id: the failure again.
    const { hub, notes } = setUp();
    const failed: PendingGenerateState = {
      meetingId: MEETING,
      runId: '0b5a3c2d-1e4f-4a6b-8c7d-9e0f1a2b3c4d',
      templateId: 'standup',
      reason: 'after_stop',
      createdAt: '2026-10-06T10:30:00.000Z',
      status: { phase: 'failed', code: 'llm_provider_error', message: 'The model is away.' },
    };
    hub.emit(notesChannels.NotesPendingGenerateChanged, { meetingId: MEETING, pending: failed });
    const retry = await notes.generateNotes({ meetingId: MEETING, templateId: 'standup' });
    expect(retry.runId).not.toBe(failed.runId);
    expect(retry).toMatchObject({ reason: 'button', status: { phase: 'running' } });
  });

  it('cancel ends a running generate with a cancelled event and drops a waiting one', async () => {
    const { hub, notes, pending, events } = setUp();
    const running = await notes.generateNotes({ meetingId: MEETING, templateId: 'standup' });
    await notes.cancelNotesGenerate(MEETING);
    expect(events).toEqual([
      {
        meetingId: MEETING,
        runId: running.runId,
        event: { type: 'error', code: 'cancelled', message: 'Cancelled.' },
      },
    ]);
    expect(pending.at(-1)).toEqual({ meetingId: MEETING, pending: null });
    await expect(
      notes.getNotesRun({ meetingId: MEETING, runId: running.runId }),
    ).resolves.toMatchObject({ status: 'cancelled', errorCode: 'cancelled' });

    hub.emit(notesChannels.NotesPendingGenerateChanged, {
      meetingId: MEETING,
      pending: { ...running, status: { phase: 'waiting_for_lines', waitingLines: 12 } },
    });
    await notes.cancelNotesGenerate(MEETING);
    await expect(notes.getPendingGenerate(MEETING)).resolves.toBeNull();
    expect(events).toHaveLength(1);
  });

  it('records a streamed run: done takes the AI notes, ends the generate and answers getNotesRun', async () => {
    const { hub, notes, changed, pending, stream } = setUp();
    const previous = localNote({ kind: 'ai', doc: doc('Last run') });
    hub.emit(notesChannels.NotesChanged, previous);
    const { runId } = await notes.generateNotes({ meetingId: MEETING, templateId: 'standup' });
    const written: Note = {
      kind: 'ai',
      doc: doc('Beta ships Friday'),
      version: 4,
      templateId: 'standup',
      lastRunId: runId,
      generatedVersion: 4,
      updatedAt: '2026-10-06T11:00:00.000Z',
    };

    stream(runId, { type: 'run', runId, model: 'fake', templateId: 'standup', lineCount: 40 });
    stream(runId, { type: 'section', index: 0, heading: 'Decisions' });
    stream(runId, {
      type: 'item',
      section: 0,
      text: 'Beta ships Friday',
      citations: [],
      support: 'weak',
    });
    stream(runId, { type: 'from_notes', text: 'Check the travel budget' });
    stream(runId, { type: 'dropped', text: 'Everyone agreed', reason: 'no_refs' });
    stream(runId, { type: 'done', runId, note: written });

    expect(changed.at(-1)).toEqual({
      meetingId: MEETING,
      kind: 'ai',
      doc: written.doc,
      revisionId: null,
      dirty: false,
      baseVersion: 4,
      templateId: 'standup',
      lastRunId: runId,
      generatedVersion: 4,
      conflictCopy: null,
      sync: 'synced',
      updatedAt: written.updatedAt,
    });
    expect(pending.at(-1)).toEqual({ meetingId: MEETING, pending: null });
    await expect(notes.getNotesRun({ meetingId: MEETING, runId })).resolves.toMatchObject({
      id: runId,
      meetingId: MEETING,
      kind: 'notes',
      status: 'succeeded',
      model: 'fake',
      templateId: 'standup',
      dropped: [{ text: 'Everyone agreed', reason: 'no_refs' }],
      flaggedCount: 1,
      fromNotesCount: 1,
      outputDoc: written.doc,
      replacedDoc: previous.doc,
    });
  });

  it('keeps edits made during a run as a conflict copy when done arrives', async () => {
    const { hub, notes, changed, stream } = setUp();
    const edited = doc('Edited while it ran');
    hub.emit(notesChannels.NotesChanged, localNote({ kind: 'ai', doc: edited, dirty: true }));
    const { runId } = await notes.generateNotes({ meetingId: MEETING, templateId: 'standup' });
    stream(runId, {
      type: 'done',
      runId,
      note: {
        kind: 'ai',
        doc: doc('Server'),
        version: 4,
        templateId: 'standup',
        lastRunId: runId,
        generatedVersion: 4,
        updatedAt: '2026-10-06T11:00:00.000Z',
      },
    });
    expect(changed.at(-1)).toMatchObject({
      doc: doc('Server'),
      conflictCopy: edited,
      sync: 'conflict',
    });
  });

  it('fails a run on an error event; only llm_provider_error keeps the generate for Retry', async () => {
    const { notes, stream } = setUp();
    const first = await notes.generateNotes({ meetingId: MEETING, templateId: 'standup' });
    stream(first.runId, {
      type: 'error',
      code: 'llm_provider_error',
      message: 'The model is away.',
    });
    await expect(notes.getPendingGenerate(MEETING)).resolves.toMatchObject({
      runId: first.runId,
      status: { phase: 'failed', code: 'llm_provider_error', message: 'The model is away.' },
    });
    await expect(
      notes.getNotesRun({ meetingId: MEETING, runId: first.runId }),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'llm_provider_error',
      error: 'The model is away.',
    });

    const second = await notes.generateNotes({ meetingId: MEETING, templateId: 'standup' });
    stream(second.runId, { type: 'error', code: 'cut_off', message: 'The notes were cut off.' });
    await expect(notes.getPendingGenerate(MEETING)).resolves.toBeNull();
  });

  it('refuses a run it never saw, or one of another meeting', async () => {
    const { notes } = setUp();
    const { runId } = await notes.generateNotes({ meetingId: MEETING, templateId: 'standup' });
    await expect(
      notes.getNotesRun({ meetingId: MEETING, runId: '0b5a3c2d-1e4f-4a6b-8c7d-9e0f1a2b3c4d' }),
    ).rejects.toThrow('not found');
    await expect(
      notes.getNotesRun({ meetingId: '5d0c8b1a-2e3f-4a5b-9c6d-7e8f9a0b1c2d', runId }),
    ).rejects.toThrow('not found');
  });

  it('passes a flush request to the page and its ack back to the hub', () => {
    const { hub, notes } = setUp();
    const requests: unknown[] = [];
    const acks: unknown[] = [];
    notes.onNotesFlushRequest((request) => requests.push(request));
    hub.on(notesChannels.NotesFlushAck, (ack: unknown) => acks.push(ack));

    hub.emit(notesChannels.NotesFlushRequest, { requestId: 'flush-1' });
    notes.ackNotesFlush({ requestId: 'flush-1' });

    expect(requests).toEqual([{ requestId: 'flush-1' }]);
    expect(acks).toEqual([{ requestId: 'flush-1' }]);
  });

  // The seam with M4-T20's QA: notes work offline from notes.sqlite, but the template list and a
  // run's stored docs live only in the API, so unmarked the api-offline preview shows a filled
  // template picker and "Restore previous notes" instead of main's ApiError.
  it("fails the template list and a run's read while the API is offline, and nothing else", async () => {
    const hub = new PreviewHub();
    const notes = createNotesFake(hub);
    const started = await notes.generateNotes({ meetingId: MEETING, templateId: 'general' });
    hub.setApiOffline(true);

    await expect(notes.listNoteTemplates()).rejects.toThrow(
      "Error invoking remote method 'notes:list-templates': ApiError: GET /v1/note-templates failed: connect ECONNREFUSED 127.0.0.1:8000",
    );
    await expect(notes.getNotesRun({ meetingId: MEETING, runId: started.runId })).rejects.toThrow(
      'ApiError: GET /v1/meetings/{id}/runs/{run_id} failed: connect ECONNREFUSED 127.0.0.1:8000',
    );
    await expect(notes.getNotes(MEETING)).resolves.toMatchObject({ meetingId: MEETING });
    hub.setApiOffline(false);
    await expect(notes.listNoteTemplates()).resolves.toHaveLength(4);
    await expect(
      notes.getNotesRun({ meetingId: MEETING, runId: started.runId }),
    ).resolves.toMatchObject({ id: started.runId });
  });
});
