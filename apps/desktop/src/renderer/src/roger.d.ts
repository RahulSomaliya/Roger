import type { RogerApi } from '../../shared/ipc';

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts. */
    roger: RogerApi;
  }
}
