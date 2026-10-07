import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './http';
import { VocabularyClient } from './vocabularyClient';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function client(fetchImpl: typeof fetch): VocabularyClient {
  return new VocabularyClient({ baseUrl: 'http://api.test', token: 'secret', fetchImpl });
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

describe('VocabularyClient', () => {
  it('reads the list with GET /v1/vocabulary and answers its terms', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { terms: ['Linkt', 'Roger'] }));

    await expect(client(fetchImpl).getVocabulary()).resolves.toEqual(['Linkt', 'Roger']);
    expect(sent(fetchImpl)).toEqual({
      url: 'http://api.test/v1/vocabulary',
      method: 'GET',
      authorization: 'Bearer secret',
      body: null,
    });
  });

  it('replaces the whole list with PUT /v1/vocabulary {terms} and answers the list as stored', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { terms: ['Linkt', 'Roger'] }));

    await expect(
      client(fetchImpl).replaceVocabulary(['Roger', ' Linkt ', 'LINKT']),
    ).resolves.toEqual(['Linkt', 'Roger']);
    expect(sent(fetchImpl)).toEqual({
      url: 'http://api.test/v1/vocabulary',
      method: 'PUT',
      authorization: 'Bearer secret',
      body: { terms: ['Roger', ' Linkt ', 'LINKT'] },
    });
  });

  it("passes the API's refusal on as its ApiError", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(422, {
        error: {
          code: 'validation_error',
          message: 'Invalid request: body.terms[2]: String should have at most 50 characters',
        },
      }),
    );

    const error = await client(fetchImpl)
      .replaceVocabulary(['a', 'b', 'c'])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: 'validation_error' });
  });

  it('refuses an answer without a list of terms, naming the route', async () => {
    for (const body of [{}, { terms: 'Linkt' }, { terms: ['Linkt', 7] }]) {
      // A fresh Response per call: a body can be read once.
      const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(200, body)));
      await expect(client(fetchImpl).getVocabulary()).rejects.toMatchObject({
        status: 200,
        code: 'invalid_response',
        message: 'GET /v1/vocabulary returned no list of terms',
      });
      await expect(client(fetchImpl).replaceVocabulary([])).rejects.toMatchObject({
        code: 'invalid_response',
        message: 'PUT /v1/vocabulary returned no list of terms',
      });
    }
  });
});
