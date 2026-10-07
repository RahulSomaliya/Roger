import { describe, expect, it } from 'vitest';
import {
  PANEL_MARGIN,
  PANEL_WIDTH,
  displayUnder,
  promptBounds,
  type PromptDisplay,
} from './promptBounds';

const area = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** A display whose work area starts 25 px down: the menu bar. */
const display = (
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
): PromptDisplay => ({
  id,
  bounds: area(x, y, width, height),
  workArea: area(x, y + 25, width, height - 25),
});

const MAIN = display(1, 0, 0, 1440, 900);
const LEFT = display(2, -1920, -180, 1920, 1080);

describe('promptBounds', () => {
  it('puts the panel top right of the work area with a 16 px margin', () => {
    expect(PANEL_MARGIN).toBe(16);
    expect(promptBounds(MAIN.workArea, 140)).toEqual({
      x: 1440 - PANEL_WIDTH - 16,
      y: 25 + 16,
      width: PANEL_WIDTH,
      height: 140,
    });
  });

  it('keeps a negative origin: a display left of and above the main one', () => {
    const bounds = promptBounds(LEFT.workArea, 200);
    expect(bounds).toEqual({
      x: 0 - PANEL_WIDTH - 16,
      y: -180 + 25 + 16,
      width: PANEL_WIDTH,
      height: 200,
    });
    expect(bounds.x).toBeLessThan(0);
    expect(bounds.y).toBeLessThan(0);
  });

  it('clamps a panel taller than the work area, and one wider than it', () => {
    const tall = promptBounds(MAIN.workArea, 5000);
    expect(tall.y).toBe(MAIN.workArea.y + 16);
    expect(tall.y + tall.height).toBe(MAIN.workArea.y + MAIN.workArea.height - 16);

    const narrow = promptBounds(area(-300, 0, 200, 600), 100);
    expect(narrow.x).toBe(-300 + 16);
    expect(narrow.width).toBe(200 - 2 * 16);
  });

  it('rounds a fractional height up, so the last line is never clipped', () => {
    expect(promptBounds(MAIN.workArea, 140.4).height).toBe(141);
  });
});

describe('displayUnder', () => {
  const displays = [MAIN, LEFT];

  it('picks the display that holds the cursor, left of the main one included', () => {
    expect(displayUnder({ x: 700, y: 400 }, displays)).toBe(MAIN);
    expect(displayUnder({ x: -500, y: -100 }, displays)).toBe(LEFT);
  });

  it('treats a display edge as inside only on its near side', () => {
    expect(displayUnder({ x: 0, y: 0 }, displays)).toBe(MAIN);
    expect(displayUnder({ x: -1, y: 0 }, displays)).toBe(LEFT);
  });

  it('falls back to the nearest display for a cursor on none', () => {
    expect(displayUnder({ x: 5000, y: 400 }, displays)).toBe(MAIN);
    expect(displayUnder({ x: -5000, y: 400 }, displays)).toBe(LEFT);
  });

  it('refuses an empty list rather than guess a display', () => {
    expect(() => displayUnder({ x: 0, y: 0 }, [])).toThrow(/no display/);
  });
});
