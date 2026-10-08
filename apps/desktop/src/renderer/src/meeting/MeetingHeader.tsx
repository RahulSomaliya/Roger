import { useState } from 'react';
import { SlotOutlet } from '../app/SlotOutlet';
import { Dialog } from '../components/ui/Dialog';
import { Menu, type MenuEntry } from '../components/ui/Menu';
import type { HeaderAction } from './headerAction';

interface MeetingHeaderProps {
  meetingId: string;
  title: string;
  /** True while main has not answered the first read: the title is a placeholder. */
  pending: boolean;
  /** When it ran (meetingTimes.ts), or null when unknown. */
  time: string | null;
  /**
   * The meeting records or starts or stops now: no time line at all, because the status line
   * says "Recording · 39m" and a start time beside it told the time twice (redesign R9).
   */
  live: boolean;
  /** What Copy notes just did, said once beside the buttons and gone after a few seconds. */
  copied: string | null;
  /** The one primary button (headerAction.ts). */
  action: HeaderAction;
  onStop: () => void;
  onWrite: () => void;
  /** Cancel a generate main can still drop. */
  onCancelWrite: () => void;
  /** The ⋯ menu's entries (Write again as, Restore previous notes); no menu when empty. */
  menu: readonly MenuEntry[];
  /** Details has something to show: the meeting is on this Mac, or recording now. */
  details: boolean;
}

/**
 * The meeting's title, when it ran, the one primary button, the ⋯ menu and Details, with the
 * capture status line under them (docs/design.md, Components: status line, and the table of the
 * one primary). Stop stays here, on the meeting: the app header's recording chip only opens it.
 *
 * The status line is the `meetingCaptureStatus` slot (components/capture): "Recording · 12m", or
 * in its place a loud problem in words. It holds one line while recording (meeting.css), so a
 * problem that arrives mid-call never moves the editor under the person's cursor. Everything the
 * old capture panel showed (sources, saved and uploaded counts, the cost, recoveries, the report,
 * echo lines, kept audio) is in the Details dialog, the `meetingCaptureReport` slot, which mounts
 * only while it is open.
 */
export function MeetingHeader({
  meetingId,
  title,
  pending,
  time,
  live,
  copied,
  action,
  onStop,
  onWrite,
  onCancelWrite,
  menu,
  details,
}: MeetingHeaderProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <header className="meeting-header" data-recording={action.kind === 'stop' ? '' : undefined}>
      <div className="meeting-header-row">
        <div className="meeting-heading">
          <h1 className={pending ? 'meeting-title meeting-title-pending' : 'meeting-title'}>
            {title}
          </h1>
          {/*
            A line once the meeting is over, blank until the time is known: a header that grows
            when main answers shrinks the transcript under it after it scrolled to its newest
            line, cutting that off. While live there is none, from the first frame (R9).
          */}
          {live ? null : (
            <p className="meeting-time" aria-hidden={time === null ? true : undefined}>
              {time ?? '\u00a0'}
            </p>
          )}
        </div>
        <div className="meeting-actions">
          {/* Always mounted, so a screen reader hears the text the moment it appears. */}
          <p className="meeting-copied" role="status">
            {copied}
          </p>
          {/*
            Cancel sits LEFT of the primary: the primary keeps its place when a busy state adds
            Cancel, so a second click lands on the same button (redesign R3). All `sm`, Details'.
          */}
          {action.kind === 'writing' && action.cancellable ? (
            <button
              type="button"
              className="btn"
              data-variant="ghost"
              data-size="sm"
              aria-disabled={action.cancelling ? 'true' : undefined}
              onClick={() => {
                // Busy is aria-disabled, which CSS cannot enforce against the keyboard.
                if (!action.cancelling) onCancelWrite();
              }}
            >
              {action.cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          ) : null}
          <PrimaryAction action={action} onStop={onStop} onWrite={onWrite} />
          {menu.length === 0 ? null : <Menu label="More actions" items={menu} />}
          {details ? (
            <button
              type="button"
              className="btn"
              data-variant="ghost"
              data-size="sm"
              aria-haspopup="dialog"
              onClick={() => {
                setDetailsOpen(true);
              }}
            >
              Details
            </button>
          ) : null}
        </div>
      </div>
      <div className="meeting-status">
        <SlotOutlet name="meetingCaptureStatus" props={{ meetingId }} />
      </div>
      <Dialog
        open={detailsOpen}
        title="Details"
        onClose={() => {
          setDetailsOpen(false);
        }}
      >
        <SlotOutlet name="meetingCaptureReport" props={{ meetingId }} />
      </Dialog>
    </header>
  );
}

function PrimaryAction({
  action,
  onStop,
  onWrite,
}: {
  action: HeaderAction;
  onStop: () => void;
  onWrite: () => void;
}) {
  switch (action.kind) {
    case 'none':
      return null;
    // Busy keeps its full colour and says what it is doing: aria-disabled with no click handler
    // (or an early return, for Stop), never `disabled`, which reads as "you cannot"
    // (docs/design.md, Busy is not disabled).
    case 'start':
      return <BusyButton label="Starting…" />;
    case 'writing':
      return <BusyButton label="Writing notes…" />;
    case 'stop':
      return (
        <button
          type="button"
          className="btn"
          data-variant="primary"
          data-size="sm"
          aria-disabled={action.busy ? 'true' : undefined}
          onClick={() => {
            // CSS stops the pointer only: Enter and Space still click a busy button.
            if (!action.busy) onStop();
          }}
        >
          {action.busy ? 'Stopping…' : 'Stop'}
        </button>
      );
    case 'write':
      return (
        <button
          type="button"
          className="btn"
          data-variant="primary"
          data-size="sm"
          onClick={onWrite}
        >
          Write notes
        </button>
      );
  }
}

function BusyButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="btn"
      data-variant="primary"
      data-size="sm"
      aria-disabled="true"
    >
      {label}
    </button>
  );
}
