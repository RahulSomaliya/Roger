import { useId, useState } from 'react';
import type { MeetingSummary } from '../../../shared/meetings';
import { Icon } from '../components/ui/icons';
import { meetingDayLabel } from './labels';

/** How many past meetings Home lists before "Show more". */
export const EARLIER_VISIBLE = 10;

export interface EarlierProps {
  /** The newest meetings on this Mac, newest first (`meetings:list`); undefined until main answers. */
  meetings: readonly MeetingSummary[] | undefined;
  /** The meeting Roger records now, which the hero shows instead; null when none. */
  liveId: string | null;
  /** Why the last read failed, or null; the list keeps the answer before it. */
  error: string | null;
  now: Date;
  onOpen: (meetingId: string) => void;
  onRetry: () => void;
}

/**
 * Home's "Earlier": past meetings, a title and its day, newest first, ten of them and then "Show
 * more". It replaces the sidebar's recent list (docs/plans/redesign.md). An empty list is no
 * list: nothing renders, not even the heading. A failed read says so in a quiet problem line,
 * above the list it kept.
 */
export function Earlier({ meetings, liveId, error, now, onOpen, onRetry }: EarlierProps) {
  const headingId = useId();
  const [all, setAll] = useState(false);
  const past = (meetings ?? []).filter((meeting) => meeting.id !== liveId);
  const shown = all ? past : past.slice(0, EARLIER_VISIBLE);
  if (past.length === 0 && error === null) return null;
  return (
    <section className="earlier" aria-labelledby={headingId}>
      <h2 id={headingId} className="overline">
        Earlier
      </h2>
      {error === null ? null : (
        <div className="problem earlier-problem" role="status">
          <Icon name="circle-alert" />
          <span className="problem-text">{error}</span>
          <button type="button" className="btn" data-size="sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {shown.length === 0 ? null : (
        <ul className="earlier-list">
          {shown.map((meeting) => (
            <li key={meeting.id}>
              <button
                type="button"
                className="earlier-row"
                // The whole title, for one the row cuts short.
                title={meeting.title}
                onClick={() => {
                  onOpen(meeting.id);
                }}
              >
                <span className="earlier-when">{meetingDayLabel(meeting.startedAt, now)}</span>
                <span className="earlier-title">{meeting.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {all || past.length <= EARLIER_VISIBLE ? null : (
        <button
          type="button"
          className="btn earlier-more"
          data-variant="ghost"
          data-size="sm"
          onClick={() => {
            setAll(true);
          }}
        >
          Show more
        </button>
      )}
    </section>
  );
}
