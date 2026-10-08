export type MenuSide = 'start' | 'end';

/**
 * Which edge of its button an open menu lines up with, so the list stays inside the window.
 * `end` hangs the list to the left of the button's right edge, `start` to the right of its left
 * edge. A menu that runs off the window loses its labels and the items past the edge: at 390 px
 * wide the meeting header's buttons wrap under the title, the button sits at the left edge, and
 * the `end` list opened 142 px off the window. So the preferred side wins when it fits, the other
 * side when only that one does, and the side that loses less when neither does (the list is then
 * wider than the window allows, which `.menu`'s max-width prevents in practice).
 *
 * Coordinates are in the window's: `left` and `right` of the button's box, the list's width, the
 * window's width and the margin the list keeps from its edges.
 */
export function menuSide(
  preferred: MenuSide,
  anchor: { left: number; right: number },
  listWidth: number,
  windowWidth: number,
  margin: number,
): MenuSide {
  const overflow = (side: MenuSide): number => {
    const left = side === 'end' ? anchor.right - listWidth : anchor.left;
    const right = left + listWidth;
    return Math.max(0, margin - left) + Math.max(0, right - (windowWidth - margin));
  };
  const other: MenuSide = preferred === 'end' ? 'start' : 'end';
  return overflow(other) < overflow(preferred) ? other : preferred;
}
