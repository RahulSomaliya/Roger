import { useState } from 'react';
import { SlotOutlet } from '../app/SlotOutlet';
import { SaveStatusSlotContext } from '../notes/saveStatusSlot';
import { panelId, tabId, Tabs } from '../components/ui/Tabs';
import { type MeetingTab, TAB_LABEL, tabSpecs } from './panes';

/** Names the tab row for a screen reader, and keeps its ids apart from any other row's. */
const TABS_LABEL = 'Meeting';
const ID_PREFIX = 'meeting';

/**
 * The meeting page's regions behind one tab row: My notes and AI notes (M4-T20), the transcript
 * (M3-T9's live transcript panel) and chat (M4-T20), each the outlet of its slot, one at a time at
 * every width. A tab with nothing to show is not in `tabs` (panes.ts), and a row of one tab is not
 * drawn: the transcript alone has nothing to pick.
 *
 * Every pane stays MOUNTED and the others carry `hidden`, never unmounted: an editor keeps its
 * unsaved text and save timers, and the citation navigator finds a chip's lines in a hidden
 * transcript before showTranscript brings it forward (transcriptNavigator.ts). The global
 * `[hidden]` rule in styles.css makes that hold whatever `display` a pane's CSS sets.
 *
 * The tab row's right end holds the open note's save state ("Saved on this Mac", "Not saved"),
 * drawn there by the editors through a portal: no band of its own under the tabs (redesign R2).
 */
export function MeetingRegions({
  meetingId,
  tabs,
  tab,
  onTab,
}: {
  meetingId: string;
  tabs: readonly MeetingTab[];
  /** The tab shown (activeTab). */
  tab: MeetingTab;
  onTab: (tab: MeetingTab) => void;
}) {
  const row = tabs.length > 1;
  // The row's right end, where the open note's save state is drawn (notes/saveStatusSlot.ts).
  const [statusEnd, setStatusEnd] = useState<HTMLElement | null>(null);
  return (
    <div className="meeting-body">
      {row ? (
        <div className="meeting-tabbar">
          <Tabs
            tabs={tabSpecs(tabs)}
            selected={tab}
            onSelect={(id) => {
              const picked = tabs.find((each) => each === id);
              if (picked !== undefined) onTab(picked);
            }}
            label={TABS_LABEL}
            idPrefix={ID_PREFIX}
          />
          <div className="meeting-tabbar-status" ref={setStatusEnd} />
        </div>
      ) : null}
      {tabs.map((each) => (
        <div
          key={each}
          id={panelId(ID_PREFIX, each)}
          role={row ? 'tabpanel' : undefined}
          aria-labelledby={row ? tabId(ID_PREFIX, each) : undefined}
          aria-label={row ? undefined : TAB_LABEL[each]}
          className="meeting-pane"
          data-pane={each}
          hidden={each !== tab}
        >
          <SaveStatusSlotContext value={{ target: statusEnd, shown: each === tab }}>
            <Region meetingId={meetingId} tab={each} />
          </SaveStatusSlotContext>
        </div>
      ))}
    </div>
  );
}

function Region({ meetingId, tab }: { meetingId: string; tab: MeetingTab }) {
  switch (tab) {
    case 'mine':
      return <SlotOutlet name="meetingMyNotes" props={{ meetingId }} />;
    case 'ai':
      return <SlotOutlet name="meetingAiNotes" props={{ meetingId }} />;
    case 'transcript':
      return <SlotOutlet name="meetingTranscript" props={{ meetingId }} />;
    case 'chat':
      return <SlotOutlet name="meetingChat" props={{ meetingId }} />;
  }
}
