import { describe, expect, it, vi } from 'vitest';
import type { CalendarConnection, CalendarEvent } from '../../shared/calendar';
import type { CalendarApiPort } from '../calendar/ports';
import { CalendarClient } from './calendarClient';
import { ApiError } from './http';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function client(fetchImpl: typeof fetch): CalendarApiPort {
  return new CalendarClient({ baseUrl: 'http://api.test', token: 'secret', fetchImpl });
}

/** The one request the client made: method, URL, token and JSON body. */
function sent(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) {
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0]!;
  return {
    url,
    method: init?.method,
    authorization: new Headers(init?.headers).get('Authorization'),
    body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body,
  };
}

const REDIRECT = 'http://127.0.0.1:53682/oauth/callback';

const connectionWire = {
  provider: 'google',
  account_email: 'rahul@linkt.ai',
  status: 'active',
  connected_at: '2026-10-06T08:00:00Z',
  expires_hint: '2026-10-13T08:00:00Z',
  last_error: null,
};

const connection: CalendarConnection = {
  provider: 'google',
  accountEmail: 'rahul@linkt.ai',
  status: 'active',
  connectedAt: '2026-10-06T08:00:00Z',
  expiresHint: '2026-10-13T08:00:00Z',
  lastError: null,
};

const timedWire = {
  provider: 'google',
  id: 'abc123_20261006T100000Z',
  ical_uid: 'abc123@google.com',
  recurring_event_id: 'abc123',
  title: 'Weekly sync',
  status: 'confirmed',
  all_day: false,
  start: '2026-10-06T10:00:00Z',
  end: '2026-10-06T10:30:00Z',
  start_date: null,
  end_date: null,
  self_response: 'tentative',
  attendees: [
    {
      email: 'jane@example.com',
      display_name: 'Jane Cooper',
      response_status: 'accepted',
      is_self: false,
      is_organizer: true,
    },
    {
      email: 'rahul@linkt.ai',
      display_name: null,
      response_status: 'tentative',
      is_self: true,
      is_organizer: false,
    },
  ],
  attendees_omitted: true,
  video_link: 'https://meet.google.com/abc-defg-hij',
  video_link_source: 'conference',
  html_link: 'https://www.google.com/calendar/event?eid=abc',
};

const allDayWire = {
  provider: 'google',
  id: 'release',
  ical_uid: null,
  recurring_event_id: null,
  title: '',
  status: 'tentative',
  all_day: true,
  start: null,
  end: null,
  start_date: '2026-10-06',
  end_date: '2026-10-07',
  self_response: 'organizer',
  attendees: [],
  attendees_omitted: false,
  video_link: null,
  video_link_source: null,
  html_link: null,
};

const timed: CalendarEvent = {
  provider: 'google',
  id: 'abc123_20261006T100000Z',
  icalUid: 'abc123@google.com',
  recurringEventId: 'abc123',
  title: 'Weekly sync',
  status: 'confirmed',
  allDay: false,
  start: '2026-10-06T10:00:00Z',
  end: '2026-10-06T10:30:00Z',
  startDate: null,
  endDate: null,
  selfResponse: 'tentative',
  attendees: [
    {
      email: 'jane@example.com',
      displayName: 'Jane Cooper',
      responseStatus: 'accepted',
      isSelf: false,
      isOrganizer: true,
    },
    {
      email: 'rahul@linkt.ai',
      displayName: null,
      responseStatus: 'tentative',
      isSelf: true,
      isOrganizer: false,
    },
  ],
  attendeesOmitted: true,
  videoLink: 'https://meet.google.com/abc-defg-hij',
  videoLinkSource: 'conference',
  htmlLink: 'https://www.google.com/calendar/event?eid=abc',
};

const allDay: CalendarEvent = {
  provider: 'google',
  id: 'release',
  icalUid: null,
  recurringEventId: null,
  title: '',
  status: 'tentative',
  allDay: true,
  start: null,
  end: null,
  startDate: '2026-10-06',
  endDate: '2026-10-07',
  selfResponse: 'organizer',
  attendees: [],
  attendeesOmitted: false,
  videoLink: null,
  videoLinkSource: null,
  htmlLink: null,
};

describe('CalendarClient', () => {
  it('asks for the authorization URL with the redirect, the S256 challenge and the state', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      }),
    );

    await expect(
      client(fetchImpl).createGoogleAuthorization({
        redirectUri: REDIRECT,
        codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        state: 'st-8f2c1d9e0a7b',
      }),
    ).resolves.toEqual({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
    });
    expect(sent(fetchImpl)).toEqual({
      url: 'http://api.test/v1/calendar/google/authorization',
      method: 'POST',
      authorization: 'Bearer secret',
      body: {
        redirect_uri: REDIRECT,
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        state: 'st-8f2c1d9e0a7b',
      },
    });
  });

  it('refuses an authorization answer without a URL, naming the route', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, {}));
    await expect(
      client(fetchImpl).createGoogleAuthorization({
        redirectUri: REDIRECT,
        codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        state: 'st',
      }),
    ).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
      message: 'POST /v1/calendar/google/authorization returned no authorization_url',
    });
  });

  it('sends the code, the verifier and the redirect, and answers the connection in camelCase', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(201, connectionWire));

    await expect(
      client(fetchImpl).connectGoogle({
        code: '4/0AVG7fiQ',
        codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        redirectUri: REDIRECT,
      }),
    ).resolves.toEqual(connection);
    expect(sent(fetchImpl)).toEqual({
      url: 'http://api.test/v1/calendar/google/connection',
      method: 'POST',
      authorization: 'Bearer secret',
      body: {
        code: '4/0AVG7fiQ',
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        redirect_uri: REDIRECT,
      },
    });
  });

  it('reads the connection, or null before any connect', async () => {
    const connected = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { connection: connectionWire }));
    await expect(client(connected).getConnection()).resolves.toEqual(connection);
    expect(sent(connected)).toMatchObject({
      url: 'http://api.test/v1/calendar/connection',
      method: 'GET',
      body: null,
    });

    const none = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { connection: null }));
    await expect(client(none).getConnection()).resolves.toBeNull();
  });

  it('refuses a connection read without the connection key, rather than reading it as none', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, {}));
    await expect(client(fetchImpl).getConnection()).rejects.toMatchObject({
      code: 'invalid_response',
      message: 'GET /v1/calendar/connection returned no connection',
    });
  });

  it('disconnects with DELETE and no body, and resolves on the 204', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(client(fetchImpl).disconnect()).resolves.toBeUndefined();
    expect(sent(fetchImpl)).toEqual({
      url: 'http://api.test/v1/calendar/connection',
      method: 'DELETE',
      authorization: 'Bearer secret',
      body: null,
    });
  });

  it('lists the window with both instants in the query, and maps timed and all-day events', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { items: [allDayWire, timedWire], fetched_at: '2026-10-06T09:59:58Z' }),
      );

    await expect(
      client(fetchImpl).listEvents({
        from: '2026-10-05T22:00:00.000Z',
        to: '2026-10-07T22:00:00+05:30',
      }),
    ).resolves.toEqual({ items: [allDay, timed], fetchedAt: '2026-10-06T09:59:58Z' });
    // An offset's `+` is encoded: a bare one in a query reads as a space, and the API refuses a
    // time without its zone.
    expect(sent(fetchImpl)).toEqual({
      url: 'http://api.test/v1/calendar/events?from=2026-10-05T22%3A00%3A00.000Z&to=2026-10-07T22%3A00%3A00%2B05%3A30',
      method: 'GET',
      authorization: 'Bearer secret',
      body: null,
    });
  });

  it('builds each event afresh, so a key the wire adds never reaches the cache', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        items: [
          {
            ...timedWire,
            surprise: true,
            attendees: [{ ...timedWire.attendees[0], extra: 1 }],
          },
        ],
        fetched_at: '2026-10-06T09:59:58Z',
      }),
    );
    const page = await client(fetchImpl).listEvents({
      from: '2026-10-05T22:00:00Z',
      to: '2026-10-07T22:00:00Z',
    });
    expect(Object.keys(page.items[0]!).sort()).toEqual(Object.keys(timed).sort());
    expect(Object.keys(page.items[0]!.attendees[0]!).sort()).toEqual(
      Object.keys(timed.attendees[0]!).sort(),
    );
  });

  it('refuses an event whose shape does not match all_day, naming its index and never its title', async () => {
    const broken = [
      { ...timedWire, start: null },
      { ...timedWire, end: 7 },
      { ...allDayWire, start_date: null },
      { ...timedWire, all_day: 'no' },
      { ...timedWire, id: 12 },
      { ...timedWire, attendees: null },
    ];
    for (const item of broken) {
      const fetchImpl = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          jsonResponse(200, { items: [timedWire, item], fetched_at: '2026-10-06T09:59:58Z' }),
        ),
      );
      const error = await client(fetchImpl)
        .listEvents({ from: '2026-10-05T22:00:00Z', to: '2026-10-07T22:00:00Z' })
        .catch((e: unknown) => e);
      if (!(error instanceof ApiError))
        throw new Error(`expected an ApiError, got ${String(error)}`);
      expect(error).toMatchObject({ status: 200, code: 'invalid_response' });
      expect(error.message).toMatch(/^GET \/v1\/calendar\/events returned an unreadable item 1: /);
      expect(error.message).not.toContain('Weekly sync');
    }
  });

  it('refuses an events answer without a list or its time', async () => {
    for (const body of [{ fetched_at: '2026-10-06T09:59:58Z' }, { items: [] }]) {
      const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(200, body)));
      await expect(
        client(fetchImpl).listEvents({ from: '2026-10-05T22:00:00Z', to: '2026-10-07T22:00:00Z' }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it("passes the API's refusal on as its ApiError, status and code kept", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(424, {
        error: {
          code: 'calendar_reconnect_required',
          message: "Connect again and tick 'View events on all your calendars'.",
        },
      }),
    );
    const error = await client(fetchImpl)
      .connectGoogle({
        code: 'used',
        codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        redirectUri: REDIRECT,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 424, code: 'calendar_reconnect_required' });
  });
});
