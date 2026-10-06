import type { CalendarConnection, CalendarEventsPage } from '../../shared/calendar';

/**
 * The calendar routes of the Roger API (docs/api-contract.md, Calendar) as main's calendar
 * services use them. `main/api/calendarClient.ts` implements it over `main/api/http.ts`; tests pass
 * a fake typed by this interface. The desktop never sees a Google token: the API exchanges the
 * code and keeps the refresh token (house rule 3).
 *
 * Every method rejects with the API client's `ApiError`, carrying the contract's status and code:
 * `404` no connection, `424` `calendar_reconnect_required` (Google refused the stored grant; stop
 * polling until the next connect), `502` `calendar_provider_error` (Google failed; retry later).
 */
export interface CalendarApiPort {
  /** `POST /v1/calendar/google/authorization`: the URL to open in the default browser. */
  createGoogleAuthorization(request: GoogleAuthorizationRequest): Promise<GoogleAuthorization>;
  /** `POST /v1/calendar/google/connection`: replaces any existing connection. */
  connectGoogle(request: GoogleConnectionRequest): Promise<CalendarConnection>;
  /** `GET /v1/calendar/connection`: null when the calendar is not connected. */
  getConnection(): Promise<CalendarConnection | null>;
  /** `DELETE /v1/calendar/connection`: revokes at Google. Safe to repeat. */
  disconnect(): Promise<void>;
  /** `GET /v1/calendar/events`: timed events as UTC instants, ordered by start. */
  listEvents(window: CalendarWindow): Promise<CalendarEventsPage>;
}

export interface GoogleAuthorizationRequest {
  /** The loopback redirect, `http://127.0.0.1:<port>/oauth/callback`; the API refuses any other. */
  redirectUri: string;
  /** S256 of the verifier. */
  codeChallenge: string;
  state: string;
}

export interface GoogleAuthorization {
  authorizationUrl: string;
}

/**
 * The code and the verifier together are a Google grant until the API redeems them: never put
 * either in a log line, an error message or the browser page.
 */
export interface GoogleConnectionRequest {
  code: string;
  codeVerifier: string;
  /** The same redirect the authorization used; Google refuses the exchange otherwise. */
  redirectUri: string;
}

/** A window of at most 7 days, `from` before `to`, as UTC instants. */
export interface CalendarWindow {
  from: string;
  to: string;
}
