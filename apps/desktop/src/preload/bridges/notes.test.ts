import { describe, expect, it, vi } from 'vitest';
import { notesChannels } from '../../shared/ipc/notes';
import { notesBridge } from './notes';

// Electron's ipcRenderer, as far as the bridge helpers use it (see ../bridge.test.ts). Hoisted,
// because vi.mock runs before the imports.
const ipc = vi.hoisted(() => {
  const listeners = new Map<string, ((event: object, payload: unknown) => void)[]>();
  const calls: { how: 'invoke' | 'send' | 'on'; channel: string; payload?: unknown }[] = [];
  return {
    calls,
    renderer: {
      invoke: (channel: string, payload: unknown): Promise<unknown> => {
        calls.push({ how: 'invoke', channel, payload });
        return Promise.resolve(null);
      },
      send: (channel: string, payload: unknown): void => {
        calls.push({ how: 'send', channel, payload });
      },
      on: (channel: string, listener: (event: object, payload: unknown) => void): void => {
        calls.push({ how: 'on', channel });
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      },
      removeListener: (channel: string, listener: (event: object, payload: unknown) => void) => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((each) => each !== listener),
        );
      },
    },
    emit: (channel: string, payload: unknown): void => {
      for (const listener of listeners.get(channel) ?? []) listener({}, payload);
    },
  };
});
vi.mock('electron', () => ({ ipcRenderer: ipc.renderer }));

const MEETING = '2f6a7d0e-58d4-4c4b-9a0e-0d6f1f7a3c11';
const RUN = '8c1e3b52-7a40-4c7e-9f3d-5b2a1c9e0d47';
const DOC = { type: 'doc' as const, content: [] };

describe('the notes bridge', () => {
  it('sends each request on its own channel with its one payload', async () => {
    ipc.calls.length = 0;
    await notesBridge.getNotes(MEETING);
    await notesBridge.saveNote({ meetingId: MEETING, kind: 'user', doc: DOC });
    await notesBridge.resolveNoteConflict({ meetingId: MEETING, kind: 'ai', keep: 'mine' });
    await notesBridge.listNoteTemplates();
    await notesBridge.generateNotes({ meetingId: MEETING, templateId: 'standup' });
    await notesBridge.cancelNotesGenerate(MEETING);
    await notesBridge.getPendingGenerate(MEETING);
    await notesBridge.getNotesRun({ meetingId: MEETING, runId: RUN });
    notesBridge.ackNotesFlush({ requestId: 'flush-1' });

    expect(ipc.calls).toEqual([
      { how: 'invoke', channel: notesChannels.NotesGet, payload: MEETING },
      {
        how: 'invoke',
        channel: notesChannels.NotesSave,
        payload: { meetingId: MEETING, kind: 'user', doc: DOC },
      },
      {
        how: 'invoke',
        channel: notesChannels.NotesResolveConflict,
        payload: { meetingId: MEETING, kind: 'ai', keep: 'mine' },
      },
      { how: 'invoke', channel: notesChannels.NotesListTemplates, payload: undefined },
      {
        how: 'invoke',
        channel: notesChannels.NotesGenerate,
        payload: { meetingId: MEETING, templateId: 'standup' },
      },
      { how: 'invoke', channel: notesChannels.NotesCancelGenerate, payload: MEETING },
      { how: 'invoke', channel: notesChannels.NotesGetPendingGenerate, payload: MEETING },
      {
        how: 'invoke',
        channel: notesChannels.NotesGetRun,
        payload: { meetingId: MEETING, runId: RUN },
      },
      { how: 'send', channel: notesChannels.NotesFlushAck, payload: { requestId: 'flush-1' } },
    ]);
  });

  it('hands each listener its own event until it unsubscribes', () => {
    ipc.calls.length = 0;
    const heard: [string, unknown][] = [];
    const stops = [
      notesBridge.onNoteChanged((note) => heard.push(['changed', note])),
      notesBridge.onNotesEvent((message) => heard.push(['event', message])),
      notesBridge.onPendingGenerateChanged((change) => heard.push(['pending', change])),
      notesBridge.onNotesFlushRequest((request) => heard.push(['flush', request])),
    ];
    ipc.emit(notesChannels.NotesChanged, 'a note');
    ipc.emit(notesChannels.NotesEvent, 'a run event');
    ipc.emit(notesChannels.NotesPendingGenerateChanged, 'a pending generate');
    ipc.emit(notesChannels.NotesFlushRequest, 'a flush request');
    for (const stop of stops) stop();
    ipc.emit(notesChannels.NotesChanged, 'after unsubscribe');

    expect(heard).toEqual([
      ['changed', 'a note'],
      ['event', 'a run event'],
      ['pending', 'a pending generate'],
      ['flush', 'a flush request'],
    ]);
  });

  // A channel no member uses is a handler main registers for nothing, or an event the page never
  // hears; two members on one channel would answer each other's requests.
  it('uses every notes channel, each for one member', async () => {
    ipc.calls.length = 0;
    await notesBridge.getNotes(MEETING);
    await notesBridge.saveNote({ meetingId: MEETING, kind: 'user', doc: DOC });
    await notesBridge.resolveNoteConflict({ meetingId: MEETING, kind: 'user', keep: 'theirs' });
    await notesBridge.listNoteTemplates();
    await notesBridge.generateNotes({ meetingId: MEETING, templateId: 'general' });
    await notesBridge.cancelNotesGenerate(MEETING);
    await notesBridge.getPendingGenerate(MEETING);
    await notesBridge.getNotesRun({ meetingId: MEETING, runId: RUN });
    notesBridge.ackNotesFlush({ requestId: 'flush-2' });
    notesBridge.onNoteChanged(() => undefined)();
    notesBridge.onNotesEvent(() => undefined)();
    notesBridge.onPendingGenerateChanged(() => undefined)();
    notesBridge.onNotesFlushRequest(() => undefined)();

    const used = ipc.calls.map((call) => call.channel);
    expect(used.length).toBe(Object.keys(notesBridge).length);
    expect([...used].sort()).toEqual(Object.values(notesChannels).sort());
  });
});
