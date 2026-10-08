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
import type { SqliteCalendarCache } from './SqliteCalendarCache';

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
  /** Read only: this Mac's `connections_log`, which a read of the connection keeps in line. */
  cache: Pick<SqliteCalendarCache, 'activeConnection'>;
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
 * Connect, Disconnect, and a read that finds this Mac's `connections_log` out of line with the
 * API, are recorded through `CalendarSync.connected` and `disconnected`, never the cache's
 * `recordConnected` or `recordDisconnected`: those also drop a poll already on its way, which
 * would otherwise write a disconnected account's events back into the copy.
 *
 * The API holds the connection, but CalendarSync polls and ReminderScheduler prompts only while
 * `connections_log` has an open row. The two part when another Roger build that shares the API
 * (the dev build keeps its own "Roger Dev" data) connects or disconnects, when calendar.sqlite is
 * new, or when a quit closes the cache under a connect. So every read of the connection brings the
 * log in line (getConnection), and `start` reads it once at launch: left apart, Settings shows a
 * connected account while nothing syncs, Today stays empty, nothing turns stale, and no prompt
 * ever fires.
 *
 * The code exchange, the revoke and the connection reads take turns: a Disconnect sent during an
 * exchange waits for it, so the API never ends up holding a grant the user just disconnected, and
 * `stop` waits for the turn on its way, so a quit never closes the cache under a stored grant.
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
  /** Set by `stop`: the cache is about to close, so nothing new may start. */
  private stopped = false;

  constructor(private readonly options: CalendarAccountOptions) {
    this.signInTimeoutMs = options.signInTimeoutMs ?? CALENDAR_SIGN_IN_TIMEOUT_MS;
  }

  /**
   * Runs the Google sign-in and connects the calendar. Resolves with the connection the API
   * stored; the events follow through CalendarSync, which refreshes at once. Rejects with a
   * message for the page: cancelled at Google, timed out, replaced, or the API's refusal.
   */
  async connect(): Promise<CalendarConnection> {
    if (this.stopped) throw quitting();
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
      this.recordDisconnected();
      this.options.logger.info('calendar disconnected');
    });
  }

  /**
   * The connection as the Roger API holds it now (its status and `expiresHint`), or null when
   * there is none. Waits for an exchange or a revoke on its way. On the way it brings this Mac's
   * `connections_log` in line with the answer (see the class doc): a connection the log lacks, or
   * holds for another account, is recorded, which starts the sync; a log row the API no longer
   * has is closed, which clears the copy. Rejects with a message for the page when the API cannot
   * be reached (this Mac's copy of the calendar still works then), or when this Mac cannot record
   * the answer.
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
      this.bringLogInLine(connection);
      this.setKnown(connection);
      return connection;
    });
  }

  /**
   * At launch, beside CalendarSync's start (M5-T9c's slot; either order works: a connect recorded
   * before the sync starts is read by its start): reads the connection, so a grant made elsewhere
   * starts the sync and the prompts before any page asks, which a hidden window may never do.
   * Never rejects: a failure is logged, and the next read (Settings, Home) tries again.
   */
  async start(): Promise<void> {
    try {
      await this.getConnection();
    } catch (error) {
      this.options.logger.warn('calendar connection not checked at launch', {
        error: errorMessage(error),
      });
    }
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

  /**
   * At quit, before calendar.sqlite closes: a sign-in still waiting on the browser or on its turn
   * ends (its port closes, its code goes unredeemed), and nothing new starts. Resolves once the
   * exchange, revoke or read already sent has answered and been recorded. The API keeps a grant
   * whose code it was sent whatever main does, so the quit hook (M5-T9c's slot) awaits this before
   * it closes the cache; a cache closed first loses the record, which the next launch's `start`
   * then repairs.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.signIn?.abort(quitting());
    await this.turns;
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

  /**
   * The API's answer against this Mac's open `connections_log` row. Compared by account only: a
   * renewed grant for the same account keeps its row (a status or `expiresHint` change is the
   * API's to report), so a read never writes when the two agree. Logs say which way it moved,
   * never the address.
   */
  private bringLogInLine(connection: CalendarConnection | null): void {
    let local: string | null;
    try {
      local = this.options.cache.activeConnection()?.accountEmail ?? null;
    } catch (error) {
      this.options.logger.error('calendar connection on this Mac could not be read', {
        error: errorMessage(error),
      });
      throw new Error(
        `Could not check the Google Calendar connection on this Mac: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (connection === null) {
      if (local === null) return;
      this.options.logger.warn(
        'calendar connected on this Mac but not at the API: clearing the copy',
      );
      this.recordDisconnected();
      return;
    }
    // Trimmed as the cache trims it when it records the account.
    if (local === connection.accountEmail.trim()) return;
    this.options.logger.warn('calendar connected at the API but not on this Mac: recording it', {
      provider: connection.provider,
      onThisMac: local === null ? 'none' : 'another_account',
    });
    this.recordConnected(connection);
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

  /** The API holds no connection: tell the listeners, then clear this Mac's copy. */
  private recordDisconnected(): void {
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
  }

  /**
   * Runs `work` after every turn queued before it, whether that one succeeded or not. Refused once
   * stopped: a turn queued then would run on a closed cache.
   */
  private takeTurn<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(quitting());
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
    // The API's own words say what to do (connect again, tick the calendar box) or why nothing
    // can be done here (`calendar_not_configured`: the server has no Google client, so Connect
    // cannot work from this Mac; docs/api-contract.md, error table).
    if (error.code === 'calendar_reconnect_required' || error.code === 'calendar_not_configured')
      return new Error(error.message, { cause: error });
    return new Error(`Could not ${action}: ${error.message}`, { cause: error });
  }
}

function quitting(): Error {
  return new Error('Roger is quitting.');
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
