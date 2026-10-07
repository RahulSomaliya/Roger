import { describe, expect, it } from 'vitest';
import {
  callDetectedButtons,
  eventButtons,
  openRogerButton,
} from '../src/renderer/src/prompt/promptButtons';
import {
  PROMPT_SCENARIO_IDS,
  parsePromptQuery,
  promptStateFor,
  type PromptScenarioId,
} from './promptScenarios';

const NOW = Date.parse('2026-10-07T09:00:00.000Z');

describe('promptStateFor', () => {
  it.each(PROMPT_SCENARIO_IDS)('%s holds a card the panel can draw', (id) => {
    const state = promptStateFor(id, NOW);
    expect(state.cards.length).toBeGreaterThan(0);
  });

  it('starts the calendar cards a minute after the clock it is given', () => {
    const [card] = promptStateFor('meeting-link', NOW).cards;
    if (card?.kind !== 'calendar') throw new Error('the meeting card is a calendar card');
    expect(Date.parse(card.events[0].start)).toBe(NOW + 60_000);
  });

  // Each scenario exists to show one row of the one-primary table (docs/design.md): pin the row.
  it.each<[PromptScenarioId, string | null]>([
    ['meeting-link', 'Join and start notes'],
    ['meeting-no-link', 'Start notes'],
    ['call-detected', 'Start notes'],
    ['taking-notes', null],
  ])('%s leads with %s', (id, primary) => {
    const [card] = promptStateFor(id, NOW).cards;
    if (card === undefined) throw new Error('no card');
    let buttons;
    if (card.phase === 'taking_notes') buttons = [openRogerButton(card)];
    else if (card.kind === 'calendar') buttons = eventButtons(card, card.events[0], true);
    else buttons = callDetectedButtons(card, true);
    expect(buttons.find((button) => button.variant === 'primary')?.label ?? null).toBe(primary);
  });

  it('says which note a start stops', () => {
    const state = promptStateFor('stops-other-note', NOW);
    expect(state.recording).toBe(true);
    expect(state.recordingTitle).toBe('Weekly sync');
  });

  it('fails a start with a reason on the card', () => {
    const [card] = promptStateFor('start-failed', NOW).cards;
    expect(card?.error).toContain('microphone');
  });
});

describe('parsePromptQuery', () => {
  it('defaults to the meeting with a link', () => {
    expect(parsePromptQuery('')).toBe('meeting-link');
  });

  it('refuses a card it does not know, naming the ones it does', () => {
    expect(() => parsePromptQuery('?card=nope')).toThrow(/meeting-link/);
  });
});
