import {
  notesChannels,
  noteSaveBase,
  saveBaseKey,
  type NotesApi,
  type NotesStreamMessage,
  type PendingGenerateChange,
} from '../../src/shared/ipc/notes';
import {
  type LlmRun,
  type LocalNote,
  type Note,
  type NoteKind,
  type NoteTemplate,
  type PendingGenerateState,
  type PendingGenerateStatus,
  noteDocProblem,
} from '../../src/shared/notes';
import { fromApi } from '../control';
import type { FakeHub } from './hub';

/** The model a preview run reports until a scenario's `run` event names one. */
const PREVIEW_MODEL = 'fake';

/** Stand-ins for the API's templates (M4-T3, note_templates/*.json), for the Write again as menu. */
const TEMPLATES: NoteTemplate[] = [
  {
    id: 'general',
    name: 'General',
    description: 'Any call: what was decided and who does what.',
    sections: [
      { heading: 'Summary', guidance: 'What the call was about, in a few bullets.' },
      { heading: 'Decisions', guidance: 'What was agreed.' },
      { heading: 'Action items', guidance: 'Owner: what, by when.' },
    ],
  },
  {
    id: 'standup',
    name: 'Standup',
    description: 'Progress, plans and blockers.',
    sections: [
      { heading: 'Done', guidance: 'What each person finished.' },
      { heading: 'Next', guidance: 'What each person does next.' },
      { heading: 'Blockers', guidance: 'What is in the way, and who can unblock it.' },
    ],
  },
  {
    id: 'client_call',
    name: 'Client call',
    description: 'What the client needs and what happens next.',
    sections: [
      { heading: 'Their goals', guidance: 'What the client wants and why.' },
      { heading: 'Decisions', guidance: 'What was agreed, with numbers as said.' },
      { heading: 'Next steps', guidance: 'Owner: what, by when.' },
    ],
  },
  {
    id: 'one_on_one',
    name: '1:1',
    description: 'Updates, feedback and follow-ups between two people.',
    sections: [
      { heading: 'Updates', guidance: 'What each person shared.' },
      { heading: 'Feedback', guidance: 'Feedback given either way.' },
      { heading: 'Follow-ups', guidance: 'Owner: what, by when.' },
    ],
  },
];

/**
 * Notes' part of the preview's `window.roger`: main with a healthy API, minus NotesSync and the
 * generator's preconditions. A save stays "saved on this Mac" and a generate goes straight to
 * `running`; a scenario pushes what happens next on the real channels (NotesChanged,
 * NotesPendingGenerateChanged, NotesEvent) and the fake follows them as main would: a run's
 * `done` takes the AI notes and ends the pending generate, an `error` fails the run and keeps the
 * generate only for `llm_provider_error` (Retry). getNotesRun answers for every run the fake
 * started or saw streamed. Every state change goes through the hub, so the page hears it too.
 * A save on a doc a scenario has replaced since (its `base`) is kept as the conflict copy, as
 * main keeps it (NotesStore.saveLocal), except that the fake replaces any copy it finds.
 */
export function createNotesFake(hub: FakeHub): NotesApi {
  const notes = new Map<string, LocalNote>();
  const pending = new Map<string, PendingGenerateState>();
  const runs = new Map<string, LlmRun>();
  const noteKey = (meetingId: string, kind: NoteKind): string => `${meetingId}/${kind}`;
  /** Per note, the base of the page saves that wrote its doc since a doc from elsewhere. */
  const saveBases = new Map<string, string>();
  /** The note the fake is publishing for a page save: its own write keeps the saves' base. */
  let pageSave: LocalNote | null = null;

  const publishNote = (note: LocalNote): LocalNote => {
    hub.emit(notesChannels.NotesChanged, note);
    return note;
  };
  const publishPending = (meetingId: string, next: PendingGenerateState | null): void => {
    hub.emit(notesChannels.NotesPendingGenerateChanged, { meetingId, pending: next });
  };

  const startRun = (meetingId: string, runId: string, templateId: string | null): LlmRun => {
    const run: LlmRun = {
      id: runId,
      meetingId,
      kind: 'notes',
      status: 'running',
      model: PREVIEW_MODEL,
      templateId,
      errorCode: null,
      error: null,
      dropped: [],
      flaggedCount: 0,
      fromNotesCount: 0,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      costUsd: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outputDoc: null,
      replacedDoc: null,
    };
    runs.set(runId, run);
    return run;
  };

  /** Ends or updates the meeting's pending generate, if it is this run's. */
  const settlePending = (
    meetingId: string,
    runId: string,
    status: PendingGenerateStatus | null,
  ): void => {
    const current = pending.get(meetingId);
    if (current?.runId !== runId) return;
    publishPending(meetingId, status === null ? null : { ...current, status });
  };

  const follow = ({ meetingId, runId, event }: NotesStreamMessage): void => {
    const run = runs.get(runId) ?? startRun(meetingId, runId, null);
    switch (event.type) {
      case 'run':
        run.model = event.model;
        run.templateId = event.templateId;
        return;
      case 'section':
        return;
      case 'item':
        if (event.support === 'weak') run.flaggedCount += 1;
        return;
      case 'from_notes':
        run.fromNotesCount += 1;
        return;
      case 'dropped':
        run.dropped.push({ text: event.text, reason: event.reason });
        return;
      case 'done': {
        const current = notes.get(noteKey(meetingId, 'ai'));
        run.status = 'succeeded';
        run.finishedAt = new Date().toISOString();
        run.outputDoc = event.note.doc;
        run.replacedDoc = current?.doc ?? null;
        publishNote(applyServerNote(meetingId, current, event.note));
        settlePending(meetingId, runId, null);
        return;
      }
      case 'error':
        run.status = event.code === 'cancelled' ? 'cancelled' : 'failed';
        run.errorCode = event.code;
        run.error = event.message;
        run.finishedAt = new Date().toISOString();
        settlePending(
          meetingId,
          runId,
          event.code === 'llm_provider_error'
            ? { phase: 'failed', code: event.code, message: event.message }
            : null,
        );
        return;
    }
  };

  hub.on(notesChannels.NotesChanged, (note: LocalNote) => {
    const key = noteKey(note.meetingId, note.kind);
    const before = notes.get(key);
    notes.set(key, note);
    if (note === pageSave || before === undefined) return;
    // A doc from elsewhere (a scenario's push, a run's `done`, "Use mine") ends the page saves'
    // base; the same text under a new name keeps saves on the old name current, as in main.
    const was = saveBaseKey(noteSaveBase(before));
    if (saveBaseKey(noteSaveBase(note)) === was) return;
    if (JSON.stringify(before.doc) !== JSON.stringify(note.doc)) saveBases.delete(key);
    else if (!saveBases.has(key)) saveBases.set(key, was);
  });
  hub.on(notesChannels.NotesPendingGenerateChanged, (change: PendingGenerateChange) => {
    if (change.pending === null) pending.delete(change.meetingId);
    else pending.set(change.meetingId, change.pending);
  });
  hub.on(notesChannels.NotesEvent, follow);

  return {
    getNotes: (meetingId) =>
      hub.request(notesChannels.NotesGet, () => ({
        meetingId,
        user: notes.get(noteKey(meetingId, 'user')) ?? null,
        ai: notes.get(noteKey(meetingId, 'ai')) ?? null,
      })),
    saveNote: ({ meetingId, kind, doc, base }) =>
      hub.request(notesChannels.NotesSave, () => {
        const problem = noteDocProblem(doc);
        if (problem !== null) throw new Error(`note not saved: ${problem}`);
        const key = noteKey(meetingId, kind);
        const current = notes.get(key);
        const baseKey = saveBaseKey(base);
        const stale =
          current !== undefined &&
          baseKey !== saveBaseKey(noteSaveBase(current)) &&
          baseKey !== saveBases.get(key);
        if (stale) {
          if (JSON.stringify(doc) === JSON.stringify(current.doc)) {
            saveBases.set(key, baseKey);
            return current;
          }
          return publishNote({
            ...current,
            conflictCopy: doc,
            sync: 'conflict',
            updatedAt: new Date().toISOString(),
          });
        }
        saveBases.set(key, baseKey);
        const conflictCopy = current?.conflictCopy ?? null;
        pageSave = {
          meetingId,
          kind,
          doc,
          revisionId: crypto.randomUUID(),
          dirty: true,
          baseVersion: current?.baseVersion ?? 0,
          templateId: current?.templateId ?? null,
          lastRunId: current?.lastRunId ?? null,
          generatedVersion: current?.generatedVersion ?? null,
          conflictCopy,
          sync: conflictCopy === null ? 'saved_locally' : 'conflict',
          updatedAt: new Date().toISOString(),
        };
        return publishNote(pageSave);
      }),
    resolveNoteConflict: ({ meetingId, kind, keep }) =>
      hub.request(notesChannels.NotesResolveConflict, () => {
        const current = notes.get(noteKey(meetingId, kind));
        const mine = current?.conflictCopy ?? null;
        if (current === undefined || mine === null) {
          throw new Error(`no conflict to resolve on the ${kind} notes of meeting ${meetingId}`);
        }
        if (keep === 'theirs') {
          return publishNote({
            ...current,
            conflictCopy: null,
            sync: current.dirty ? 'saved_locally' : 'synced',
          });
        }
        return publishNote({
          ...current,
          doc: mine,
          conflictCopy: null,
          revisionId: crypto.randomUUID(),
          dirty: true,
          sync: 'saved_locally',
          updatedAt: new Date().toISOString(),
        });
      }),
    listNoteTemplates: () =>
      hub.request(
        notesChannels.NotesListTemplates,
        // Main fetches the list live (notesClient), so it fails while the API is away.
        fromApi('GET /v1/note-templates', () => structuredClone(TEMPLATES)),
      ),
    generateNotes: ({ meetingId, templateId }) =>
      hub.request(notesChannels.NotesGenerate, () => {
        const current = pending.get(meetingId);
        if (current?.status.phase === 'running') {
          throw new Error(`a notes run is already running for meeting ${meetingId}`);
        }
        // A failed run gets a new id: the API replays a finished run's stored result to a
        // re-sent id, which would be the same failure again.
        const next: PendingGenerateState =
          current !== undefined && current.status.phase !== 'failed'
            ? { ...current, templateId, status: { phase: 'running' } }
            : {
                meetingId,
                runId: crypto.randomUUID(),
                templateId,
                reason: 'button',
                createdAt: new Date().toISOString(),
                status: { phase: 'running' },
              };
        startRun(meetingId, next.runId, templateId);
        publishPending(meetingId, next);
        return next;
      }),
    cancelNotesGenerate: (meetingId) =>
      hub.request(notesChannels.NotesCancelGenerate, () => {
        const current = pending.get(meetingId);
        if (current === undefined) return;
        if (current.status.phase === 'running') {
          // As the API ends a cancelled run's stream; following it ends the pending generate.
          hub.emit(notesChannels.NotesEvent, {
            meetingId,
            runId: current.runId,
            event: { type: 'error', code: 'cancelled', message: 'Cancelled.' },
          });
        } else {
          publishPending(meetingId, null);
        }
      }),
    getPendingGenerate: (meetingId) =>
      hub.request(notesChannels.NotesGetPendingGenerate, () => pending.get(meetingId) ?? null),
    getNotesRun: ({ meetingId, runId }) =>
      hub.request(
        notesChannels.NotesGetRun,
        // A run's stored docs live only in the API ("Restore previous notes"), so main reads them
        // live and the read fails while the API is away.
        fromApi('GET /v1/meetings/{id}/runs/{run_id}', () => {
          const run = runs.get(runId);
          if (run?.meetingId !== meetingId) {
            throw new Error(`notes run ${runId} not found for meeting ${meetingId}`);
          }
          // A snapshot, as main's answer is: the fake keeps updating its record as events arrive.
          return structuredClone(run);
        }),
      ),
    // The ack goes back through the hub, so a scenario can wait for it as main's quit hook does.
    ackNotesFlush: (ack) => {
      hub.emit(notesChannels.NotesFlushAck, ack);
    },
    onNoteChanged: (listener) => hub.on(notesChannels.NotesChanged, listener),
    onNotesEvent: (listener) => hub.on(notesChannels.NotesEvent, listener),
    onPendingGenerateChanged: (listener) =>
      hub.on(notesChannels.NotesPendingGenerateChanged, listener),
    onNotesFlushRequest: (listener) => hub.on(notesChannels.NotesFlushRequest, listener),
  };
}

/**
 * The server's note as notes.sqlite takes it (main/notes/NotesStore.ts, `applyServerNote`): a
 * dirty local doc is never overwritten, it becomes the conflict copy.
 */
function applyServerNote(meetingId: string, local: LocalNote | undefined, note: Note): LocalNote {
  const server: LocalNote = {
    meetingId,
    kind: note.kind,
    doc: note.doc,
    revisionId: null,
    dirty: false,
    baseVersion: note.version,
    templateId: note.templateId,
    lastRunId: note.lastRunId,
    generatedVersion: note.generatedVersion,
    conflictCopy: null,
    sync: 'synced',
    updatedAt: note.updatedAt,
  };
  return local?.dirty === true ? { ...server, conflictCopy: local.doc, sync: 'conflict' } : server;
}
