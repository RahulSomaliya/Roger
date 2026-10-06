/**
 * The meeting page's panes. On a wide page they sit side by side; on a narrow one (the window
 * opens 520 wide) one shows at a time and a row of buttons picks it (meeting.css, regions.tsx).
 */
export type MeetingPane = 'notes' | 'transcript' | 'chat';

/** The page's own label for each pane, on the narrow page's buttons and as region names. */
export const PANE_LABEL: Readonly<Record<MeetingPane, string>> = {
  notes: 'Notes',
  transcript: 'Transcript',
  chat: 'Chat',
};

/** Which regions have something mounted in their slots (app/slots/). */
export interface MountedRegions {
  notes: boolean;
  chat: boolean;
}

/**
 * The panes the page shows, in order: the notes first, as the notepad is what the user writes in
 * during the call, then the transcript, then chat. A region with nothing mounted is left out, so
 * no tab ever opens onto nothing; the transcript is always there.
 */
export function meetingPanes(mounted: MountedRegions): readonly MeetingPane[] {
  return [
    ...(mounted.notes ? (['notes'] as const) : []),
    'transcript',
    ...(mounted.chat ? (['chat'] as const) : []),
  ];
}

/** The pane a narrow page shows: the one picked, while the page has it, else the first. */
export function activePane(chosen: MeetingPane | null, panes: readonly MeetingPane[]): MeetingPane {
  if (chosen !== null && panes.includes(chosen)) return chosen;
  return panes[0] ?? 'transcript';
}
