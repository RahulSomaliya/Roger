import type {
  CalendarAttendee,
  CalendarConnection,
  CalendarEvent,
  CalendarEventsPage,
  CalendarProvider,
  SelfResponse,
  VideoLinkSource,
} from '../../shared/calendar';
import type {
  CalendarApiPort,
  CalendarWindow,
  GoogleAuthorization,
  GoogleAuthorizationRequest,
  GoogleConnectionRequest,
} from '../calendar/ports';
import type { CalendarAttendeeDto } from './ApiClient';
import { ApiError, type ApiConnection, type ApiRequest, createApiRequest } from './http';

const AUTHORIZATION_PATH = '/v1/calendar/google/authorization';
const CONNECTION_PATH = '/v1/calendar/google/connection';
const ACCOUNT_PATH = '/v1/calendar/connection';
const EVENTS_PATH = '/v1/calendar/events';

/**
 * Typed client for the calendar routes (docs/api-contract.md, Calendar), on the shared HTTP core in
 * ./http.ts: main's side of `CalendarApiPort` (main/calendar/ports.ts). The desktop never sees a
 * Google token: it hands the API the sign-in code and verifier once, and the API keeps the grant.
 *
 * The wire speaks snake_case; this file maps it to the camelCase types in shared/calendar.ts and
 * is the only place that does for these routes (ApiClient.ts maps a meeting's own event for the
 * create). Answers are cast as the contract types them, as every client's are, but each event is
 * built afresh and the fields its shape depends on are checked: `all_day` decides whether it is
 * timed or all-day, and a timed event without its instants would reach calendar.sqlite and the
 * prompts typed as one that has them.
 */
export class CalendarClient implements CalendarApiPort {
  private readonly request: ApiRequest;

  constructor(connection: ApiConnection) {
    this.request = createApiRequest(connection);
  }

  async createGoogleAuthorization(
    request: GoogleAuthorizationRequest,
  ): Promise<GoogleAuthorization> {
    const body = await this.request<unknown>('POST', AUTHORIZATION_PATH, {
      redirect_uri: request.redirectUri,
      code_challenge: request.codeChallenge,
      state: request.state,
    });
    const url = field(body, 'authorization_url');
    if (typeof url !== 'string') {
      throw invalid('POST', AUTHORIZATION_PATH, 'no authorization_url');
    }
    return { authorizationUrl: url };
  }

  /** The code and the verifier go in the body only, never in a path or a log line. */
  async connectGoogle(request: GoogleConnectionRequest): Promise<CalendarConnection> {
    const body = await this.request<CalendarConnectionWire>('POST', CONNECTION_PATH, {
      code: request.code,
      code_verifier: request.codeVerifier,
      redirect_uri: request.redirectUri,
    });
    return connectionFromWire(body);
  }

  async getConnection(): Promise<CalendarConnection | null> {
    const body = await this.request<unknown>('GET', ACCOUNT_PATH);
    // Checked, not cast: an answer without the key must not read as "not connected", which would
    // put the Connect card up over a calendar that still syncs.
    if (typeof body !== 'object' || body === null || !('connection' in body)) {
      throw invalid('GET', ACCOUNT_PATH, 'no connection');
    }
    const wire = body.connection as CalendarConnectionWire | null;
    return wire === null ? null : connectionFromWire(wire);
  }

  async disconnect(): Promise<void> {
    // `204`, no body: http.ts resolves it to undefined.
    await this.request<undefined>('DELETE', ACCOUNT_PATH);
  }

  async listEvents(window: CalendarWindow): Promise<CalendarEventsPage> {
    // Encoded: a bare `+` in an offset reads as a space in a query, and the API then refuses an
    // instant without its zone.
    const query = new URLSearchParams({ from: window.from, to: window.to });
    const body = await this.request<unknown>('GET', `${EVENTS_PATH}?${query.toString()}`);
    const items = field(body, 'items');
    const fetchedAt = field(body, 'fetched_at');
    if (!Array.isArray(items) || typeof fetchedAt !== 'string') {
      throw invalid('GET', EVENTS_PATH, 'no items or no fetched_at');
    }
    return { items: items.map(eventFromWire), fetchedAt };
  }
}

// The wire shapes, as docs/api-contract.md writes them.

interface CalendarConnectionWire {
  provider: CalendarProvider;
  account_email: string;
  status: CalendarConnection['status'];
  connected_at: string;
  expires_hint: string | null;
  last_error: string | null;
}

interface CalendarEventWire {
  provider: CalendarProvider;
  id: string;
  ical_uid: string | null;
  recurring_event_id: string | null;
  title: string;
  status: CalendarEvent['status'];
  all_day: boolean;
  start: string | null;
  end: string | null;
  start_date: string | null;
  end_date: string | null;
  self_response: SelfResponse;
  attendees: CalendarAttendeeDto[];
  attendees_omitted: boolean;
  video_link: string | null;
  video_link_source: VideoLinkSource | null;
  html_link: string | null;
}

function connectionFromWire(wire: CalendarConnectionWire): CalendarConnection {
  return {
    provider: wire.provider,
    accountEmail: wire.account_email,
    status: wire.status,
    connectedAt: wire.connected_at,
    expiresHint: wire.expires_hint,
    lastError: wire.last_error,
  };
}

/**
 * One event, built field by field. Throws an `invalid_response` naming the item's index when the
 * fields its shape depends on are missing; never its title, which names clients and colleagues.
 */
function eventFromWire(item: unknown, index: number): CalendarEvent {
  const shape = eventShape(item);
  if (typeof shape === 'string') {
    throw invalid('GET', EVENTS_PATH, `an unreadable item ${index}: ${shape}`);
  }
  // eventShape checked what the union depends on; the rest is cast as the contract types it.
  const wire = item as CalendarEventWire;
  const shared = {
    provider: wire.provider,
    id: wire.id,
    icalUid: wire.ical_uid,
    recurringEventId: wire.recurring_event_id,
    title: wire.title,
    status: wire.status,
    selfResponse: wire.self_response,
    attendees: wire.attendees.map(attendeeFromWire),
    attendeesOmitted: wire.attendees_omitted,
    videoLink: wire.video_link,
    videoLinkSource: wire.video_link_source,
    htmlLink: wire.html_link,
  };
  return shape.allDay
    ? { ...shared, ...shape, start: null, end: null }
    : { ...shared, ...shape, startDate: null, endDate: null };
}

/** The fields an event's shape depends on, checked. */
type EventShape =
  | { allDay: false; start: string; end: string }
  | { allDay: true; startDate: string; endDate: string };

/** The item's checked shape, or what makes it unreadable, by field name only. */
function eventShape(item: unknown): EventShape | string {
  if (typeof item !== 'object' || item === null) return 'not an object';
  if (typeof field(item, 'id') !== 'string') return 'id is not a string';
  if (!Array.isArray(field(item, 'attendees'))) return 'attendees is not a list';
  const allDay = field(item, 'all_day');
  if (allDay === true) {
    const [startDate, endDate] = [field(item, 'start_date'), field(item, 'end_date')];
    if (typeof startDate !== 'string' || typeof endDate !== 'string') {
      return 'an all-day event without start_date and end_date';
    }
    return { allDay, startDate, endDate };
  }
  if (allDay === false) {
    const [start, end] = [field(item, 'start'), field(item, 'end')];
    if (typeof start !== 'string' || typeof end !== 'string') {
      return 'a timed event without start and end';
    }
    return { allDay, start, end };
  }
  return 'all_day is not a boolean';
}

function attendeeFromWire(wire: CalendarAttendeeDto): CalendarAttendee {
  return {
    email: wire.email,
    displayName: wire.display_name,
    responseStatus: wire.response_status,
    isSelf: wire.is_self,
    isOrganizer: wire.is_organizer,
  };
}

function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null && key in body
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

function invalid(method: string, path: string, what: string): ApiError {
  return new ApiError(200, 'invalid_response', `${method} ${path} returned ${what}`);
}
