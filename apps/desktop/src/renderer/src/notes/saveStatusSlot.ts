import { createContext } from 'react';

/**
 * Where a notes editor shows its save state: the meeting page's tab row, at its right end
 * (regions.tsx), instead of a reserved band under the tabs (redesign R2). An editor inside a
 * provider draws its state into `target` with a portal; one outside any provider (a test, a
 * future page) keeps it above its own doc.
 *
 * `shown` is whether this editor's pane is the open tab. Every pane stays mounted, hidden, so the
 * row has one target and several editors: the quiet state ("Saved on this Mac") is drawn only by
 * the open tab, but a LOUD one ("Not saved") is drawn whichever tab is open, or a person looking
 * at the transcript would never learn that their notes are not being kept (house rule 1).
 */
export interface SaveStatusSlot {
  /** The row's end, or null until it has mounted (the state shows from the next render). */
  target: HTMLElement | null;
  shown: boolean;
}

export const SaveStatusSlotContext = createContext<SaveStatusSlot | null>(null);
