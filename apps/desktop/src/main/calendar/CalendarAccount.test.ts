import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarConnection } from '../../shared/calendar';
import { ApiError } from '../api/http';
import { createLogger } from '../logger';
import {
  CALENDAR_SIGN_IN_TIMEOUT_MS,
  CalendarAccount,
  type CalendarAccountApi,
} from './CalendarAccount';
import { CalendarSync } from './CalendarSync';
import { pkceChallenge } from './oauthLoopback';
import type { GoogleAuthorizationRequest } from './ports';
import { SqliteCalendarCache } from './SqliteCalendarCache';

// The sign-in runs for real: the loopback listens on 127.0.0.1 and the fake browser below follows
// the redirect over HTTP, as the default browser does after Google's consent screen.

const silentLogger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const ACCOUNT = 'rahul@linkt.ai';
const GOOGLE_CODE = '4/0AVG7fiQ-google-code';

const connectionOf = (accountEmail: string): CalendarConnection => ({
  provider: 'google',
  accountEmail,
  status: 'active',
  connectedAt: '2026-10-06T08:00:00Z',
  expiresHint: '2026-10-13T08:00:00Z',
  lastError: null,
});

/** The URL Google's authorization endpoint would get, built from the request as the API does. */
function googleUrl(request: GoogleAuthorizationRequest): string {
  const query = new URLSearchParams({
    client_id: 'roger-desktop.apps.googleusercontent.com',
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    code_challenge_method: 'S256',
    state: request.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`;
}

/** The fake provider's URL: the redirect itself, with `code=fake` (apps/api fake.py). */
function fakeProviderUrl(request: GoogleAuthorizationRequest): string {
  return `${request.redirectUri}?code=fake&state=${request.state}`;
}

type Behaviour = 'consent' | 'deny' | 'idle';

/**
 * The default browser: records what `openExternal` was asked to open and, unless idle, follows
 * the sign-in to the loopback redirect the way the browser does after the consent screen.
 */
class FakeBrowser {
  readonly opened: string[] = [];
  private readonly visits: Promise<unknown>[] = [];

  constructor(private readonly behaviour: Behaviour) {}

  readonly open = (url: string): Promise<void> => {
    this.opened.push(url);
    if (this.behaviour !== 'idle') {
      this.visits.push(fetch(redirectAfterConsent(url, this.behaviour)).then((r) => r.text()));
    }
    return Promise.resolve();
  };

  async idle(): Promise<void> {
    await Promise.allSettled(this.visits);
  }
}

function redirectAfterConsent(url: string, behaviour: 'consent' | 'deny'): string {
  const page = new URL(url);
  if (page.hostname !== 'accounts.google.com') return url; // the fake provider's own redirect
  const target = new URL(page.searchParams.get('redirect_uri') ?? '');
  target.searchParams.set(
    behaviour === 'consent' ? 'code' : 'error',
    behaviour === 'consent' ? GOOGLE_CODE : 'access_denied',
  );
  target.searchParams.set('state', page.searchParams.get('state') ?? '');
  return target.toString();
}

/** The message of what a call rejected with; fails the test when it was no Error. */
function messageOf(error: unknown): string {
  if (!(error instanceof Error)) throw new Error(`expected an Error, got ${String(error)}`);
  return error.message;
}

async function portIsOpen(redirectUri: string): Promise<boolean> {
  try {
    await fetch(redirectUri);
    return true;
  } catch {
    // fetch rejects ("fetch failed", ECONNREFUSED) once the listener is gone: the answer here.
    return false;
  }
}

interface Setup {
  authorizationUrl?: (request: GoogleAuthorizationRequest) => string;
  behaviour?: Behaviour;
  signInTimeoutMs?: number;
}

const caches: SqliteCalendarCache[] = [];
afterEach(() => {
  for (const cache of caches.splice(0)) cache.close();
});

function setup(options: Setup = {}) {
  const cache = new SqliteCalendarCache(':memory:');
  caches.push(cache);
  const sync = new CalendarSync({
    api: { listEvents: () => Promise.reject(new Error('no events in these tests')) },
    cache,
    logger: silentLogger,
  });
  const build = options.authorizationUrl ?? googleUrl;
  const api = {
    createGoogleAuthorization: vi.fn<CalendarAccountApi['createGoogleAuthorization']>((request) =>
      Promise.resolve({ authorizationUrl: build(request) }),
    ),
    connectGoogle: vi.fn<CalendarAccountApi['connectGoogle']>(() =>
      Promise.resolve(connectionOf(ACCOUNT)),
    ),
    getConnection: vi.fn<CalendarAccountApi['getConnection']>(() => Promise.resolve(null)),
    disconnect: vi.fn<CalendarAccountApi['disconnect']>(() => Promise.resolve()),
  };
  const browser = new FakeBrowser(options.behaviour ?? 'consent');
  const account = new CalendarAccount({
    api,
    sync,
    openExternal: browser.open,
    logger: silentLogger,
    ...(options.signInTimeoutMs === undefined ? {} : { signInTimeoutMs: options.signInTimeoutMs }),
  });
  /** The redirect the nth sign-in sent to the API (it holds the loopback's port). */
  const redirectOf = (call = 0): string => {
    const request = api.createGoogleAuthorization.mock.calls[call]?.[0];
    if (request === undefined) throw new Error(`no authorization request ${call}`);
    return request.redirectUri;
  };
  return { cache, api, browser, account, redirectOf };
}

describe('CalendarAccount.connect', () => {
  it("opens Google's page, sends the code with its verifier and redirect, and records the account", async () => {
    const { cache, api, browser, account, redirectOf } = setup();

    await expect(account.connect()).resolves.toEqual(connectionOf(ACCOUNT));

    const authorization = api.createGoogleAuthorization.mock.calls[0]![0];
    expect(authorization.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    expect(browser.opened).toEqual([googleUrl(authorization)]);
    expect(api.connectGoogle).toHaveBeenCalledTimes(1);
    const exchange = api.connectGoogle.mock.calls[0]![0];
    expect(exchange).toMatchObject({ code: GOOGLE_CODE, redirectUri: authorization.redirectUri });
    expect(pkceChallenge(exchange.codeVerifier)).toBe(authorization.codeChallenge);
    // Through CalendarSync.connected, which writes connections_log.
    expect(cache.activeConnection()?.accountEmail).toBe(ACCOUNT);
    await expect(portIsOpen(redirectOf())).resolves.toBe(false);
  });

  it("opens its own redirect in fake mode, where the API's URL already carries code=fake", async () => {
    const { api, browser, account, redirectOf } = setup({ authorizationUrl: fakeProviderUrl });

    await account.connect();

    expect(browser.opened).toEqual([
      `${redirectOf()}?code=fake&state=${api.createGoogleAuthorization.mock.calls[0]![0].state}`,
    ]);
    expect(api.connectGoogle.mock.calls[0]![0].code).toBe('fake');
  });

  it("opens nothing but Google's sign-in page or its own redirect", async () => {
    const refused: ((request: GoogleAuthorizationRequest) => string)[] = [
      () => 'https://accounts.google.com.evil.io/o/oauth2/v2/auth',
      () => 'https://evil.io/accounts.google.com/',
      () => 'http://accounts.google.com/o/oauth2/v2/auth',
      () => 'https://accounts.google.com:8443/o/oauth2/v2/auth',
      () => 'https://me@accounts.google.com/o/oauth2/v2/auth',
      () => 'javascript:alert(1)',
      () => 'file:///etc/passwd',
      () => 'not a url',
      (request) => {
        const other = new URL(request.redirectUri);
        other.port = String(Number(other.port) === 65535 ? 1 : Number(other.port) + 1);
        return `${other.toString()}?code=fake&state=${request.state}`;
      },
      (request) => `${new URL(request.redirectUri).origin}/elsewhere?code=fake`,
    ];
    for (const authorizationUrl of refused) {
      const { cache, api, browser, account, redirectOf } = setup({ authorizationUrl });
      const error = await account.connect().catch((e: unknown) => e);
      expect(messageOf(error)).toMatch(/^Roger opens only Google's sign-in page/);
      expect(browser.opened).toEqual([]);
      expect(api.connectGoogle).not.toHaveBeenCalled();
      expect(cache.activeConnection()).toBeNull();
      await expect(portIsOpen(redirectOf())).resolves.toBe(false);
    }
  });

  it('says so when the user cancels at Google, and sends nothing to redeem', async () => {
    const { cache, api, browser, account, redirectOf } = setup({ behaviour: 'deny' });

    await expect(account.connect()).rejects.toThrow('You cancelled the Google sign-in.');
    await browser.idle();
    expect(api.connectGoogle).not.toHaveBeenCalled();
    expect(cache.activeConnection()).toBeNull();
    await expect(portIsOpen(redirectOf())).resolves.toBe(false);
  });

  it('turns API errors into messages a person can act on', async () => {
    const unreachable = setup();
    unreachable.api.createGoogleAuthorization.mockRejectedValueOnce(
      new ApiError(
        0,
        'network_error',
        'POST /v1/calendar/google/authorization failed: connect ECONNREFUSED 127.0.0.1:8000',
      ),
    );
    await expect(unreachable.account.connect()).rejects.toThrow(
      'Could not reach the Roger API to connect Google Calendar. Is it running? (POST /v1/calendar/google/authorization failed: connect ECONNREFUSED 127.0.0.1:8000)',
    );
    expect(unreachable.browser.opened).toEqual([]);
    await expect(portIsOpen(unreachable.redirectOf())).resolves.toBe(false);

    const unticked = setup();
    unticked.api.connectGoogle.mockRejectedValueOnce(
      new ApiError(
        424,
        'calendar_reconnect_required',
        "Connect again and tick 'View events on all your calendars'.",
      ),
    );
    await expect(unticked.account.connect()).rejects.toThrow(
      "Connect again and tick 'View events on all your calendars'.",
    );
    expect(unticked.cache.activeConnection()).toBeNull();

    const googleDown = setup();
    googleDown.api.connectGoogle.mockRejectedValueOnce(
      new ApiError(502, 'calendar_provider_error', 'Google answered HTTP 503.'),
    );
    await expect(googleDown.account.connect()).rejects.toThrow(
      'Could not connect Google Calendar: Google answered HTTP 503.',
    );
  });

  it('lets a second Connect cancel the first', async () => {
    const { api, browser, account, redirectOf } = setup({ behaviour: 'idle' });
    const first = account.connect().catch((e: unknown) => e);
    await vi.waitFor(() => {
      expect(browser.opened).toHaveLength(1);
    });

    // The second sign-in: the user finishes it in the browser.
    const second = account.connect();
    await vi.waitFor(() => {
      expect(browser.opened).toHaveLength(2);
    });
    const firstError = await first;
    expect(messageOf(firstError)).toBe('This sign-in was replaced by a newer Connect.');
    await expect(portIsOpen(redirectOf(0))).resolves.toBe(false);

    const state = api.createGoogleAuthorization.mock.calls[1]![0].state;
    await fetch(`${redirectOf(1)}?code=${GOOGLE_CODE}&state=${state}`);
    await expect(second).resolves.toEqual(connectionOf(ACCOUNT));
    expect(api.connectGoogle).toHaveBeenCalledTimes(1);
    expect(api.connectGoogle.mock.calls[0]![0].redirectUri).toBe(redirectOf(1));
  });

  it('gives up when the browser never comes back, after 3 minutes in the app', async () => {
    expect(CALENDAR_SIGN_IN_TIMEOUT_MS).toBe(3 * 60_000);
    const { api, account, redirectOf } = setup({ behaviour: 'idle', signInTimeoutMs: 50 });

    await expect(account.connect()).rejects.toThrow(
      'Google sign-in timed out after 50 ms. Connect again.',
    );
    expect(api.connectGoogle).not.toHaveBeenCalled();
    await expect(portIsOpen(redirectOf())).resolves.toBe(false);
  });

  it('closes a sign-in still waiting on the browser at stop', async () => {
    const { account, browser, redirectOf } = setup({ behaviour: 'idle' });
    const waiting = account.connect().catch((e: unknown) => e);
    await vi.waitFor(() => {
      expect(browser.opened).toHaveLength(1);
    });
    account.stop();
    expect(messageOf(await waiting)).toBe('Roger is quitting.');
    await expect(portIsOpen(redirectOf())).resolves.toBe(false);
  });
});

describe('CalendarAccount.disconnect', () => {
  it('revokes at the API, then clears the copy through the sync; the log stays', async () => {
    const { cache, api, account } = setup();
    await account.connect();

    await account.disconnect();

    expect(api.disconnect).toHaveBeenCalledTimes(1);
    expect(cache.activeConnection()).toBeNull();
    expect(cache.listConnections(ACCOUNT)).toHaveLength(1);
    expect(cache.listConnections(ACCOUNT)[0]?.disconnectedAt).not.toBeNull();
  });

  it('keeps the copy and says why when the API cannot be reached', async () => {
    const { cache, api, account } = setup();
    await account.connect();
    api.disconnect.mockRejectedValueOnce(
      new ApiError(
        0,
        'network_error',
        'DELETE /v1/calendar/connection failed: timed out after 10000 ms',
      ),
    );

    await expect(account.disconnect()).rejects.toThrow(
      'Could not reach the Roger API to disconnect Google Calendar. Is it running? (DELETE /v1/calendar/connection failed: timed out after 10000 ms)',
    );
    expect(cache.activeConnection()?.accountEmail).toBe(ACCOUNT);
  });

  it('cancels a sign-in still waiting on the browser', async () => {
    const { api, browser, account, redirectOf } = setup({ behaviour: 'idle' });
    const waiting = account.connect().catch((e: unknown) => e);
    await vi.waitFor(() => {
      expect(browser.opened).toHaveLength(1);
    });

    await account.disconnect();

    const error = await waiting;
    expect(messageOf(error)).toBe('This sign-in was cancelled by Disconnect.');
    expect(api.connectGoogle).not.toHaveBeenCalled();
    await expect(portIsOpen(redirectOf())).resolves.toBe(false);
  });

  it('waits for a code exchange already sent, so the API ends disconnected', async () => {
    const { cache, api, account } = setup();
    let exchanged: (connection: CalendarConnection) => void = () => undefined;
    api.connectGoogle.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          exchanged = resolve;
        }),
    );
    const connecting = account.connect();
    await vi.waitFor(() => {
      expect(api.connectGoogle).toHaveBeenCalledTimes(1);
    });

    const disconnecting = account.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.disconnect).not.toHaveBeenCalled();

    exchanged(connectionOf(ACCOUNT));
    await connecting;
    await disconnecting;
    expect(api.disconnect).toHaveBeenCalledTimes(1);
    expect(cache.activeConnection()).toBeNull();
  });
});

describe('CalendarAccount.getConnection', () => {
  it("answers the API's connection, and a read error as a message to show", async () => {
    const { api, account } = setup();
    api.getConnection.mockResolvedValueOnce(connectionOf(ACCOUNT));
    await expect(account.getConnection()).resolves.toEqual(connectionOf(ACCOUNT));

    api.getConnection.mockRejectedValueOnce(
      new ApiError(
        0,
        'network_error',
        'GET /v1/calendar/connection failed: connect ECONNREFUSED 127.0.0.1:8000',
      ),
    );
    await expect(account.getConnection()).rejects.toThrow(
      'Could not reach the Roger API to read the Google Calendar connection. Is it running? (GET /v1/calendar/connection failed: connect ECONNREFUSED 127.0.0.1:8000)',
    );
  });

  it('waits for a Disconnect on its way, so it never reads the connection it removes', async () => {
    const { api, account } = setup();
    await account.connect();
    let revoked: () => void = () => undefined;
    api.disconnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          revoked = resolve;
        }),
    );
    const disconnecting = account.disconnect();
    const reading = account.getConnection();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.getConnection).not.toHaveBeenCalled();

    revoked();
    await disconnecting;
    await expect(reading).resolves.toBeNull();
  });

  it('tells listeners each change of the connection, once', async () => {
    const { api, account } = setup();
    const seen: (CalendarConnection | null)[] = [];
    account.onConnectionChange((connection) => seen.push(connection));

    await account.getConnection();
    await account.getConnection();
    await account.connect();
    api.getConnection.mockResolvedValueOnce(connectionOf(ACCOUNT));
    await account.getConnection();
    await account.disconnect();

    expect(seen).toEqual([null, connectionOf(ACCOUNT), null]);
  });
});
