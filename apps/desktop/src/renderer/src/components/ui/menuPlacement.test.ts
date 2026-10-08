import { describe, expect, it } from 'vitest';
import { menuSide } from './menuPlacement';

// A 200 px list, a 390 px window, an 8 px margin to the window's edge.
const list = 200;
const window390 = 390;
const gutter = 8;
const anchor = (left: number, right = left + 32): { left: number; right: number } => ({
  left,
  right,
});

describe('menuSide', () => {
  it('keeps the side asked for when the list fits there', () => {
    expect(menuSide('end', anchor(300), list, window390, gutter)).toBe('end');
    expect(menuSide('start', anchor(16), list, window390, gutter)).toBe('start');
  });

  // QA (redesign R13): at 390 the header's actions wrap under the title, the trigger sits at the
  // left edge, and an end-aligned list ran 142 px off the window.
  it('flips to the other side when the list would run off the window', () => {
    expect(menuSide('end', anchor(16), list, window390, gutter)).toBe('start');
    expect(menuSide('start', anchor(340), list, window390, gutter)).toBe('end');
  });

  it('takes the side that loses less when neither fits', () => {
    // A 380 px list: starting at 200 it runs 198 px past the right margin, ending at 232 only
    // 156 px past the left one.
    expect(menuSide('start', anchor(200), 380, window390, gutter)).toBe('end');
    expect(menuSide('end', anchor(200), 380, window390, gutter)).toBe('end');
  });
});
