import type { NoteSyncState } from '../../../shared/notes';
import type { SaverState } from './debouncedSaver';

/**
 * The one save state a note shows (M4 plan, "Notes on the Mac"; docs/design.md, Copy). Saving is
 * normal, so only two states say anything: "Saved on this Mac" while the server cannot be reached,
 * and "Not saved" with its reason when a save failed. Everything else is silence: no "Syncing",
 * no green "Synced". A failure never hides behind an older good state (a silent failure is the
 * bug this product exists to avoid), so the editor's own failure outranks main's state.
 *
 * Trap: `saved_locally` is also what NotesSync writes when the server REFUSED an upload (a 401, a
 * 422), and it reads as silence here like the moment after every save. The notes are safe on this
 * Mac either way, but a refused upload shows nowhere on this line.
 */

/** `quiet` needs nothing from the user; `bad` lost a save, and says so loudly. */
export type SaveStatusTone = 'quiet' | 'bad';

export interface SaveStatus {
  /** The status line's words. */
  label: string;
  /** Why, or what to do: the line's tooltip and what a screen reader hears. */
  detail: string;
  tone: SaveStatusTone;
}

/** The states that say something; every other `NoteSyncState` shows nothing. */
const SYNC_STATUS: Partial<Record<NoteSyncState, SaveStatus>> = {
  offline: {
    label: 'Saved on this Mac',
    detail:
      'Roger cannot reach its server. The notes are safe here, and it uploads them when it can.',
    tone: 'quiet',
  },
};

/** The status line for a note; null when there is nothing to say (saved, or nothing written yet). */
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
      return null;
    case 'saved':
      return sync === null ? null : (SYNC_STATUS[sync] ?? null);
  }
}
