import { type KeyboardEvent, useState } from 'react';
import { isSlotEmpty, SlotOutlet } from '../app/SlotOutlet';
import { type MeetingPane, PANE_LABEL } from './panes';

/**
 * The meeting page's regions: the notes ("My notes" and "AI notes", M4-T20), the transcript
 * (M3-T9's live transcript panel) and chat (M4-T20), each the outlet of its slot. Side by side on
 * a wide page; one at a time on a narrow one, picked with the pane buttons (meeting.css). A pane
 * the narrow page does not show is hidden with CSS, never unmounted: an editor keeps its unsaved
 * text, and the citation navigator finds a chip's lines in a hidden transcript before
 * showTranscript brings it forward (transcriptNavigator.ts).
 */
export function MeetingRegions({
  meetingId,
  panes,
  pane,
  onPane,
}: {
  meetingId: string;
  panes: readonly MeetingPane[];
  /** The pane a narrow page shows (activePane). */
  pane: MeetingPane;
  onPane: (pane: MeetingPane) => void;
}) {
  const split = panes.length > 1;
  return (
    <div className="meeting-body" data-layout={split ? 'split' : 'single'}>
      {split ? <PaneButtons panes={panes} active={pane} onPick={onPane} /> : null}
      {panes.map((each) => (
        <div
          key={each}
          id={`meeting-pane-${each}`}
          className={`meeting-region meeting-region-${each}`}
          data-active={each === pane ? 'true' : undefined}
        >
          <Region meetingId={meetingId} pane={each} />
        </div>
      ))}
    </div>
  );
}

function Region({ meetingId, pane }: { meetingId: string; pane: MeetingPane }) {
  switch (pane) {
    case 'notes':
      return <NotesTabs meetingId={meetingId} />;
    case 'transcript':
      return <SlotOutlet name="meetingTranscript" props={{ meetingId }} />;
    case 'chat':
      return <SlotOutlet name="meetingChat" props={{ meetingId }} />;
  }
}

/**
 * Picks the pane a narrow page shows. On a wide page every pane shows and meeting.css hides these
 * buttons, so they are toggle buttons, not tabs: tabs would claim the other panes are hidden.
 */
function PaneButtons({
  panes,
  active,
  onPick,
}: {
  panes: readonly MeetingPane[];
  active: MeetingPane;
  onPick: (pane: MeetingPane) => void;
}) {
  return (
    <div className="meeting-pane-buttons" role="group" aria-label="Show">
      {panes.map((pane) => (
        <button
          key={pane}
          type="button"
          className="meeting-pane-button"
          aria-pressed={pane === active}
          aria-controls={`meeting-pane-${pane}`}
          onClick={() => {
            onPick(pane);
          }}
        >
          {PANE_LABEL[pane]}
        </button>
      ))}
    </div>
  );
}

type NotesTab = 'mine' | 'ai';

const NOTES_TABS: readonly {
  tab: NotesTab;
  label: string;
  slot: 'meetingMyNotes' | 'meetingAiNotes';
}[] = [
  { tab: 'mine', label: 'My notes', slot: 'meetingMyNotes' },
  { tab: 'ai', label: 'AI notes', slot: 'meetingAiNotes' },
];

/**
 * "My notes" and "AI notes" as tabs, both mounted (an editor keeps its text and its save timers),
 * the closed one `hidden`. Left and Right move between them, as the ARIA tabs pattern expects.
 */
function NotesTabs({ meetingId }: { meetingId: string }) {
  const tabs = NOTES_TABS.filter(({ slot }) => !isSlotEmpty(slot));
  const [open, setOpen] = useState<NotesTab>('mine');
  const shown = tabs.some(({ tab }) => tab === open) ? open : (tabs[0]?.tab ?? 'mine');

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const index = tabs.findIndex(({ tab }) => tab === shown);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next === undefined) return;
    event.preventDefault();
    setOpen(next.tab);
    document.getElementById(`meeting-notes-tab-${next.tab}`)?.focus();
  };

  return (
    <div className="meeting-notes">
      <div className="meeting-notes-tabs" role="tablist" aria-label="Notes" onKeyDown={onKeyDown}>
        {tabs.map(({ tab, label }) => (
          <button
            key={tab}
            id={`meeting-notes-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={tab === shown}
            aria-controls={`meeting-notes-panel-${tab}`}
            tabIndex={tab === shown ? 0 : -1}
            className="meeting-notes-tab"
            onClick={() => {
              setOpen(tab);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tabs.map(({ tab, slot }) => (
        <div
          key={tab}
          id={`meeting-notes-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`meeting-notes-tab-${tab}`}
          className="meeting-notes-panel"
          hidden={tab !== shown}
        >
          <SlotOutlet name={slot} props={{ meetingId }} />
        </div>
      ))}
    </div>
  );
}
