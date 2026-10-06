import { useState } from 'react';
import type { ResolveNoteConflictRequest } from '../../../shared/ipc/notes';
import { describeError } from '../app/describeError';

/**
 * Shown above a note main holds in `conflict` (M4 plan, "Conflict rule"): the server had a newer
 * version, so the editor now shows it, and main keeps the local doc as the conflict copy. Nothing
 * is lost until the user picks: "Use mine" puts the copy back as the doc; "Keep this version"
 * drops the copy and keeps what the editor shows. Not yet when the 409 meets typing the editor has
 * not saved: main stores that typing over the server's doc (followNoteDocument in
 * useNoteDocument.ts says why, and what main must change). When the server's doc is one this
 * build cannot show, NoteEditor shows no editor but still this banner: "Use mine" is then the only
 * way back to the user's own notes.
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
    <div className="note-conflict" role="alert">
      <p className="note-conflict-text">
        <strong>These notes also changed somewhere else.</strong>{' '}
        {otherVersion === 'shown'
          ? 'Roger shows that version here, and yours is kept as a copy until you choose.'
          : 'Roger cannot show that version, and yours is kept as a copy until you choose.'}
      </p>
      <div className="note-conflict-actions">
        <button
          type="button"
          className="note-button note-button-primary"
          disabled={busy}
          onClick={() => {
            resolve('mine');
          }}
        >
          Use mine
        </button>
        <button
          type="button"
          className="note-button"
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
  );
}
