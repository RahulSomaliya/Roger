import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PANEL_MARGIN, PANEL_WIDTH } from '../src/main/prompt/promptBounds';
import type { PromptActionRequest, PromptApi } from '../src/shared/ipc/prompt';
import { PromptApp } from '../src/renderer/src/prompt/PromptApp';
import {
  parsePromptBackdrop,
  parsePromptQuery,
  promptStateFor,
  type PromptBackdrop,
} from './promptScenarios';

/**
 * Boots the prompt panel's preview: the panel's own page (PromptApp) over a fake `rogerPrompt` that
 * answers with the state `?card=` names and records each click on `window.__rogerPromptPreview`.
 * The real window is 360 px wide, transparent and frameless over the call (PromptWindow.ts), at the
 * top right of the work area, 16 px in (promptBounds.ts). `placeInFrame` puts it there in the tab:
 * a menu bar strip, a fake call behind it (`?backdrop=dark|light`), and the stage at the same
 * offsets, so a shot shows the card against what it really floats over. The old preview centred it on
 * a `fill` stage, which proved one primary and nothing about the edge (redesign sweep, P14).
 */
declare global {
  interface Window {
    __rogerPromptPreview?: { acts: PromptActionRequest[] };
  }
}

const MENU_BAR_PX = 25;

/**
 * The tab stands in for a 1440 x 900 screen: a menu bar strip, a call behind it, and the panel's
 * stage where PromptWindow puts the window. The call's colours are literals on purpose: they are
 * another app's pixels (a dark Meet, a light Zoom), not Roger's, so no theme token applies; the
 * card's own edge and fill still read the page's tokens, which is what the shot is of.
 */
function placeInFrame(stage: HTMLElement, backdrop: PromptBackdrop): void {
  const dark = backdrop === 'dark';
  const body = document.body;
  // After prompt.css's `html, body { background: transparent }`, which an inline style outranks.
  body.style.background = dark ? 'oklch(0.2 0.01 260)' : 'oklch(0.96 0.005 90)';
  body.style.minHeight = '100vh';
  body.style.overflow = 'hidden';
  const tile = (left: string, top: string, width: string, height: string): HTMLElement => {
    const element = document.createElement('div');
    element.setAttribute('aria-hidden', 'true');
    Object.assign(element.style, {
      position: 'fixed',
      left,
      top,
      width,
      height,
      borderRadius: '12px',
      background: dark ? 'oklch(0.28 0.02 260)' : 'oklch(0.9 0.01 90)',
    });
    return element;
  };
  body.append(
    tile('4%', `${MENU_BAR_PX + 40}px`, '44%', '42%'),
    tile('52%', `${MENU_BAR_PX + 40}px`, '44%', '42%'),
    tile('4%', '54%', '44%', '38%'),
    tile('52%', '54%', '44%', '38%'),
  );
  const menuBar = document.createElement('div');
  menuBar.setAttribute('aria-hidden', 'true');
  Object.assign(menuBar.style, {
    position: 'fixed',
    inset: '0 0 auto 0',
    height: `${MENU_BAR_PX}px`,
    background: dark ? 'oklch(0.12 0.01 260)' : 'oklch(0.99 0.002 90)',
  });
  body.append(menuBar);
  // promptBounds: top right of the work area (under the menu bar), PANEL_MARGIN in.
  Object.assign(stage.style, {
    position: 'fixed',
    zIndex: '1',
    top: `${MENU_BAR_PX + PANEL_MARGIN}px`,
    right: `${PANEL_MARGIN}px`,
    width: `min(${PANEL_WIDTH}px, 100vw - ${2 * PANEL_MARGIN}px)`,
  });
}

function boot(): void {
  const search = window.location.search;
  const scenario = parsePromptQuery(search);
  const backdrop = parsePromptBackdrop(search);
  const state = promptStateFor(scenario, Date.now());
  const acts: PromptActionRequest[] = [];
  window.__rogerPromptPreview = { acts };
  const api: PromptApi = {
    getState: () =>
      scenario === 'read-failed'
        ? Promise.reject(new Error("Error invoking remote method 'prompt:get-state'"))
        : Promise.resolve(state),
    // The state never changes: a click is recorded, not played.
    onStateChanged: () => () => undefined,
    act: (request) => {
      acts.push(request);
      return scenario === 'click-failed'
        ? Promise.reject(new Error('calendar.sqlite is read-only'))
        : Promise.resolve();
    },
  };

  const stage = document.getElementById('stage');
  const root = document.getElementById('root');
  if (stage === null || root === null)
    throw new Error('preview/prompt.html has no #stage or #root');
  placeInFrame(stage, backdrop);
  createRoot(root).render(
    <StrictMode>
      <PromptApp api={api} />
    </StrictMode>,
  );
  // The panel draws once its state read answers, a microtask later: wait for its card.
  const ready = new MutationObserver(() => {
    if (root.querySelector('.prompt-card') === null) return;
    ready.disconnect();
    document.documentElement.dataset.state = 'ready';
  });
  ready.observe(root, { childList: true, subtree: true });
}

try {
  boot();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  document.documentElement.dataset.state = 'error';
  document.documentElement.dataset.error = message;
  document.body.textContent = `The prompt preview failed to start: ${message}`;
  throw error;
}
