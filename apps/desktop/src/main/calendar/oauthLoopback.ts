import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * The loopback half of the Google sign-in (docs/plans/M5-calendar.md, "Sign-in"): a one-request
 * HTTP server on `127.0.0.1` and a random port that takes the browser's redirect after consent.
 * Google names the loopback IP as the redirect for macOS apps; `127.0.0.1`, not `localhost`,
 * because Google warns that `localhost` trips some firewalls, and the API refuses any other
 * redirect. Flow shape from openwhispr `src/helpers/oauthLoopbackFlow.js` (MIT).
 *
 * The first callback that carries a code or an error decides the sign-in, and the port closes
 * right after it, on a timeout, or on abort. A request without either (a favicon, a reload of a
 * bare URL) gets an error page and the wait goes on.
 *
 * The code is a Google grant until the API redeems it with the verifier: it never reaches a page,
 * a log line or an error message. It does stay in the browser's address bar and history, which a
 * loopback redirect cannot avoid; without the verifier, which never leaves main, it is useless.
 */

export const OAUTH_CALLBACK_PATH = '/oauth/callback';

/** Google's own refusal when the user presses Cancel or Deny on the consent screen. */
const ACCESS_DENIED = 'access_denied';

/** What an OAuth error code looks like (RFC 6749, 4.1.2.1); anything else is not named. */
const OAUTH_ERROR_CODE = /^[a-z_]{1,64}$/;

/** How the sign-in ended: the browser brought a code, or why there is none. */
export type OAuthOutcome = { ok: true; code: string } | { ok: false; error: Error };

export interface OAuthLoopback {
  /** `http://127.0.0.1:<port>/oauth/callback`: the redirect the authorization must name. */
  readonly redirectUri: string;
  /**
   * Settles once: the code from the first callback with the right state, or the reason there is
   * none (cancelled, another state, Google's error, timeout, abort). Never rejects, so a caller
   * that gives up before reading it (the API refused the authorization) leaves no unhandled
   * rejection behind.
   */
  readonly outcome: Promise<OAuthOutcome>;
}

export interface OAuthLoopbackOptions {
  /** The `state` the authorization carries; a callback with another fails the sign-in. */
  state: string;
  /** How long the user has to finish in the browser. */
  timeoutMs: number;
  /** Aborting ends the wait with the signal's reason and closes the port. */
  signal?: AbortSignal;
}

/** Starts listening; resolves once the port is bound, with the redirect to send to Google. */
export async function listenForOAuthCallback(
  options: OAuthLoopbackOptions,
): Promise<OAuthLoopback> {
  const { state, timeoutMs, signal } = options;
  let settle: (outcome: OAuthOutcome) => void = () => undefined;
  const outcome = new Promise<OAuthOutcome>((resolve) => {
    settle = resolve;
  });
  let settled = false;

  const server = createServer((request, response) => {
    const reply = answer(request, state, settled);
    if (reply.outcome === null) {
      send(response, reply.status, reply.page);
      return;
    }
    // Decided here, before the page goes out: a second request already on its way finds the
    // sign-in settled and changes nothing.
    finish(reply.outcome, false);
    send(response, reply.status, reply.page, () => {
      server.closeAllConnections();
    });
  });

  const timer = setTimeout(() => {
    finish({ ok: false, error: new Error(signInTimeoutMessage(timeoutMs)) }, true);
  }, timeoutMs);

  const onAbort = (): void => {
    finish({ ok: false, error: abortReason(signal) }, true);
  };

  /** Settles once, stops listening and, unless a page is still going out, drops every socket. */
  function finish(result: OAuthOutcome, dropConnections: boolean): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    server.close();
    // A browser keeps speculative sockets open with no request on them; they would hold the
    // server open after `close` until they time out.
    if (dropConnections) server.closeAllConnections();
    settle(result);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    clearTimeout(timer);
    throw new Error(`Could not listen for the Google sign-in on 127.0.0.1: ${String(error)}`, {
      cause: error,
    });
  }
  // From here a server error ends the sign-in, not main: an 'error' with no listener throws.
  server.on('error', (error) => {
    finish(
      { ok: false, error: new Error(`The Google sign-in listener failed: ${error.message}`) },
      true,
    );
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    // A TCP listen always answers an AddressInfo; a pipe path would mean a wrong listen call.
    finish({ ok: false, error: new Error('The sign-in listener has no port') }, true);
    throw new Error('The Google sign-in listener did not get a TCP port');
  }

  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  return { redirectUri: `http://127.0.0.1:${address.port}${OAUTH_CALLBACK_PATH}`, outcome };
}

/** "Google sign-in timed out after 3 minutes. Press Connect Google Calendar to try again." */
export function signInTimeoutMessage(timeoutMs: number): string {
  const minutes = timeoutMs / 60_000;
  const after = Number.isInteger(minutes)
    ? `${minutes} minute${minutes === 1 ? '' : 's'}`
    : `${timeoutMs} ms`;
  return `Google sign-in timed out after ${after}. Press Connect Google Calendar to try again.`;
}

// PKCE (RFC 7636) and state ------------------------------------------------------------------

export interface Pkce {
  /** Stays in main until the API redeems the code with it: never logged, never sent elsewhere. */
  verifier: string;
  /** S256 of the verifier, sent with the authorization. */
  challenge: string;
}

/** A fresh verifier, 32 random bytes as base64url (43 characters), and its S256 challenge. */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** BASE64URL(SHA-256(verifier)) without padding: always 43 characters. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** A fresh state, 24 random bytes as base64url: within the API's `[A-Za-z0-9._~-]{1,512}`. */
export function createOAuthState(): string {
  return randomBytes(24).toString('base64url');
}

// The browser's side -----------------------------------------------------------------------

interface Reply {
  status: number;
  page: string;
  /** Set when this request decides the sign-in. */
  outcome: OAuthOutcome | null;
}

/** What a request gets, and whether it decides the sign-in. Pure: no page quotes the request. */
function answer(request: IncomingMessage, state: string, settled: boolean): Reply {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== OAUTH_CALLBACK_PATH) {
    return { status: 404, page: page('Not found.'), outcome: null };
  }
  if (request.method !== 'GET') {
    return {
      status: 405,
      page: page('This address only takes Google sign-in replies.'),
      outcome: null,
    };
  }
  if (settled) {
    return {
      status: 410,
      page: page('This sign-in is already over. You can close this tab.'),
      outcome: null,
    };
  }
  const code = url.searchParams.get('code') ?? '';
  const error = url.searchParams.get('error') ?? '';
  if (code === '' && error === '') {
    return {
      status: 400,
      page: page('This page waits for Google to finish the sign-in.'),
      outcome: null,
    };
  }
  if (url.searchParams.get('state') !== state) {
    return {
      status: 400,
      page: page(
        'This reply is not from the sign-in Roger started. Close this tab, then press Connect Google Calendar in Roger.',
      ),
      outcome: failed(
        'The Google sign-in reply did not match the sign-in Roger started. Press Connect Google Calendar to try again.',
      ),
    };
  }
  if (error === ACCESS_DENIED) {
    return {
      status: 200,
      page: page('You cancelled the Google sign-in. You can close this tab.'),
      outcome: failed('You cancelled the Google sign-in.'),
    };
  }
  if (error !== '') {
    const named = OAUTH_ERROR_CODE.test(error) ? ` (${error})` : '';
    return {
      status: 200,
      page: page(
        'Google sign-in did not finish. Close this tab, then press Connect Google Calendar in Roger.',
      ),
      outcome: failed(
        `Google sign-in did not finish${named}. Press Connect Google Calendar to try again.`,
      ),
    };
  }
  return {
    status: 200,
    page: page('Google sign-in is done. You can close this tab and go back to Roger.'),
    outcome: { ok: true, code },
  };
}

function failed(message: string): OAuthOutcome {
  return { ok: false, error: new Error(message) };
}

/**
 * The page's one stylesheet. The colours are the renderer's paper canvas and ink tokens
 * (`renderer/src/theme/tokens.css`: `--canvas`, `--ink`, `--ink-muted`, `--line`), copied because
 * this page is served to the browser and cannot read the app's CSS: change them together. Light
 * and dark follow the browser's `prefers-color-scheme`, as the app does with Theme on System.
 */
const PAGE_STYLE = `:root{color-scheme:light dark;--canvas:oklch(0.985 0.004 80);--ink:oklch(0.22 0.01 70);--ink-muted:oklch(0.45 0.012 70);--line:oklch(0.9 0.008 80)}@media (prefers-color-scheme:dark){:root{--canvas:oklch(0.17 0.006 70);--ink:oklch(0.93 0.008 80);--ink-muted:oklch(0.72 0.01 75);--line:oklch(0.3 0.008 70)}}html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:var(--canvas);color:var(--ink);font:16px/24px -apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif;-webkit-font-smoothing:antialiased}main{max-width:44ch;border-top:1px solid var(--line);padding-top:24px}h1{margin:0 0 8px;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-0.01em}p{margin:0;color:var(--ink-muted)}`;

/**
 * The style's hash, for the CSP: the page stays free of script and of any style source but this
 * one sheet, so a reply can never pull anything in. Change PAGE_STYLE and the hash follows.
 */
const PAGE_STYLE_HASH = createHash('sha256').update(PAGE_STYLE, 'utf8').digest('base64');

/**
 * A static page: a headline and one line saying what to do, on the paper canvas. No script,
 * nothing from the request, never cached, no referrer onwards. `text` is a sentence or two; the
 * first sentence is the headline.
 */
function page(text: string): string {
  const [headline = text, ...rest] = text.split(/(?<=\.)\s+/);
  const detail = rest.length > 0 ? `<p>${rest.join(' ')}</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Roger</title><style>${PAGE_STYLE}</style></head><body><main><h1>${headline}</h1>${detail}</main></body></html>`;
}

function send(response: ServerResponse, status: number, body: string, done?: () => void): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; style-src 'sha256-${PAGE_STYLE_HASH}'`,
    'Referrer-Policy': 'no-referrer',
    Connection: 'close',
  });
  response.end(body, done);
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error('Google sign-in was cancelled.');
}
