import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PromptActionRequest, PromptApi, PromptPanelState } from '../../../shared/ipc/prompt';
import { forgetCard, forgetLeaving, reconcileCards, type ShownCard } from './leavingCards';
import { panelHeightTitle } from './panelHeight';
import { PromptPanel } from './PromptPanel';
import { followPromptState, type PromptFeed } from './promptState';

/** How often "Starting in 1 min" is recomputed: a card lives at most 10 min, so 5 s is plenty. */
const TICK_MS = 5000;

/**
 * The most a card may take to slide out before the page forgets it anyway: the exit is 170 ms
 * (prompt.css `slide-out`), and `animationend` can fail to come (a page that was hidden when the
 * card left). Below main's 400 ms fallback (PromptWindow `EXIT_FALLBACK_MS`), so the page reports
 * height 0 first and the window hides on the report, not on the backstop.
 */
const EXIT_BACKSTOP_MS = 300;

/**
 * The prompt panel page (M5-T10): follows main's state, draws the cards, sends clicks back, and
 * reports its height so main can size the window. `api` is `window.rogerPrompt` in the app and a
 * fake in the QA preview (T13).
 *
 * A card main removes is kept drawn until its exit animation ends (leavingCards.ts), so the height
 * the page reports stays up for the exit and falls to 0 only after the last card has left: main
 * hides the window on that report.
 */
export function PromptApp({ api }: { api: PromptApi }) {
  const [feed, setFeed] = useState<PromptFeed>({ state: null, readFailed: false });
  const [shown, setShown] = useState<readonly ShownCard[]>([]);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const nowMs = useNow(TICK_MS);
  const content = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      followPromptState(api, (next) => {
        setFeed(next);
        if (next.state !== null) {
          const { cards } = next.state;
          setShown((previous) => reconcileCards(previous, cards));
        }
        // A refused click leaves the card as main last sent it (PromptApi.act); the next state
        // is news about the card, so the note about the refusal goes.
        setFailed(new Set());
      }),
    [api],
  );
  useReportedHeight(content);

  const leaving = useMemo(
    () => new Set(shown.filter((entry) => entry.leaving).map((entry) => entry.card.id)),
    [shown],
  );
  useEffect(() => {
    if (leaving.size === 0) return;
    const backstop = setTimeout(() => {
      setShown(forgetLeaving);
    }, EXIT_BACKSTOP_MS);
    return () => {
      clearTimeout(backstop);
    };
  }, [leaving]);

  const act = useCallback(
    (request: PromptActionRequest): void => {
      // The rejection's text is an IPC error, not for the card: the card only learns that it failed.
      api.act(request).catch(() => {
        setFailed((current) => new Set(current).add(request.cardId));
      });
    },
    [api],
  );
  const left = useCallback((cardId: string): void => {
    setShown((current) => forgetCard(current, cardId));
  }, []);

  // Main's counts (`recording`, its title) with the cards as drawn, leaving ones included.
  const state: PromptPanelState | null =
    feed.state === null ? null : { ...feed.state, cards: shown.map((entry) => entry.card) };

  return (
    <div className="prompt-scroll">
      <div ref={content}>
        <PromptPanel
          state={state}
          readFailed={feed.readFailed}
          nowMs={nowMs}
          failed={failed}
          leaving={leaving}
          onAct={act}
          onLeft={left}
        />
      </div>
    </div>
  );
}

/** The wall clock, refreshed every `everyMs`. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, everyMs);
    return () => {
      clearInterval(timer);
    };
  }, [everyMs]);
  return now;
}

/**
 * Puts the natural height of `element` into the page title whenever it changes (panelHeight.ts
 * says why). Measured on the element INSIDE the scroller, never on the scroller: that one is
 * capped at the window's height, so a window made small would report its own small height forever.
 */
function useReportedHeight(element: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const target = element.current;
    if (target === null) return;
    const report = (): void => {
      document.title = panelHeightTitle(target.getBoundingClientRect().height);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, [element]);
}
