import { describe, expect, it } from 'vitest';
import { forgetCard, forgetLeaving, reconcileCards, type ShownCard } from './leavingCards';
import { callDetectedCard } from './promptTesting';

const card = (id: string) => callDetectedCard({ id });
const live = (...ids: string[]): ShownCard[] =>
  ids.map((id) => ({ card: card(id), leaving: false }));
const summary = (shown: ShownCard[]): string[] =>
  shown.map((entry) => `${entry.card.id}${entry.leaving ? ' (leaving)' : ''}`);

describe('reconcileCards', () => {
  it("shows main's cards in main's order", () => {
    expect(summary(reconcileCards([], [card('b'), card('a')]))).toEqual(['b', 'a']);
  });

  it('keeps a card main removed, leaving, where it was', () => {
    const next = reconcileCards(live('a', 'b', 'c'), [card('a'), card('c')]);
    expect(summary(next)).toEqual(['a', 'b (leaving)', 'c']);
  });

  it('keeps the last card while it leaves, so the page still has height to report', () => {
    expect(summary(reconcileCards(live('a'), []))).toEqual(['a (leaving)']);
  });

  it('keeps every card of a state that emptied the panel', () => {
    expect(summary(reconcileCards(live('a', 'b'), []))).toEqual(['a (leaving)', 'b (leaving)']);
  });

  it("puts a new card at main's top while an old one leaves", () => {
    const next = reconcileCards(live('a'), [card('n')]);
    expect(summary(next)).toEqual(['a (leaving)', 'n']);
  });

  it('makes a card live again when main sends it back while it leaves', () => {
    const leaving = reconcileCards(live('a'), []);
    expect(summary(reconcileCards(leaving, [card('a')]))).toEqual(['a']);
  });

  it('keeps showing a card that is still leaving through the next state', () => {
    const first = reconcileCards(live('a', 'b'), [card('b')]);
    expect(summary(reconcileCards(first, [card('b')]))).toEqual(['a (leaving)', 'b']);
  });
});

describe('forgetCard and forgetLeaving', () => {
  it('forgets only the leaving card whose exit ended', () => {
    const shown = reconcileCards(live('a', 'b'), [card('b')]);
    expect(summary(forgetCard(shown, 'a'))).toEqual(['b']);
    expect(summary(forgetCard(shown, 'b'))).toEqual(['a (leaving)', 'b']);
  });

  it('forgets all leaving cards as the backstop', () => {
    const shown = reconcileCards(live('a', 'b', 'c'), [card('b')]);
    expect(summary(forgetLeaving(shown))).toEqual(['b']);
  });
});
