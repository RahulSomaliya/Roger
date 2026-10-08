import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PANEL_WIDTH } from '../src/main/prompt/promptBounds';
import type { PromptActionRequest, PromptApi } from '../src/shared/ipc/prompt';
import { PromptApp } from '../src/renderer/src/prompt/PromptApp';
import { parsePromptQuery, promptStateFor } from './promptScenarios';

/**
 * Boots the prompt panel's preview: the panel's own page (PromptApp) over a fake `rogerPrompt` that
 * answers with the state `?card=` names and records each click on `window.__rogerPromptPreview`.
 * The real window is 360 px wide, transparent and frameless over the call (PromptWindow.ts): the
 * stage below stands in for the call, in the page's own `fill` token, and is as wide as the window.
 */
declare global {
  interface Window {
    __rogerPromptPreview?: { acts: PromptActionRequest[] };
  }
}

function boot(): void {
  const scenario = parsePromptQuery(window.location.search);
  const state = promptStateFor(scenario, Date.now());
  const acts: PromptActionRequest[] = [];
  window.__rogerPromptPreview = { acts };
  const api: PromptApi = {
    getState: () => Promise.resolve(state),
    // The state never changes: a click is recorded, not played.
    onStateChanged: () => () => undefined,
    act: (request) => {
      acts.push(request);
      return Promise.resolve();
    },
  };

  const stage = document.getElementById('stage');
  const root = document.getElementById('root');
  if (stage === null || root === null)
    throw new Error('preview/prompt.html has no #stage or #root');
  // After prompt.css's `html, body { background: transparent }`, which an inline style outranks.
  document.body.style.background = 'var(--fill)';
  document.body.style.minHeight = '100vh';
  stage.style.width = `min(${PANEL_WIDTH}px, 100vw - 32px)`;
  stage.style.margin = '0 auto';
  stage.style.padding = '16px 0';
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
