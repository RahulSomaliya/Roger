import type { ReactNode } from 'react';
import { Icon } from '../ui/icons';

/**
 * A capture problem as docs/design.md draws it: an icon, one sentence and at most one action, no
 * box and no tint. `loud` is `role="alert"` (weight 600, read out at once) and a quiet one is
 * `role="status"` in `ink-muted`; the rules are `.problem` in styles.css. Everything the shell
 * and Details say about capture goes through this, so a problem never comes back as a coloured
 * box.
 */
export function ProblemLine({
  loud,
  children,
  action,
}: {
  loud: boolean;
  children: ReactNode;
  /** The one secondary action ("Try again"), or nothing. */
  action?: ReactNode;
}) {
  return (
    <div className="problem" role={loud ? 'alert' : 'status'}>
      <Icon name="circle-alert" />
      <span className="problem-text">{children}</span>
      {action}
    </div>
  );
}
