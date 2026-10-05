import { pathToFileURL } from 'node:url';

/**
 * What the app's own page may do: which URLs count as the app, and which web permissions it gets.
 * Pure, without any Electron import, so tests run under Node; window.ts wires it to the session
 * permission handlers and the navigation guards.
 */

/** Where the app's page is served from. window.ts loads the page from the same values. */
export interface AppPage {
  /** The electron-vite dev server (ELECTRON_RENDERER_URL) in development, else null. */
  devServerUrl: string | null;
  /** Absolute path of the bundled renderer folder (out/renderer), used when packaged. */
  rendererDir: string;
}

/** True when `url` is the app's own page: the dev server origin, or a file in the renderer folder. */
export function isAppPageUrl(url: string, page: AppPage): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // not a URL at all, so not the app's page
  }
  if (page.devServerUrl !== null) return parsed.origin === new URL(page.devServerUrl).origin;
  if (parsed.protocol !== 'file:') return false;
  // Both sides go through the URL parser, so `..` segments are resolved before the prefix check
  // and the trailing slash keeps a sibling folder like `renderer-evil` out.
  const folder = new URL(`${pathToFileURL(page.rendererDir).href}/`).pathname;
  return parsed.pathname.startsWith(folder);
}

export interface PermissionQuery {
  /** Electron's permission name, for example `media` or `notifications`. */
  permission: string;
  /** The page asking: the requesting frame's URL. */
  url: string;
  /** For `media`: what is asked for. Requests list `audio`/`video`; checks may say `unknown`. */
  mediaTypes: readonly string[];
}

/**
 * Media types `media` may cover. The mic arrives as `audio`. System audio is getUserMedia with
 * chromeMediaSource "desktop", which must also request a video track (stopped at once) and may be
 * listed as `audio` + `video` or with no types at all. Checks (enumerateDevices) may say `unknown`.
 * Dropping `video` here kills system audio capture with no visible error.
 */
const CAPTURE_MEDIA_TYPES: ReadonlySet<string> = new Set(['audio', 'video', 'unknown']);

/**
 * The only permission the app needs is `media`, for its own page. Everything else (notifications,
 * geolocation, display-capture, clipboard, openExternal, ...) is denied, and so is any other origin.
 */
export function isPermissionAllowed(query: PermissionQuery, page: AppPage): boolean {
  return (
    query.permission === 'media' &&
    isAppPageUrl(query.url, page) &&
    query.mediaTypes.every((type) => CAPTURE_MEDIA_TYPES.has(type))
  );
}
