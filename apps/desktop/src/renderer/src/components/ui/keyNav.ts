/**
 * Arrow-key movement for a tab row and a menu: where focus goes after `key`, or `null` when the
 * key is not this list's to handle (the caller then leaves the event alone, so ArrowDown still
 * scrolls a page when focus is on a tab). Wraps at both ends, as the ARIA tabs and menu patterns
 * do. Pure, so it is tested without a DOM (Tabs.tsx, Menu.tsx).
 */
export type KeyAxis = 'horizontal' | 'vertical';

export function nextIndex(
  axis: KeyAxis,
  key: string,
  current: number,
  count: number,
): number | null {
  if (count === 0) return null;
  const forward = axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const backward = axis === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  if (key === forward) return (current + 1) % count;
  if (key === backward) return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
