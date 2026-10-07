import type { CalendarConnection } from '../../shared/calendar';
import { ApiError } from '../api/http';
import { errorMessage, type Logger } from '../logger';
import { Emitter } from '../util/emitter';
import type { CalendarSync } from './CalendarSync';
import {
  createOAuthState,
  createPkce,
  listenForOAuthCallback,
  OAUTH_CALLBACK_PATH,
} from './oauthLoopback';
import type { CalendarApiPort, GoogleConnectionRequest } from './ports';

/** How long the user has to finish the sign-in in the browser before Connect gives up. */
export const CALENDAR_SIGN_IN_TIMEOUT_MS = 3 * 60_000;

/** The calendar routes the account uses; `main/api/calendarClient.ts` is the real one. */
export type CalendarAccountApi = Pick<
  CalendarApiPort,
  'createGoogleAuthorization' | 'connectGoogle' | 'getConnection' | 'disconnect'
>;

export interface CalendarAccountOptions {
  api: CalendarAccountApi;
  /** Connect and disconnect are recorded through it, never straight in the cache (see below). */
  sync: Pick<CalendarSync, 'connected' | 'disconnected'>;
  /** Electron's `shell.openExternal`: the default browser, where Google allows the sign-in. */
  openExternal: (url: string) => Promise<void>;
  logger: Logger;
  /** Tests shorten it; the app waits CALENDAR_SIGN_IN_TIMEOUT_MS. */
  signInTimeoutMs?: number;
}

interface CalendarAccountEvents extends Record<string, unknown> {
  connection: CalendarConnection | null;
}

/**
 * The Google Calendar account as Settings and Home use it: Connect, Disconnect and the connection
 * the Roger API holds (docs/plans/M5-calendar.md, "Sign-in"). The API keeps the Google grant; main
 * only runs the browser step and hands the API the one-time code with its PKCE verifier (house
 * rule 3: the desktop holds no Google token).
 *
 * Connect listens on the loopback (./oauthLoopback.ts), asks the API for the authorization URL,
 * opens it in the default browser (Google refuses sign-in in an embedded window), waits up to
 * 3 minutes for the redirect, and sends the code and verifier to the API. It opens only
 * `https://accounts.google.com/`, or its own redirect, which is the fake provider's whole sign-in.
 * A second Connect cancels the first, and so does Disconnect.
 *
 * Connect and Disconnect are recorded through `CalendarSync.connected` and `disconnected`, never
 * the cache's `recordConnected` or `recordDisconnected`: those also drop a poll already on its
 * way, which would otherwise write a disconnected account's events back into the copy.
 *
 * The code exchange, the revoke and the connection reads take turns: a Disconnect sent during an
 * exchange waits for it, so the API never ends up holding a grant the user just disconnected.
 *
 * Log lines never carry the code, the verifier, the state or the account's address.
 */
export class CalendarAccount {
  private readonly notifier = new Emitter<CalendarAccountEvents>();
  private readonly signInTimeoutMs: number;
  /** The sign-in waiting on the browser, if any: a new Connect or a Disconnect aborts it. */
  private signIn: AbortController | null = null;
  /** Settles once every exchange, revoke and read queued so far has answered, either way. */
  private turns: Promise<void> = Promise.resolve();
  /** The connection listeners last heard; undefined before the first answer. */
  private known: CalendarConnection | null | undefined = undefined;

  constructor(private readonly options: CalendarAccountOptions) {
    this.signInTimeoutMs = options.signInTimeoutMs ?? CALENDAR_SIGN_IN_TIMEOUT_MS;
  }

  /**
   * Runs the Google sign-in and connects the calendar. Resolves with the connection the API
   * stored; the events follow through CalendarSync, which refreshes at once. Rejects with a
   * message for the page: cancelled at Google, timed out, replaced, or the API's refusal.
   */
  async connect(): Promise<CalendarConnection> {
    this.signIn?.abort(new Error('This sign-in was replaced by a newer Connect.'));
    const signIn = new AbortController();
    this.signIn = signIn;
    try {
      const grant = await this.runSignIn(signIn.signal);
      return await this.takeTurn(async () => {
        // A newer Connect or a Disconnect came while this one waited for its turn: the code is
        // dropped unredeemed, so the API never stores a grant nobody wants any more.
        signIn.signal.throwIfAborted();
        let connection: CalendarConnection;
        try {
          connection = await this.options.api.connectGoogle(grant);
        } catch (error) {
          throw this.failure('connect Google Calendar', error);
        }
        this.recordConnected(connection);
        return connection;
      });
    } catch (error) {
      this.options.logger.warn('calendar sign-in failed', { error: errorMessage(error) });
      throw error;
    } finally {
      if (this.signIn === signIn) this.signIn = null;
      // Closes the loopback's port when the sign-in ended before the browser answered.
      signIn.abort();
    }
  }

  /**
   * Revokes the grant at the API, then clears this Mac's copy of the calendar; the prompt log and
   * the connections log stay. Rejects, keeping the copy, when the API cannot revoke: a copy
   * cleared over a grant the API still holds would read as disconnected while it is not.
   */
  async disconnect(): Promise<void> {
    this.signIn?.abort(new Error('This sign-in was cancelled by Disconnect.'));
    await this.takeTurn(async () => {
      try {
        await this.options.api.disconnect();
      } catch (error) {
        const failure = this.failure('disconnect Google Calendar', error);
        this.options.logger.warn('calendar disconnect failed', { error: failure.message });
        throw failure;
      }
      this.setKnown(null);
      try {
        this.options.sync.disconnected();
      } catch (error) {
        this.options.logger.error('calendar disconnect could not be recorded on this Mac', {
          error: errorMessage(error),
        });
        throw new Error(
          `Google Calendar is disconnected, but Roger could not clear its copy on this Mac: ${errorMessage(error)}`,
          { cause: error },
        );
      }
      this.options.logger.info('calendar disconnected');
    });
  }

  /**
   * The connection as the Roger API holds it now (its status and `expiresHint`), or null when
   * there is none. Waits for an exchange or a revoke on its way. Rejects with a message for the
   * page when the API cannot be reached; this Mac's copy of the calendar still works then.
   */
  async getConnection(): Promise<CalendarConnection | null> {
    return this.takeTurn(async () => {
      let connection: CalendarConnection | null;
      try {
        connection = await this.options.api.getConnection();
      } catch (error) {
        const failure = this.failure('read the Google Calendar connection', error);
        this.options.logger.warn('calendar connection read failed', { error: failure.message });
        throw failure;
      }
      this.setKnown(connection);
      return connection;
    });
  }

  /** Each change of the connection as the API last told it: a connect, a disconnect, a read. */
  onConnectionChange(listener: (connection: CalendarConnection | null) => void): () => void {
    return this.notifier.on('connection', (connection) => {
      try {
        listener(connection);
      } catch (error) {
        this.options.logger.error('calendar connection listener failed', {
          error: errorMessage(error),
        });
      }
    });
  }

  /** At quit: a sign-in still waiting on the browser ends and closes its port. */
  stop(): void {
    this.signIn?.abort(new Error('Roger is quitting.'));
  }

  /** Listen, ask the API for the URL, open it, wait for the code. The port closes on any exit. */
  private async runSignIn(signal: AbortSignal): Promise<GoogleConnectionRequest> {
    const pkce = createPkce();
    const state = createOAuthState();
    const loopback = await listenForOAuthCallback({
      state,
      timeoutMs: this.signInTimeoutMs,
      signal,
    });
    let authorizationUrl: string;
    try {
      ({ authorizationUrl } = await this.options.api.createGoogleAuthorization({
        redirectUri: loopback.redirectUri,
        codeChallenge: pkce.challenge,
        state,
      }));
    } catch (error) {
      throw this.failure('connect Google Calendar', error);
    }
    signal.throwIfAborted();
    const url = signInPageToOpen(authorizationUrl, loopback.redirectUri);
    this.options.logger.info('calendar sign-in opened in the browser', {
      page: url.hostname === 'accounts.google.com' ? 'google' : 'own_redirect',
    });
    try {
      await this.options.openExternal(url.href);
    } catch (error) {
      throw new Error(`Could not open the browser for the Google sign-in: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    const outcome = await loopback.outcome;
    if (!outcome.ok) throw outcome.error;
    return { code: outcome.code, codeVerifier: pkce.verifier, redirectUri: loopback.redirectUri };
  }

  /** The API stored the grant: record it on this Mac and tell the listeners. */
  private recordConnected(connection: CalendarConnection): void {
    let refreshed: Promise<void>;
    try {
      refreshed = this.options.sync.connected(connection.accountEmail);
    } catch (error) {
      this.options.logger.error('calendar connect could not be recorded on this Mac', {
        error: errorMessage(error),
      });
      throw new Error(
        `Google Calendar is connected, but Roger could not record it on this Mac: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    // Not awaited: Connect answers once the grant is stored, and the events reach the page as
    // they arrive. The refresh records its own failures; this catches only a broken promise.
    refreshed.catch((error: unknown) => {
      this.options.logger.error('calendar refresh after connect failed', {
        error: errorMessage(error),
      });
    });
    this.options.logger.info('calendar connected', { provider: connection.provider });
    this.setKnown(connection);
  }

  /** Runs `work` after every turn queued before it, whether that one succeeded or not. */
  private takeTurn<T>(work: () => Promise<T>): Promise<T> {
    const result = this.turns.then(work);
    this.turns = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private setKnown(connection: CalendarConnection | null): void {
    if (this.known !== undefined && sameConnection(this.known, connection)) return;
    this.known = connection;
    this.notifier.emit('connection', connection);
  }

  /** An API failure as a message for the page; anything else as it came. */
  private failure(action: string, error: unknown): Error {
    if (!(error instanceof ApiError)) {
      return error instanceof Error ? error : new Error(String(error));
    }
    if (error.status === 0) {
      return new Error(
        `Could not reach the Roger API to ${action}. Is it running? (${error.message})`,
        { cause: error },
      );
    }
    // The API's own words say what to do (connect again, tick the calendar box).
    if (error.code === 'calendar_reconnect_required')
      return new Error(error.message, { cause: error });
    return new Error(`Could not ${action}: ${error.message}`, { cause: error });
  }
}

/**
 * The URL to open, or a refusal. Only Google's sign-in page over https, or this sign-in's own
 * redirect (the fake provider sends the browser straight back with `code=fake`). Whatever the API
 * answered, `shell.openExternal` hands it to macOS, which opens any scheme it knows (`file:`, an
 * app's own): an API that is not ours, or a bug, must not open anything else. The parsed form is
 * what opens, so the check and the browser read the same URL.
 */
function signInPageToOpen(answer: string, redirectUri: string): URL {
  let url: URL;
  try {
    url = new URL(answer);
  } catch {
    throw new Error("Roger opens only Google's sign-in page, and the Roger API answered no URL.");
  }
  const redirect = new URL(redirectUri);
  const plain = url.username === '' && url.password === '';
  const google = url.protocol === 'https:' && url.host === 'accounts.google.com';
  const ownRedirect = url.origin === redirect.origin && url.pathname === OAUTH_CALLBACK_PATH;
  if (plain && (google || ownRedirect)) return url;
  const where = url.host === '' ? url.protocol : `${url.protocol}//${url.host}`;
  throw new Error(`Roger opens only Google's sign-in page, not ${where}.`);
}

function sameConnection(a: CalendarConnection | null, b: CalendarConnection | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.provider === b.provider &&
    a.accountEmail === b.accountEmail &&
    a.status === b.status &&
    a.connectedAt === b.connectedAt &&
    a.expiresHint === b.expiresHint &&
    a.lastError === b.lastError
  );
}
