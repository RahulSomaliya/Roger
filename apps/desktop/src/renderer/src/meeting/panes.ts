import type { TabList } from '../components/ui/Tabs';

/**
 * The meeting page's one tab row (docs/design.md, Tabs): My notes, AI notes, Transcript, Chat, one
 * pane at a time at every width. Your notes are the page; the others are a click away.
 */
export type MeetingTab = 'mine' | 'ai' | 'transcript' | 'chat';

/** The page's own label for each tab, and the name of its pane. */
export const TAB_LABEL: Readonly<Record<MeetingTab, string>> = {
  mine: 'My notes',
  ai: 'AI notes',
  transcript: 'Transcript',
  chat: 'Chat',
};

/** Which tabs have something to show (app/slots/, and whether AI notes exist). */
export interface MountedTabs {
  mine: boolean;
  /** The AI notes slot is mounted AND notes exist or are being written (MeetingPage). */
  ai: boolean;
  chat: boolean;
}

/**
 * The tabs the page shows, in a fixed order: your notes first, as that is what the user writes in
 * during the call, then the AI notes, the transcript and chat. A tab with nothing to show is left
 * out, so none ever opens onto nothing; the transcript is always there.
 */
export function meetingTabs(mounted: MountedTabs): readonly MeetingTab[] {
  return [
    ...(mounted.mine ? (['mine'] as const) : []),
    ...(mounted.ai ? (['ai'] as const) : []),
    'transcript',
    ...(mounted.chat ? (['chat'] as const) : []),
  ];
}

/** The tab the page shows: the one picked, while the page has it, else the first. */
export function activeTab(chosen: MeetingTab | null, tabs: readonly MeetingTab[]): MeetingTab {
  if (chosen !== null && tabs.includes(chosen)) return chosen;
  return tabs[0] ?? 'transcript';
}

/**
 * The tab row's specs. `Tabs` takes one to four (its `TabList` type); `meetingTabs` never gives
 * more, and this is where that stops being a hope: a fifth tab throws here, not in the layout.
 */
export function tabSpecs(tabs: readonly MeetingTab[]): TabList {
  const [first, second, third, fourth, extra] = tabs.map((tab) => ({
    id: tab,
    label: TAB_LABEL[tab],
  }));
  if (first === undefined || extra !== undefined) {
    throw new Error(`The meeting page shows 1 to 4 tabs, not ${tabs.length}`);
  }
  if (second === undefined) return [first];
  if (third === undefined) return [first, second];
  if (fourth === undefined) return [first, second, third];
  return [first, second, third, fourth];
}
