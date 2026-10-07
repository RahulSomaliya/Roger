import type {
  CalendarPromptCard,
  CallDetectedPromptCard,
  PromptCard,
  TimedCalendarEvent,
} from '../../../shared/calendar';
import type { PromptActionRequest, PromptPanelState } from '../../../shared/ipc/prompt';
import { parseJoinLink } from '../../../shared/meetingLinks';

/**
 * What each card's buttons say and send (M5-T10), as data: the panel draws them, and the tests
 * read the exact words and requests without a DOM. Every request names its card by `id`, and a
 * calendar start names its event (`eventId`): a card can hold two calls, and a start without the
 * id would be ambiguous (shared/ipc/prompt.ts).
 */

export interface PromptButton {
  label: string;
  /** primary: the fill; secondary: outlined; quiet: text only. */
  tone: 'primary' | 'secondary' | 'quiet';
  request: PromptActionRequest;
}

/**
 * The start buttons of one call on a calendar card. "Join and take notes" only for a link main
 * would open: `parseJoinLink` is the check main makes before `openExternal`, so a link it would
 * refuse never gets a button that does nothing. While a note is starting or recording a start
 * stops it first (PromptService), and the words say so.
 */
export function eventButtons(
  card: CalendarPromptCard,
  event: TimedCalendarEvent,
  recording: boolean,
): PromptButton[] {
  const buttons: PromptButton[] = [];
  const hasLink = event.videoLink !== null && parseJoinLink(event.videoLink) !== null;
  if (hasLink) {
    buttons.push({
      label: recording ? 'Stop current note and join' : 'Join and take notes',
      tone: 'primary',
      request: { cardId: card.id, action: 'join_and_take_notes', eventId: event.id },
    });
  }
  buttons.push({
    label: recording ? 'Stop current note and start' : 'Take notes',
    tone: hasLink ? 'secondary' : 'primary',
    request: { cardId: card.id, action: 'take_notes', eventId: event.id },
  });
  return buttons;
}

/** A call-detected card starts with no event: it is stored as `call_detected` (D5 rule 4). */
export function callDetectedButtons(
  card: CallDetectedPromptCard,
  recording: boolean,
): PromptButton[] {
  return [
    {
      label: recording ? 'Stop current note and start' : 'Take notes',
      tone: 'primary',
      request: { cardId: card.id, action: 'take_notes' },
    },
  ];
}

/**
 * The card's own buttons below its calls: Copy notice (a calendar card, while `notice.enabled` is
 * on; D5 gives a call-detected card Take notes and Dismiss only) and Dismiss.
 */
export function footerButtons(card: PromptCard, state: PromptPanelState): PromptButton[] {
  const buttons: PromptButton[] = [];
  if (card.kind === 'calendar' && state.noticeEnabled) {
    buttons.push({
      label: 'Copy notice',
      tone: 'quiet',
      request: { cardId: card.id, action: 'copy_notice' },
    });
  }
  buttons.push({
    label: 'Dismiss',
    tone: 'quiet',
    request: { cardId: card.id, action: 'dismiss' },
  });
  return buttons;
}

/** "Taking notes · Open Roger": the one click that may bring Roger's window forward. */
export function openRogerButton(card: CalendarPromptCard | CallDetectedPromptCard): PromptButton {
  return {
    label: 'Open Roger',
    tone: 'quiet',
    request: { cardId: card.id, action: 'open_roger' },
  };
}
