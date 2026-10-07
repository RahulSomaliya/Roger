import { describe, expect, it, vi } from 'vitest';
import { ApiError, authHeaders, createApiRequest, type HttpMethod, toApiError } from './http';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function request(fetchImpl: typeof fetch, timeoutMs?: number) {
  return createApiRequest({
    baseUrl: 'http://api.test',
    token: 'secret',
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe('apiRequest', () => {
  it.each<[HttpMethod, unknown]>([
    ['GET', undefined],
    ['POST', { terms: ['Roger'] }],
    ['PUT', { doc: { type: 'doc' } }],
    ['DELETE', undefined],
  ])(
    'sends %s with the bearer token, and a JSON body only when there is one',
    async (method, body) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { ok: true }));
      await expect(
        request(fetchImpl)<{ ok: boolean }>(method, '/v1/things', body),
      ).resolves.toEqual({
        ok: true,
      });

      const [url, init] = fetchImpl.mock.calls[0]!;
      const headers = new Headers(init?.headers);
      expect(url).toBe('http://api.test/v1/things');
      expect(init?.method).toBe(method);
      expect(headers.get('Authorization')).toBe('Bearer secret');
      expect(headers.get('Accept')).toBe('application/json');
      expect(headers.get('Content-Type')).toBe(body === undefined ? null : 'application/json');
      expect(init?.body).toBe(body === undefined ? null : JSON.stringify(body));
    },
  );

  it('resolves a 204 with no body to undefined (DELETE /v1/calendar/connection)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      request(fetchImpl)<undefined>('DELETE', '/v1/calendar/connection'),
    ).resolves.toBeUndefined();
  });

  it('turns the error envelope into a typed ApiError', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(409, { error: { code: 'conflict', message: 'Note n-1 changed' } }),
      );
    const error = await request(fetchImpl)('PUT', '/v1/notes/n-1', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'conflict', message: 'Note n-1 changed' });
  });

  it('refuses a success whose body is not JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>'));
    await expect(request(fetchImpl)('GET', '/v1/things')).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
      message: 'GET /v1/things returned non-JSON',
    });
  });

  it('names a network failure and a timeout, never a raw fetch error', async () => {
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(request(down)('GET', '/v1/things')).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
      message: 'GET /v1/things failed: fetch failed',
    });

    // Never answers; only the client's own abort ends it.
    const hangs = vi.fn<typeof fetch>((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    });
    await expect(request(hangs, 20)('DELETE', '/v1/things/1')).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
      message: 'DELETE /v1/things/1 failed: timed out after 20 ms',
    });
  });
});

describe('toApiError', () => {
  it('reads the contract envelope, and names the status of anything else', () => {
    expect(
      toApiError(422, '{"error":{"code":"validation_error","message":"bad"}}', 'PUT', '/v1/x'),
    ).toMatchObject({ status: 422, code: 'validation_error', message: 'bad' });
    expect(toApiError(502, '<html>', 'GET', '/v1/x')).toMatchObject({
      status: 502,
      code: 'http_error',
      message: 'GET /v1/x returned HTTP 502',
    });
  });
});

describe('authHeaders', () => {
  it('carries the Roger API token as a bearer token, for requests apiRequest does not make', () => {
    expect(authHeaders('secret')).toEqual({ Authorization: 'Bearer secret' });
  });
});
