import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiRequest, type HttpMethod } from '../api/http';
import { createLogger } from '../logger';
import {
  checkConnections,
  type ConnectionChecksOptions,
  describeServerFailure,
} from './connectionChecks';

const BASE_URL = 'http://127.0.0.1:8000';
/** What `POST /v1/stt/token` carries: the vendor credential no log line or message may hold. */
const VENDOR_TOKEN = 'aai-temp-7f3c9d2e';

const OFFLINE = (path: string): ApiError =>
  new ApiError(0, 'network_error', `${path} failed: connect ECONNREFUSED 127.0.0.1:8000`);

function tokenAnswer(stream: { sample_rate?: number; encoding?: string } = {}) {
  return {
    provider: 'assemblyai',
    access_token: VENDOR_TOKEN,
    expires_in: 30,
    stream: {
      model: 'universal-streaming-english',
      sample_rate: 16_000,
      encoding: 'linear16',
      ...stream,
    },
  };
}

type Route = `${HttpMethod} ${string}`;

/** A Roger API that answers each route with a value, or fails it with an error. */
function api(routes: Partial<Record<Route, unknown>>) {
  const calls: Route[] = [];
  const request = vi.fn((method: HttpMethod, path: string): Promise<unknown> => {
    const route: Route = `${method} ${path}`;
    calls.push(route);
    if (!(route in routes)) return Promise.reject(new Error(`no route ${route} in this test`));
    const answer = routes[route];
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  // The generic ApiRequest is called with a type parameter the fake cannot see; it answers unknown.
  return { request: request as ApiRequest, calls };
}

function options(request: ApiRequest, change: Partial<ConnectionChecksOptions> = {}) {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) });
  return {
    lines,
    options: {
      request,
      baseUrl: BASE_URL,
      hasApiToken: true,
      sttProviderOverride: null,
      isKnownProvider: (provider: string) => provider === 'assemblyai' || provider === 'fake',
      logger,
      ...change,
    } satisfies ConnectionChecksOptions,
  };
}

describe('checkConnections', () => {
  it('says both are fine when the API is healthy and hands out a token', async () => {
    const { request, calls } = api({
      'GET /health': { status: 'ok', version: '0.1.0', database: 'ok' },
      'POST /v1/stt/token': tokenAnswer(),
    });
    const { options: checks } = options(request);
    await expect(checkConnections(checks)).resolves.toEqual({
      api: { state: 'ok', message: null, relaunchNeeded: false },
      stt: { state: 'ok', message: null, relaunchNeeded: false },
    });
    expect(calls.sort()).toEqual(['GET /health', 'POST /v1/stt/token']);
  });

  it("says in plain words that Roger can't reach its server, once, never the raw error", async () => {
    const { request } = api({
      'GET /health': OFFLINE('GET /health'),
      'POST /v1/stt/token': OFFLINE('POST /v1/stt/token'),
    });
    const { options: checks, lines } = options(request);
    const result = await checkConnections(checks);
    expect(result.api).toEqual({
      state: 'failed',
      message:
        "Roger can't reach its server. Check that the server is running and that this Mac is online.",
      relaunchNeeded: false,
    });
    // The same cause twice would be two red rows for one problem.
    expect(result.stt).toEqual({
      state: 'unknown',
      message: "Not checked: Roger can't reach its server.",
      relaunchNeeded: false,
    });
    for (const check of [result.api, result.stt]) {
      expect(check.message).not.toMatch(/ECONNREFUSED|failed:|POST |GET /);
    }
    // The raw reason goes to the log, for whoever debugs it.
    expect(lines.join('\n')).toContain('connect ECONNREFUSED 127.0.0.1:8000');
    expect(lines.join('\n')).toContain(BASE_URL);
  });

  it('names a refused token and asks for a relaunch, since the token is read at startup', async () => {
    const { request } = api({
      'GET /health': { status: 'ok', database: 'ok' },
      'POST /v1/stt/token': new ApiError(401, 'unauthorized', 'Missing or invalid bearer token'),
    });
    const { options: checks, lines } = options(request);
    const result = await checkConnections(checks);
    expect(result.api.state).toBe('ok');
    expect(result.stt).toEqual({
      state: 'failed',
      message:
        "Roger's server did not accept this copy of Roger's access key. Check the key, then relaunch Roger.",
      relaunchNeeded: true,
    });
    // The setting that fixes it is for whoever reads the log, not for the row.
    expect(lines.join('\n')).toContain('ROGER_DESKTOP_API_TOKEN');
  });

  it('fetches no token without an API token, and says how to add one', async () => {
    const { request, calls } = api({ 'GET /health': { status: 'ok', database: 'ok' } });
    const { options: checks, lines } = options(request, { hasApiToken: false });
    const result = await checkConnections(checks);
    expect(calls).toEqual(['GET /health']);
    expect(lines.join('\n')).toContain('ROGER_DESKTOP_API_TOKEN');
    expect(result.stt).toEqual({
      state: 'failed',
      message: 'Roger has no access key for its server. Add one, then relaunch Roger.',
      relaunchNeeded: true,
    });
  });

  it("names the vendor's refusal of a token without the API's raw reply", async () => {
    const { request } = api({
      'GET /health': { status: 'ok', database: 'ok' },
      'POST /v1/stt/token': new ApiError(502, 'stt_provider_error', 'AssemblyAI answered 401'),
    });
    const result = await checkConnections(options(request).options);
    expect(result.stt).toEqual({
      state: 'failed',
      message:
        "Roger's server could not start a speech-to-text session: the speech service refused or did not answer. Check the server's key for it.",
      relaunchNeeded: false,
    });
  });

  it('says the database is down when the API answers 503 to its health check', async () => {
    const { request } = api({
      'GET /health': new ApiError(503, 'http_error', 'GET /health returned HTTP 503'),
      'POST /v1/stt/token': tokenAnswer(),
    });
    const result = await checkConnections(options(request).options);
    expect(result.api).toEqual({
      state: 'failed',
      message: "Roger's server is running but cannot reach its database.",
      relaunchNeeded: false,
    });
    expect(result.stt.state).toBe('ok');
  });

  it('refuses a vendor this copy of Roger has no adapter for, as Start would', async () => {
    const { request } = api({
      'GET /health': { status: 'ok', database: 'ok' },
      'POST /v1/stt/token': { ...tokenAnswer(), provider: 'soniox' },
    });
    const result = await checkConnections(options(request).options);
    expect(result.stt).toEqual({
      state: 'failed',
      message:
        "Roger's server uses a speech-to-text service this copy of Roger does not know. Update Roger, or ask whoever runs the server to switch services.",
      relaunchNeeded: false,
    });
  });

  it('refuses an audio format Roger does not send, as Start would', async () => {
    const { request } = api({
      'GET /health': { status: 'ok', database: 'ok' },
      'POST /v1/stt/token': tokenAnswer({ sample_rate: 48_000 }),
    });
    const result = await checkConnections(options(request).options);
    expect(result.stt).toEqual({
      state: 'failed',
      message:
        "Roger's server asks for a different audio format than this copy of Roger sends, so transcripts would come out as garbage. Update Roger, or ask whoever runs the server to match it.",
      relaunchNeeded: false,
    });
  });

  it('keeps every internal out of every message and in the log', async () => {
    const failures: ApiError[] = [
      new ApiError(0, 'network_error', 'GET /health failed: connect ECONNREFUSED 127.0.0.1:8000'),
      new ApiError(0, 'network_error', 'GET /health failed: timed out after 5000 ms'),
      new ApiError(401, 'unauthorized', 'bad bearer'),
      new ApiError(404, 'not_found', 'Not found'),
      new ApiError(502, 'stt_provider_error', 'AssemblyAI answered 401'),
      new ApiError(503, 'http_error', 'GET /health returned HTTP 503'),
      new ApiError(500, 'internal_error', 'boom'),
      new ApiError(200, 'invalid_response', 'GET /health returned non-JSON'),
      new ApiError(422, 'validation_error', 'body.sample_rate: Field required'),
    ];
    const messages: string[] = [];
    for (const failure of failures) {
      const { request } = api({ 'GET /health': failure, 'POST /v1/stt/token': failure });
      const { options: checks } = options(request);
      const result = await checkConnections(checks);
      messages.push(result.api.message ?? '', result.stt.message ?? '');
    }
    for (const bad of [
      { options: { hasApiToken: false }, token: tokenAnswer() },
      { options: {}, token: { ...tokenAnswer(), provider: 'soniox' } },
      { options: {}, token: tokenAnswer({ sample_rate: 48_000, encoding: 'mulaw' }) },
    ]) {
      const { request } = api({ 'GET /health': { status: 'ok' }, 'POST /v1/stt/token': bad.token });
      const result = await checkConnections(options(request, bad.options).options);
      messages.push(result.stt.message ?? '');
    }
    messages.push(describeServerFailure(new TypeError('fetch is not a function')).message);
    expect(messages.filter((message) => message !== '')).toHaveLength(22);
    for (const message of messages) {
      expect(message).not.toMatch(
        /ROGER_|STT_|config\.json|HTTP|https?:|127\.0|:\d{4}|\bHz\b|linear16|mulaw|soniox|assemblyai|vendor|\bAPI\b|token|Postgres|\/v1|fetch/i,
      );
    }
  });

  it('asks the API for no token with the fake provider: Start asks for none either', async () => {
    const { request, calls } = api({ 'GET /health': { status: 'ok', database: 'ok' } });
    const result = await checkConnections(
      options(request, { sttProviderOverride: 'fake' }).options,
    );
    expect(calls).toEqual(['GET /health']);
    expect(result.stt).toEqual({ state: 'ok', message: null, relaunchNeeded: false });
  });

  it('never puts the vendor credential in a log line', async () => {
    const { request } = api({
      'GET /health': { status: 'ok', database: 'ok' },
      'POST /v1/stt/token': tokenAnswer({ sample_rate: 8_000 }),
    });
    const { options: checks, lines } = options(request);
    await checkConnections(checks);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(VENDOR_TOKEN);
  });
});

describe('describeServerFailure', () => {
  it('reads a timeout as no answer, not as an address nobody listens on', () => {
    expect(
      describeServerFailure(
        new ApiError(0, 'network_error', 'GET /health failed: timed out after 5000 ms'),
      ),
    ).toEqual({
      message:
        "Roger's server did not answer in time. Check that the server is running and that this Mac is online.",
      relaunchNeeded: false,
    });
  });

  it('says an older server lacks the route', () => {
    expect(describeServerFailure(new ApiError(404, 'not_found', 'Not found')).message).toBe(
      "Roger's server does not know this request: it may be older than this copy of Roger.",
    );
  });

  it("points at the server's log for its own failures", () => {
    expect(describeServerFailure(new ApiError(500, 'internal_error', 'boom')).message).toBe(
      "Roger's server failed. Its log says why.",
    );
  });

  it('says something else answered when the reply is not the Roger API, never the request text', () => {
    // api/http.ts's own texts for a reply without the API's error envelope: a network sign-in
    // page, or the address set to another server (the Roger API always sends the envelope).
    const notRoger =
      "Something answered, but not Roger's server: a network sign-in page, or another server at that address. Check the server address Roger uses, then relaunch Roger.";
    for (const error of [
      new ApiError(200, 'invalid_response', 'GET /health returned non-JSON'),
      new ApiError(405, 'http_error', 'POST /v1/stt/token returned HTTP 405'),
      new ApiError(429, 'http_error', 'POST /v1/stt/token returned HTTP 429'),
    ]) {
      expect(describeServerFailure(error)).toEqual({
        message: notRoger,
        relaunchNeeded: true,
      });
    }
  });

  it("gives the status of the API's own refusal, and leaves its reason to the log", () => {
    const refusal = describeServerFailure(
      new ApiError(422, 'validation_error', 'body.sample_rate: Field required'),
    );
    expect(refusal).toEqual({
      message: "Roger's server turned down the check. Roger's log says why.",
      relaunchNeeded: false,
    });
  });

  it("names an error that is not the API client's", () => {
    expect(describeServerFailure(new TypeError('fetch is not a function')).message).toBe(
      'Roger could not check its server. Its log says why.',
    );
  });
});
