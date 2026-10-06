import type { NoteSyncState } from '../../../shared/notes';
import type { SaverState } from './debouncedSaver';

/**
 * The one save state a note shows (M4 plan, "Notes on the Mac"): first what the editor has not
 * handed to main yet (debouncedSaver.ts), then where main and NotesSync have the note
 * (`LocalNote.sync`). A failure never hides behind an older good state: a silent failure is the
 * bug this product exists to avoid.
 */

/** `quiet` needs nothing from the user; `warn` is safe but not done; `bad` lost a save. */
export type SaveStatusTone = 'quiet' | 'good' | 'warn' | 'bad';

export interface SaveStatus {
  /** The status line's words. */
  label: string;
  /** Why, or what to do: the line's tooltip and what a screen reader hears. */
  detail: string;
  tone: SaveStatusTone;
}

const SYNC_STATUS: Record<NoteSyncState, SaveStatus> = {
  saved_locally: {
    label: 'Saved on this Mac',
    detail: 'Roger uploads them to your workspace in a moment.',
    tone: 'quiet',
  },
  waiting_for_meeting: {
    label: 'Waiting for the meeting to upload',
    detail: 'Saved on this Mac. They upload once the meeting itself has.',
    tone: 'quiet',
  },
  syncing: {
    label: 'Syncing',
    detail: 'Saved on this Mac, and uploading to your workspace now.',
    tone: 'quiet',
  },
  synced: {
    label: 'Synced',
    detail: 'Saved on this Mac and in your workspace.',
    tone: 'good',
  },
  offline: {
    label: 'Offline: saved on this Mac',
    detail:
      'Roger cannot reach its server. The notes are safe here, and it uploads them when it can.',
    tone: 'warn',
  },
  conflict: {
    label: 'Two versions',
    detail:
      'These notes also changed somewhere else, and Roger kept both. Pick the version to keep.',
    tone: 'warn',
  },
};

/** The status line for a note; null for notes nobody has written yet (`sync` null). */
export function describeSaveStatus(
  saver: SaverState,
  sync: NoteSyncState | null,
): SaveStatus | null {
  switch (saver.phase) {
    case 'failed':
      return {
        label: 'Not saved',
        detail: `Roger could not save your latest changes on this Mac: ${saver.message}. Your text is still here, and Roger tries again as you type.`,
        tone: 'bad',
      };
    case 'pending':
    case 'saving':
      return {
        label: 'Saving...',
        detail: 'Writing your latest changes to this Mac.',
        tone: 'quiet',
      };
    case 'saved':
      return sync === null ? null : SYNC_STATUS[sync];
  }
}
