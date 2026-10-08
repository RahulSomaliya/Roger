import type {
  CalendarPromptCard,
  CallDetectedPromptCard,
  PromptCard,
  TimedCalendarEvent,
} from '../../../shared/calendar';
import type { PromptActionRequest } from '../../../shared/ipc/prompt';
import { parseJoinLink } from '../../../shared/meetingLinks';
import type { IconName } from '../components/ui/icons';

/**
 * What each card's buttons say and send (M5-T10), as data: the panel draws them, and the tests
 * read the exact words and requests without a DOM. Every request names its card by `id`, and a
 * calendar start names its event (`eventId`): a card can hold two calls, and a start without the
 * id would be ambiguous (shared/ipc/prompt.ts).
 *
 * One primary per view (docs/design.md, "The one primary"): the panel's first start is the accent
 * fill and every later one is outlined, so two calls on a card, or two cards, never show two.
 */

export interface PromptButton {
  label: string;
  /** primary: the accent fill; secondary: outlined; ghost: text only (`.btn` in prompt.css). */
  variant: 'primary' | 'secondary' | 'ghost';
  /** Set for an icon-only button: `label` is then its accessible name and tooltip, not its text. */
  icon?: IconName;
  request: PromptActionRequest;
}

/** `leading` is false for every start after the panel's first: it keeps the fill off them. */
function startVariant(leading: boolean): PromptButton['variant'] {
  return leading ? 'primary' : 'secondary';
}

/**
 * The start buttons of one call on a calendar card. "Join and start notes" only for a link main
 * would open: `parseJoinLink` is the check main makes before `openExternal`, so a link it would
 * refuse never gets a button that does nothing. A start while a note records stops that note
 * first (PromptService); the panel says so once, in its helper line, so the labels stay the same.
 */
export function eventButtons(
  card: CalendarPromptCard,
  event: TimedCalendarEvent,
  leading = true,
): PromptButton[] {
  const buttons: PromptButton[] = [];
  const hasLink = event.videoLink !== null && parseJoinLink(event.videoLink) !== null;
  if (hasLink) {
    buttons.push({
      label: 'Join and start notes',
      variant: startVariant(leading),
      request: { cardId: card.id, action: 'join_and_take_notes', eventId: event.id },
    });
  }
  buttons.push({
    label: 'Start notes',
    variant: hasLink ? 'ghost' : startVariant(leading),
    request: { cardId: card.id, action: 'take_notes', eventId: event.id },
  });
  return buttons;
}

/** A call-detected card starts with no event: it is stored as `call_detected` (D5 rule 4). */
export function callDetectedButtons(card: CallDetectedPromptCard, leading = true): PromptButton[] {
  return [
    {
      label: 'Start notes',
      variant: startVariant(leading),
      request: { cardId: card.id, action: 'take_notes' },
    },
  ];
}

/**
 * Dismiss: an x icon button at the card's top right (redesign sweep, section 3). It used to be a
 * word alone on a footer row, a third of the card for the least-used control; as an icon it frees
 * that row for the start buttons. The name stays "Dismiss" (the button's `aria-label` and tooltip),
 * because a bare x says nothing to a screen reader. Copy notice left the panel with the redesign
 * (docs/plans/redesign.md, call 7): the notice is one click away on the meeting page.
 */
export function dismissButton(card: PromptCard): PromptButton {
  return {
    label: 'Dismiss',
    icon: 'x',
    variant: 'ghost',
    request: { cardId: card.id, action: 'dismiss' },
  };
}

/** "Recording and Open Roger": the one click that may bring Roger's window forward. */
export function openRogerButton(card: CalendarPromptCard | CallDetectedPromptCard): PromptButton {
  return {
    label: 'Open Roger',
    variant: 'ghost',
    request: { cardId: card.id, action: 'open_roger' },
  };
}
