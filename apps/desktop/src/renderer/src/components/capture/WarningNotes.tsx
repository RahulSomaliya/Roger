import type { CaptureWarning } from '../../../../shared/capture';
import { formatClockTime } from '../../app/labels';
import { groupWarnings } from './captureProblems';
import './captureDetails.css';

/**
 * What is wrong with capture now, in main's full words, in Details: the loud problems the banner
 * and the status line say in a few words, then the quiet ones ("Call audio is silent. That is
 * normal in a pause") that no longer take a box above the page (docs/plans/redesign.md, Banners
 * and warnings). Details is where the message that says what to do is always whole.
 */
export function WarningNotes({ warnings }: { warnings: readonly CaptureWarning[] }) {
  const rows = [
    ...groupWarnings(warnings, true).map((group) => ({ loud: true, group })),
    ...groupWarnings(warnings, false).map((group) => ({ loud: false, group })),
  ];
  if (rows.length === 0) return null;
  return (
    <section className="details-section" aria-label="Happening now">
      <h3 className="details-heading">Happening now</h3>
      <ul className="details-list">
        {rows.map(({ loud, group }) => (
          <li key={`${loud ? 'loud' : 'quiet'}/${group.source ?? 'none'}`} data-loud={loud}>
            {group.messages.join(' ')}{' '}
            <span className="problem-since">since {formatClockTime(group.since)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
