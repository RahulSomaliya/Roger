/**
 * Where the prompt panel sits (M5-T10). Pure, with no Electron import, so the placement tests run
 * under Node; PromptWindow.ts feeds it `screen`'s displays and the cursor.
 */

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The part of Electron's `Display` the placement reads. */
export interface PromptDisplay {
  id: number;
  bounds: Rectangle;
  /** Bounds less the menu bar and the Dock: the panel sits inside it, not under the menu bar. */
  workArea: Rectangle;
}

/** The panel's width. Its height follows its cards (PromptWindow measures it). */
export const PANEL_WIDTH = 360;

/** The gap between the panel and the work area's edges. */
export const PANEL_MARGIN = 16;

/**
 * The panel's bounds: top right of `workArea`, `PANEL_MARGIN` in from its right and top edges. A
 * panel taller (or wider) than the work area minus both margins is cut to fit, never pushed off
 * the display: the page scrolls its cards inside it (prompt.css).
 *
 * Trap: work areas are in global screen coordinates, so a display left of or above the main one
 * has a NEGATIVE x or y. Anchor from `workArea.x + workArea.width`, never from 0 or `screen`'s
 * primary size, or the panel lands on the wrong display.
 */
export function promptBounds(workArea: Rectangle, height: number): Rectangle {
  const width = Math.min(PANEL_WIDTH, workArea.width - 2 * PANEL_MARGIN);
  const fitted = Math.min(Math.ceil(height), workArea.height - 2 * PANEL_MARGIN);
  return {
    x: workArea.x + workArea.width - width - PANEL_MARGIN,
    y: workArea.y + PANEL_MARGIN,
    width,
    height: fitted,
  };
}

/**
 * The display that holds `point` (the cursor, or a point of the panel's own window), else the one
 * whose edge is nearest: the cursor can sit on none for an instant while displays change. Electron's
 * `screen.getDisplayNearestPoint` does the same, but taking the list keeps this testable.
 */
export function displayUnder(point: Point, displays: readonly PromptDisplay[]): PromptDisplay {
  let nearest: PromptDisplay | undefined;
  let nearestDistance = Infinity;
  for (const candidate of displays) {
    const distance = distanceTo(point, candidate.bounds);
    if (distance === 0) return candidate;
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  if (nearest === undefined) throw new Error('prompt placement: no display to place the panel on');
  return nearest;
}

/** 0 inside the rectangle (its left and top edges in, its right and bottom out), else the gap. */
function distanceTo(point: Point, rect: Rectangle): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width - 1));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height - 1));
  return Math.hypot(dx, dy);
}
