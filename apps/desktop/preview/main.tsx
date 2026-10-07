import { installPreviewControl, PreviewHub } from './control';
import { createFakeRoger } from './fakeRoger';
import { parsePreviewQuery, SCENARIOS } from './scenarios';

/**
 * Boots the preview: the fake `window.roger` where the preload would put the real one, the
 * renderer's own entry, then the scenario named in the query (`?scenario=live-call&theme=dark`).
 */
async function boot(): Promise<void> {
  const query = parsePreviewQuery(window.location.search);
  const hub = new PreviewHub({ forcedTheme: query.theme });
  const roger = createFakeRoger(hub);
  window.roger = roger;
  // The app's real entry, not a copy of it: the preview renders whatever the app renders (its
  // routes, theme and styles) and cannot drift from it. The entry reads window.roger as it renders,
  // so it is imported only now, after the fake is in place.
  await import('../src/renderer/src/main');
  // The scenario starts once the app has subscribed: the hub, like main, keeps no event for a
  // listener that comes later, so lines sent before would never reach the page. React renders
  // after the import returns and subscribes in effects after that, so wait for both.
  await firstRender();
  await hub.settled();
  const stop = SCENARIOS[query.scenario].start({ hub, roger });
  installPreviewControl(window, { hub, scenario: query.scenario, stop });
  await hub.settled();
  document.documentElement.dataset.state = 'ready';
}

/** How long the app may take to put anything into #root before the preview gives up. */
const FIRST_RENDER_TIMEOUT_MS = 10_000;

/** Resolves once React has put the app into #root, which the renderer's entry renders into. */
function firstRender(): Promise<void> {
  const root = document.getElementById('root');
  if (root === null) return Promise.reject(new Error('preview/index.html has no #root'));
  if (root.childElementCount > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`The app rendered nothing into #root within ${FIRST_RENDER_TIMEOUT_MS} ms`));
    }, FIRST_RENDER_TIMEOUT_MS);
    const observer = new MutationObserver(() => {
      if (root.childElementCount === 0) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    });
    observer.observe(root, { childList: true });
  });
}

boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  document.documentElement.dataset.state = 'error';
  document.documentElement.dataset.error = message;
  document.body.textContent = `The preview failed to start: ${message}`;
  // Rethrown so it also lands in the console, where qa/driver.ts collects page errors.
  throw error;
});
