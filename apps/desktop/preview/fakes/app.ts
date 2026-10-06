import { appChannels, type AppApi } from '../../src/shared/ipc/app';
import type { FakeHub } from './hub';

/**
 * The app shell's part of the preview's `window.roger`. There is no main process to hold routes
 * until the page is ready, so a scenario opens a route with
 * `hub.emit(appChannels.AppNavigate, 'settings')` once the page has rendered, or loads the page
 * with that route's hash (`#/settings`, see src/renderer/src/app/router.ts).
 */
export function createAppFake(hub: FakeHub): AppApi {
  return {
    // Main's queue (src/main/navigation.ts) has nothing to deliver here; the hub sends at once.
    appReady: () => undefined,
    onNavigate: (listener) => hub.on(appChannels.AppNavigate, listener),
  };
}
