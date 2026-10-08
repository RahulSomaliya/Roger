import type { PromptCard } from '../../../shared/calendar';

/**
 * Cards that main has removed but the page still draws while they slide out (redesign sweep, P3).
 * Main's state lists only the cards that exist now, so a card that left is simply absent from the
 * next state; the page keeps its last copy, marked `leaving`, until its exit animation ends and
 * only then forgets it. PromptWindow hides the window when the page reports height 0, which is
 * what forgetting the last one produces: that is how "exit before hide" holds.
 *
 * Pure, so the order rules are tested without a DOM.
 */
export interface ShownCard {
  card: PromptCard;
  /** Main has removed it; it is playing its exit and takes no clicks. */
  leaving: boolean;
}

/**
 * The cards to draw after main sent `next`: those, in main's order, with every card that was drawn
 * before and is gone now kept as `leaving` at the place it held (clamped to the list's end). A card
 * that comes back while leaving (same id) is live again.
 */
export function reconcileCards(
  previous: readonly ShownCard[],
  next: readonly PromptCard[],
): ShownCard[] {
  const shown: ShownCard[] = next.map((card) => ({ card, leaving: false }));
  const live = new Set(next.map((card) => card.id));
  previous.forEach((entry, index) => {
    if (live.has(entry.card.id)) return;
    shown.splice(Math.min(index, shown.length), 0, { card: entry.card, leaving: true });
  });
  return shown;
}

/** Forgets one card whose exit ended. A live card with that id is left alone. */
export function forgetCard(shown: readonly ShownCard[], cardId: string): ShownCard[] {
  return shown.filter((entry) => !(entry.leaving && entry.card.id === cardId));
}

/** Forgets every leaving card: the backstop for an exit whose animationend never came. */
export function forgetLeaving(shown: readonly ShownCard[]): ShownCard[] {
  return shown.filter((entry) => !entry.leaving);
}
