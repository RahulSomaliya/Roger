import { useCallback, useEffect, useRef, useState } from 'react';
import type { PromptActionRequest, PromptApi } from '../../../shared/ipc/prompt';
import { describeError } from '../app/describeError';
import { panelHeightTitle } from './panelHeight';
import { PromptPanel } from './PromptPanel';
import { followPromptState, type PromptFeed } from './promptState';

/** How often "Starting in 1 min" is recomputed: a card lives at most 10 min, so 5 s is plenty. */
const TICK_MS = 5000;

/**
 * The prompt panel page (M5-T10): follows main's state, draws the cards, sends clicks back, and
 * reports its height so main can size the window. `api` is `window.rogerPrompt` in the app and a
 * fake in the QA preview (T13).
 */
export function PromptApp({ api }: { api: PromptApi }) {
  const [feed, setFeed] = useState<PromptFeed>({ state: null, error: null });
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const nowMs = useNow(TICK_MS);
  const content = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      followPromptState(api, (next) => {
        setFeed(next);
        // A refused click leaves the card as main last sent it (PromptApi.act); the next state
        // is news about the card, so the note about the refusal goes.
        setFailures({});
      }),
    [api],
  );
  useReportedHeight(content);

  const act = useCallback(
    (request: PromptActionRequest): void => {
      api.act(request).catch((error: unknown) => {
        setFailures((current) => ({ ...current, [request.cardId]: describeError(error) }));
      });
    },
    [api],
  );

  return (
    <div className="prompt-scroll">
      <div ref={content}>
        <PromptPanel
          state={feed.state}
          error={feed.error}
          nowMs={nowMs}
          failures={failures}
          onAct={act}
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
