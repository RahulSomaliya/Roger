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
  'stop-failed',
  'meeting-blank-title',
  'two-cards',
  'taking-notes-call',
  'taking-notes-two',
  'read-failed',
  'click-failed',
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

/** What the stage behind the panel stands in for: a dark or a light call (`?backdrop=`). */
export type PromptBackdrop = 'dark' | 'light';

export function parsePromptBackdrop(search: string): PromptBackdrop {
  const backdrop = new URLSearchParams(search).get('backdrop') ?? 'dark';
  if (backdrop !== 'dark' && backdrop !== 'light') {
    throw new Error(`Unknown backdrop "${backdrop}": use dark or light`);
  }
  return backdrop;
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
    // The lines below are main's own (PromptService), in the plain words of the sweep's table.
    case 'start-failed':
      return panelState([
        calendarCard([northwind], { error: 'Roger could not start notes from here. Try again.' }),
      ]);
    case 'stop-failed':
      return panelState(
        [
          calendarCard([northwind], {
            error:
              'Roger could not stop the notes on Weekly sync. Stop them in Roger, then try again.',
          }),
        ],
        { recording: true, recordingTitle: 'Weekly sync' },
      );
    case 'meeting-blank-title':
      return panelState([
        calendarCard([
          calendarEvent({ id: 'event-blank', title: '', videoLink: null, ...startsIn(1) }),
        ]),
      ]);
    case 'two-cards':
      // Newest first, as main sends them: a call starting in 6 min, above the one in 1.
      return panelState([
        calendarCard(
          [
            calendarEvent({
              id: 'event-review',
              title: 'Quarterly review',
              videoLink: null,
              videoLinkSource: null,
              ...startsIn(6, 60),
            }),
          ],
          { id: 'prompt-5' },
        ),
        calendarCard([northwind], { id: 'prompt-1' }),
      ]);
    case 'taking-notes-call':
      return panelState([callDetectedCard({ phase: 'taking_notes' })], {
        recording: true,
        recordingTitle: 'Call in Zoom',
      });
    case 'taking-notes-two':
      return panelState(
        [
          calendarCard(
            [
              northwind,
              calendarEvent({
                id: 'event-standup',
                title: 'Daily standup',
                videoLink: null,
                videoLinkSource: null,
                ...startsIn(1, 15),
              }),
            ],
            { phase: 'taking_notes', startedEventId: 'event-standup' },
          ),
        ],
        { recording: true, recordingTitle: 'Daily standup' },
      );
    case 'read-failed':
      // No card: the fake api rejects the read (preview/prompt.tsx).
      return panelState([]);
    case 'click-failed':
      // A normal card; the fake api rejects its clicks (preview/prompt.tsx).
      return panelState([calendarCard([northwind])]);
  }
}
