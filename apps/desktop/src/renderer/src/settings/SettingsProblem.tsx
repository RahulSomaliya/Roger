import type { ReactNode } from 'react';
import { Icon } from '../components/ui/icons';

interface SettingsProblemProps {
  /** `alert` for what the person must act on (a refused save), `status` for a quiet note. */
  role: 'alert' | 'status';
  /** What happened and what to do, in one sentence. */
  children: ReactNode;
  /** At most one secondary action, such as Try again. */
  action?: ReactNode;
  /** For an input's `aria-describedby`. */
  id?: string;
}

/**
 * A problem on a Settings section: the shared `.problem` line (styles.css) with its icon, no box
 * and no red. Both sections use it, so the icon, the roles and the one-action rule live here.
 */
export function SettingsProblem({ role, children, action, id }: SettingsProblemProps) {
  return (
    <div id={id} className="problem" role={role}>
      <Icon name="circle-alert" />
      <span className="problem-text">{children}</span>
      {action}
    </div>
  );
}
