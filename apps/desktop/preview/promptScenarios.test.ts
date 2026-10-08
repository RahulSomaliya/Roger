import { describe, expect, it } from 'vitest';
import {
  callDetectedButtons,
  eventButtons,
  openRogerButton,
} from '../src/renderer/src/prompt/promptButtons';
import {
  PROMPT_SCENARIO_IDS,
  parsePromptBackdrop,
  parsePromptQuery,
  promptStateFor,
  type PromptScenarioId,
} from './promptScenarios';

const NOW = Date.parse('2026-10-07T09:00:00.000Z');

describe('promptStateFor', () => {
  it.each(PROMPT_SCENARIO_IDS.filter((id) => id !== 'read-failed'))(
    '%s holds a card the panel can draw',
    (id) => {
      expect(promptStateFor(id, NOW).cards.length).toBeGreaterThan(0);
    },
  );

  it('has a scenario for every kind of card in the sweep brief', () => {
    expect([...PROMPT_SCENARIO_IDS].sort()).toEqual(
      [
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
      ].sort(),
    );
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

  it('fails a start with a plain reason on the card, never a vendor or an errno', () => {
    for (const id of ['start-failed', 'stop-failed'] as const) {
      const [card] = promptStateFor(id, NOW).cards;
      expect(card?.error).toMatch(/^Roger could not /);
      expect(card?.error).not.toMatch(/HTTP|xAI|ECONN|SQLITE/);
    }
  });

  it('puts the newest card first when two are up', () => {
    const [newest, older] = promptStateFor('two-cards', NOW).cards;
    if (newest?.kind !== 'calendar' || older?.kind !== 'calendar') throw new Error('two cards');
    expect(Date.parse(newest.events[0].start)).toBeGreaterThan(Date.parse(older.events[0].start));
  });

  it('names the call that started on a card of two', () => {
    const [card] = promptStateFor('taking-notes-two', NOW).cards;
    expect(card).toMatchObject({ phase: 'taking_notes', startedEventId: 'event-standup' });
  });
});

describe('parsePromptBackdrop', () => {
  it('defaults to a dark call and takes light', () => {
    expect(parsePromptBackdrop('')).toBe('dark');
    expect(parsePromptBackdrop('?backdrop=light')).toBe('light');
  });

  it('refuses anything else', () => {
    expect(() => parsePromptBackdrop('?backdrop=red')).toThrow(/dark or light/);
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
