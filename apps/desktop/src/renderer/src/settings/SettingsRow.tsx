import type { ReactNode } from 'react';

interface SettingsRowProps {
  /** The setting's name: 14/20 semibold, in the label column. */
  label: string;
  /** The control it names, when it is one control: the label then points at it. */
  htmlFor?: string;
  /** For a group of controls (a radiogroup, the account's buttons): `aria-labelledby` reads this. */
  labelId?: string;
  /** Quiet words under the label: what the setting does, once. */
  help?: ReactNode;
  children: ReactNode;
}

/**
 * One row of a Settings section (sweep section 4): the label and its helper in a 240 px column,
 * the control beside it. At 720 px and up the two sit side by side; under it they stack
 * (settings.css). Every section's rows go through this, so the label column is one width on the
 * page and a label can never wander into the control column.
 */
export function SettingsRow({ label, htmlFor, labelId, help, children }: SettingsRowProps) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        {htmlFor === undefined ? (
          <span id={labelId} className="settings-label">
            {label}
          </span>
        ) : (
          <label htmlFor={htmlFor} className="settings-label">
            {label}
          </label>
        )}
        {help === undefined ? null : <p className="settings-help">{help}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}
