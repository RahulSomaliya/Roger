import type { MeetingNotes, NoteKind } from '../../../shared/notes';
import { describeError } from '../app/describeError';
import { noteDocText } from '../notes/noteText';

/** What the page says after Copy notes: only `copied` may ever read as "Notes copied". */
export type CopyOutcome =
  { kind: 'copied' } | { kind: 'empty' } | { kind: 'failed'; reason: string };

export interface CopyNotesDeps {
  getNotes: (meetingId: string) => Promise<MeetingNotes>;
  writeText: (text: string) => Promise<void>;
}

/**
 * "Copy notes" in the more-actions menu (redesign sweep D5): the plain text of the notes that are
 * in view (`kind`: My notes or the AI notes), no chip times (noteText.ts). It reads the stored doc
 * from main, not the editor: the editor saves on blur, and choosing a menu item blurs it, so the
 * read comes after the save on the same IPC channel.
 *
 * Honest by construction: an empty doc copies nothing (`empty`, the page says so rather than
 * "Notes copied" over an unchanged clipboard) and a refused clipboard or failed read is `failed`
 * with its reason, never swallowed (house rule 1).
 */
export async function copyNotes(
  deps: CopyNotesDeps,
  meetingId: string,
  kind: NoteKind,
): Promise<CopyOutcome> {
  try {
    const notes = await deps.getNotes(meetingId);
    const note = kind === 'user' ? notes.user : notes.ai;
    const text = note === null ? '' : noteDocText(note.doc);
    if (text === '') return { kind: 'empty' };
    await deps.writeText(text);
    return { kind: 'copied' };
  } catch (error) {
    return { kind: 'failed', reason: describeError(error) };
  }
}
