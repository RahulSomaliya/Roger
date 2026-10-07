import { useState } from 'react';
import type { ResolveNoteConflictRequest } from '../../../shared/ipc/notes';
import { describeError } from '../app/describeError';
import { Icon } from '../components/ui/icons';

/**
 * Shown above a note main holds in `conflict` (M4 plan, "Conflict rule"), as a problem line (an
 * icon and plain words, no tint: docs/design.md, Problem line): the server had a newer
 * version, so the editor now shows it, and main keeps the local doc as the conflict copy. Nothing
 * is lost until the user picks: "Use mine" puts the copy back as the doc; "Keep this version"
 * drops the copy and keeps what the editor shows. Typing the editor had not saved when the 409
 * landed is kept the same way: it goes out on the doc it was typed on, and main keeps a save on a
 * replaced doc as the copy (followNoteDocument in useNoteDocument.ts). When the copy already holds
 * other typing, main holds the save on disk and makes it the copy once the user has picked here,
 * so the banner comes back for it. When the server's doc is one this build cannot show,
 * NoteEditor shows no editor but still this banner: "Use mine" is then the only way back to the
 * user's own notes.
 */

export interface ConflictBannerProps {
  /** Resolves once main has kept the choice; the doc it keeps then arrives as a note change. */
  onResolve: (keep: ResolveNoteConflictRequest['keep']) => Promise<void>;
  /** Whether the editor shows the other version (the default) or cannot (`docProblem`). */
  otherVersion?: 'shown' | 'unshowable';
}

export function ConflictBanner({ onResolve, otherVersion = 'shown' }: ConflictBannerProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = (keep: ResolveNoteConflictRequest['keep']): void => {
    setBusy(true);
    setError(null);
    onResolve(keep)
      .catch((failure: unknown) => {
        setError(describeError(failure));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <div className="problem note-conflict" role="alert">
      <Icon name="circle-alert" />
      <div className="problem-text">
        <p className="note-conflict-text">
          These notes also changed somewhere else.{' '}
          {otherVersion === 'shown'
            ? 'Roger shows that version here, and yours is kept as a copy until you choose.'
            : 'Roger cannot show that version, and yours is kept as a copy until you choose.'}
        </p>
        <div className="note-conflict-actions">
          <button
            type="button"
            className="btn"
            data-variant="secondary"
            data-size="sm"
            disabled={busy}
            onClick={() => {
              resolve('mine');
            }}
          >
            Use mine
          </button>
          <button
            type="button"
            className="btn"
            data-variant="ghost"
            data-size="sm"
            disabled={busy}
            onClick={() => {
              resolve('theirs');
            }}
          >
            {otherVersion === 'shown' ? 'Keep this version' : 'Keep the other version'}
          </button>
        </div>
        {error === null ? null : (
          <p className="note-conflict-error">Could not keep your choice: {error}</p>
        )}
      </div>
    </div>
  );
}
