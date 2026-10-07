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
  return parsed.pathname.startsWith(rendererFolderPath(page));
}

/**
 * The bundled renderer folder as a URL path, with its trailing slash. Both sides go through the
 * URL parser, so `..` segments are resolved before a prefix check, and the slash keeps a sibling
 * folder like `renderer-evil` out.
 */
function rendererFolderPath(page: AppPage): string {
  return new URL(`${pathToFileURL(page.rendererDir).href}/`).pathname;
}

/** The prompt panel's page (M5-T10), next to the app's in the renderer folder. */
export const PROMPT_PAGE_FILE = 'prompt.html';

/**
 * True when `url` is the prompt panel's page. It is the app's own for navigation (`isAppPageUrl`
 * is true for it: same origin, same folder, so window.ts' guards let it reload), but it is not the
 * app for permissions: `isPermissionAllowed` gives it nothing. The panel only draws cards from
 * main's state and has no business with the microphone or the screen; a page that cannot ask
 * cannot be tricked into asking.
 */
export function isPromptPageUrl(url: string, page: AppPage): boolean {
  if (!isAppPageUrl(url, page)) return false;
  const { pathname } = new URL(url); // isAppPageUrl parsed it, so it is a URL
  if (page.devServerUrl !== null) return pathname === `/${PROMPT_PAGE_FILE}`;
  return pathname === `${rendererFolderPath(page)}${PROMPT_PAGE_FILE}`;
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
 * Media types `media` may cover, as Electron 44 reports them (web_contents_permission_helper.cc).
 * Requests list real devices only: the mic is `audio`, a camera `video`. System audio is
 * getUserMedia with chromeMediaSource "desktop" (sources.ts); its audio and its required video
 * track are desktop types, so that request arrives with no types at all and its checks say
 * `unknown`. Bare `video` is therefore only ever the camera, which capture never needs.
 */
const CAPTURE_MEDIA_TYPES: ReadonlySet<string> = new Set(['audio', 'unknown']);

/**
 * The only permission the app needs is `media`, for its own page (the prompt panel's page, which
 * is the app for navigation only, gets none). Everything else (notifications, geolocation,
 * display-capture, clipboard, openExternal, ...) is denied, and so is any other origin.
 * Electron's 45 branch reports desktop capture as `display-capture` with `audio` + `video` instead:
 * moving off 44 without changing this fails every system audio start with "Permission denied".
 */
export function isPermissionAllowed(query: PermissionQuery, page: AppPage): boolean {
  return (
    query.permission === 'media' &&
    isAppPageUrl(query.url, page) &&
    !isPromptPageUrl(query.url, page) &&
    query.mediaTypes.every((type) => CAPTURE_MEDIA_TYPES.has(type))
  );
}
