import { useEffect, useState } from 'react';
import type { MenuEntry } from '../components/ui/Menu';
import { copyNotes } from './copyNotes';
import type { MeetingTab } from './panes';
import { rogerNotes } from './useMeeting';

/** How long "Notes copied" stays beside the buttons. */
const COPIED_VISIBLE_MS = 3000;

type CopyNote = { status: string } | { problem: string } | null;

export interface CopyNotesView {
  /** Copy notes for the more-actions menu: only while My notes or the AI notes are the open tab. */
  entries: readonly MenuEntry[];
  /** What it just did, said beside the buttons for a few seconds; null otherwise. */
  status: string | null;
  /** Why a copy failed, until dismissed (a problem line, never a swallowed error). */
  problem: string | null;
  dismissProblem: () => void;
}

/**
 * Copy notes (redesign D5): the menu entry for the notes in view and what it said. A hook of its
 * own, not inline in MeetingPage: the React Compiler skipped the page ("existing memoization could
 * not be preserved" on showTranscript) once these effects and closures lived there.
 */
export function useCopyNotes(meetingId: string, shownTab: MeetingTab): CopyNotesView {
  const [note, setNote] = useState<CopyNote>(null);
  useEffect(() => {
    if (note === null || 'problem' in note) return;
    const timer = setTimeout(() => {
      setNote(null);
    }, COPIED_VISIBLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [note]);
  const kind = shownTab === 'mine' ? 'user' : shownTab === 'ai' ? 'ai' : null;
  const entries: MenuEntry[] =
    kind === null
      ? []
      : [
          {
            id: 'copy-notes',
            label: 'Copy notes',
            onSelect: () => {
              void copyNotes(
                {
                  getNotes: (id) => rogerNotes.getNotes(id),
                  writeText: (text) => navigator.clipboard.writeText(text),
                },
                meetingId,
                kind,
              ).then((outcome) => {
                // Only a write that resolved says "copied": an empty note or a refused clipboard
                // must never read as a copy that left the clipboard as it was.
                setNote(
                  outcome.kind === 'copied'
                    ? { status: 'Notes copied' }
                    : outcome.kind === 'empty'
                      ? { status: 'No notes to copy yet' }
                      : { problem: `Roger could not copy the notes: ${outcome.reason}` },
                );
              });
            },
          },
        ];
  return {
    entries,
    status: note !== null && 'status' in note ? note.status : null,
    problem: note !== null && 'problem' in note ? note.problem : null,
    dismissProblem: () => {
      setNote(null);
    },
  };
}
