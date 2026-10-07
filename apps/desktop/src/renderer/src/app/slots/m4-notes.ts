import { createElement, useEffect } from 'react';
import { MeetingChat } from '../../chat/MeetingChat';
import { AiNotesPanel } from '../../notes/AiNotesPanel';
import { notesFlushResponder } from '../../notes/debouncedSaver';
import { NoteEditor } from '../../notes/NoteEditor';
import type { MeetingSlotProps, SlotContributions } from '../slotRegistry';

/** The "My notes" tab. The label is the tab's name: it is the editor's accessible name too. */
function MyNotes({ meetingId }: MeetingSlotProps) {
  return createElement(NoteEditor, {
    meetingId,
    kind: 'user',
    label: 'My notes',
    placeholder: 'Type your notes. Roger turns them into clean notes after the call.',
  });
}

/**
 * Starts the page's one answer to main's `notes:flush-request` as the app starts, and draws
 * nothing. Mounted in the banner, which every page shows and keeps across routes, not in a
 * meeting region: a window that never opened a meeting's notes (Home, Settings) must ack as well,
 * or main's quit and every Stop of a meeting nobody spoke in wait their full 1 s for it, and that
 * Stop keeps the meeting for the uploader to discard instead of discarding it (the contract is
 * notesFlushResponder's, notes/debouncedSaver.ts). An effect, never a render-time call: the
 * responder subscribes to `window.roger`, which a render under Node does not have.
 */
function StartNotesFlushResponder() {
  useEffect(() => {
    notesFlushResponder();
  }, []);
  return null;
}

/**
 * What M4-T20 mounts: My notes, AI notes and the meeting chat (all inside the meeting page's
 * CitationNavigatorProvider, which their chips reveal lines through) and the flush responder's
 * start. Slot names and their props: ../slotRegistry.ts. No Settings section: the redesign
 * deleted the notes preferences (R6; notes/NotesSettings.tsx goes with R4).
 */
export const contributions: SlotContributions = {
  banner: [{ id: 'm4-notes-flush', order: 0, component: StartNotesFlushResponder }],
  meetingMyNotes: [{ id: 'm4-my-notes', order: 0, component: MyNotes }],
  meetingAiNotes: [{ id: 'm4-ai-notes', order: 0, component: AiNotesPanel }],
  meetingChat: [{ id: 'm4-chat', order: 0, component: MeetingChat }],
};
