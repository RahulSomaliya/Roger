import { notesChannels, type NotesApi } from '../../shared/ipc/notes';
import { invoke, send, subscribe } from '../bridge';

/** Notes' part of `window.roger`. */
export const notesBridge: NotesApi = {
  getNotes: (meetingId) => invoke(notesChannels.NotesGet, meetingId),
  saveNote: (request) => invoke(notesChannels.NotesSave, request),
  resolveNoteConflict: (request) => invoke(notesChannels.NotesResolveConflict, request),
  listNoteTemplates: () => invoke(notesChannels.NotesListTemplates),
  generateNotes: (request) => invoke(notesChannels.NotesGenerate, request),
  cancelNotesGenerate: (meetingId) => invoke(notesChannels.NotesCancelGenerate, meetingId),
  getPendingGenerate: (meetingId) => invoke(notesChannels.NotesGetPendingGenerate, meetingId),
  getNotesRun: (request) => invoke(notesChannels.NotesGetRun, request),
  ackNotesFlush: (ack) => {
    send(notesChannels.NotesFlushAck, ack);
  },
  onNoteChanged: (listener) => subscribe(notesChannels.NotesChanged, listener),
  onNotesEvent: (listener) => subscribe(notesChannels.NotesEvent, listener),
  onPendingGenerateChanged: (listener) =>
    subscribe(notesChannels.NotesPendingGenerateChanged, listener),
  onNotesFlushRequest: (listener) => subscribe(notesChannels.NotesFlushRequest, listener),
};
