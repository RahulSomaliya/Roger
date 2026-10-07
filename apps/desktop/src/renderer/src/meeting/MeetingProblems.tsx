import type { ReactNode } from 'react';
import { Dialog } from '../components/ui/Dialog';
import { Icon } from '../components/ui/icons';
import type { Confirmation } from '../notes/aiNotesActions';

/**
 * A problem on the meeting page: an icon, one sentence and one secondary action, no box and no
 * tint (docs/design.md, Problem line). `role="alert"`: the person must hear about a meeting that
 * cannot be read or notes that did not start, and it sits right under the header, where a loud
 * problem belongs.
 */
export function MeetingProblem({
  children,
  action,
  onAction,
}: {
  children: ReactNode;
  /** The one action's label ("Try again", "Dismiss"). */
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="problem meeting-problem" role="alert">
      <Icon name="circle-alert" />
      <span className="problem-text">{children}</span>
      <button
        type="button"
        className="btn"
        data-variant="secondary"
        data-size="sm"
        onClick={onAction}
      >
        {action}
      </button>
    </div>
  );
}

/**
 * The question before AI notes the person edited since their run are replaced: writing them again
 * or restoring an earlier version. The edits are in no run, so nothing would bring them back
 * (aiNotesActions.ts, `editedSinceRun`). Neither answer is the primary: this is a question, and
 * the page's one primary is not on screen while AI notes exist.
 */
export function ReplaceNotesDialog({
  confirm,
  onConfirm,
  onKeep,
}: {
  confirm: Confirmation | null;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  const again = confirm?.action === 'regenerate';
  return (
    <Dialog open={confirm !== null} title="Replace your edited AI notes?" onClose={onKeep}>
      <p>
        {again
          ? 'You changed these notes since Roger wrote them. Writing them again replaces your changes; Restore previous notes brings this version back.'
          : 'You changed these notes since Roger wrote them. Roger cannot bring your changes back afterwards.'}
      </p>
      <div className="dialog-actions">
        <button type="button" className="btn" data-variant="ghost" onClick={onKeep}>
          Keep my edits
        </button>
        <button type="button" className="btn" data-variant="secondary" onClick={onConfirm}>
          {again ? 'Write again' : 'Restore'}
        </button>
      </div>
    </Dialog>
  );
}
