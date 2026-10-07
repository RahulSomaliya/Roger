import type { PromptPanelState } from '../src/shared/ipc/prompt';
import {
  calendarCard,
  calendarEvent,
  callDetectedCard,
  panelState,
} from '../src/renderer/src/prompt/promptTesting';

/**
 * The states the prompt panel's preview (`preview/prompt.html?card=meeting-link`) opens in: what
 * main's PromptService would send in each, drawn by the panel's own page (PromptApp). The panel is
 * its own page with its own preload, so it has no `window.roger` scenario: a card is picked in the
 * query, and the fake `rogerPrompt` (preview/prompt.tsx) answers with this state.
 */
export const PROMPT_SCENARIO_IDS = [
  'meeting-link',
  'meeting-no-link',
  'two-meetings',
  'call-detected',
  'stops-other-note',
  'taking-notes',
  'start-failed',
] as const;
export type PromptScenarioId = (typeof PROMPT_SCENARIO_IDS)[number];

export function isPromptScenarioId(value: string): value is PromptScenarioId {
  return (PROMPT_SCENARIO_IDS as readonly string[]).includes(value);
}

/** The card a page opened without `?card=` shows. */
export const DEFAULT_PROMPT_SCENARIO: PromptScenarioId = 'meeting-link';

export function parsePromptQuery(search: string): PromptScenarioId {
  const card = new URLSearchParams(search).get('card') ?? DEFAULT_PROMPT_SCENARIO;
  if (!isPromptScenarioId(card)) {
    throw new Error(`Unknown prompt card "${card}": use one of ${PROMPT_SCENARIO_IDS.join(', ')}`);
  }
  return card;
}

const MINUTE_MS = 60_000;

/**
 * The panel's state for a scenario, anchored to `nowMs`: a card says "Starting in 1 min" from the
 * clock the page reads (PromptApp's `useNow`), so a fixed instant would drift out of its 10-minute
 * life. Titles are long on purpose: a card must wrap one, never grow sideways.
 */
export function promptStateFor(id: PromptScenarioId, nowMs: number): PromptPanelState {
  const startsIn = (minutes: number, minutesLong = 30): { start: string; end: string } => ({
    start: new Date(nowMs + minutes * MINUTE_MS).toISOString(),
    end: new Date(nowMs + (minutes + minutesLong) * MINUTE_MS).toISOString(),
  });
  const northwind = calendarEvent({
    id: 'event-northwind',
    title: 'Northwind renewal: pricing, the security addendum and the rollout plan',
    ...startsIn(1),
  });
  switch (id) {
    case 'meeting-link':
      return panelState([calendarCard([northwind])]);
    case 'meeting-no-link':
      return panelState([
        calendarCard([
          calendarEvent({
            id: 'event-lunch',
            title: 'Design review',
            videoLink: null,
            videoLinkSource: null,
            ...startsIn(1, 45),
          }),
        ]),
      ]);
    case 'two-meetings':
      return panelState([
        calendarCard([
          northwind,
          calendarEvent({
            id: 'event-standup',
            title: 'Daily standup',
            videoLink: null,
            videoLinkSource: null,
            ...startsIn(1, 15),
          }),
        ]),
      ]);
    case 'call-detected':
      return panelState([callDetectedCard()]);
    case 'stops-other-note':
      return panelState([calendarCard([northwind])], {
        recording: true,
        recordingTitle: 'Weekly sync',
      });
    case 'taking-notes':
      return panelState([calendarCard([northwind], { phase: 'taking_notes' })], {
        recording: true,
        recordingTitle: northwind.title,
      });
    case 'start-failed':
      return panelState([
        calendarCard([northwind], {
          error: 'Roger could not start notes: the microphone is in use by another app.',
        }),
      ]);
  }
}
