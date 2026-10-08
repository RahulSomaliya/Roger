import { useEffect, useRef, useState } from 'react';

/**
 * An exit that plays before the thing goes: `start()` sets `leaving` (the CSS `data-leaving`
 * animation runs), and `ms` later `onDone` runs, which is when the parent really closes it. A
 * second `start()` while leaving does nothing. `active` is whether the thing is open: when it
 * turns false (the parent closed it some other way, a confirm that went through) `leaving` is
 * cleared at once, so the next opening does not begin mid-exit.
 *
 * `ms` must match the matching `--dur-*-leave` in styles.css. A timer and not `animationend`: the
 * end event never fires if the animation is removed, and the thing would then never close. Under
 * reduced motion the CSS duration is zero and the wait is still `ms`, which is harmless. `onDone`
 * can run after the parent closed the thing itself, so it must be safe to call twice.
 */
export function useLeave(
  active: boolean,
  ms: number,
  onDone: () => void,
): { leaving: boolean; start: () => void } {
  const [leaving, setLeaving] = useState(false);
  const [wasActive, setWasActive] = useState(active);
  const timer = useRef<number | null>(null);

  if (active !== wasActive) {
    setWasActive(active);
    setLeaving(false);
  }

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const start = (): void => {
    if (timer.current !== null) return;
    setLeaving(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      onDone();
    }, ms);
  };

  return { leaving, start };
}
