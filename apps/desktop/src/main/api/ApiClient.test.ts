import { describe, expect, it, vi } from 'vitest';
import type { TranscriptSegment } from '../../shared/transcript';
import { ApiClient, ApiError } from './ApiClient';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const segment: TranscriptSegment = {
  id: 'seg-1',
  meetingId: 'm-1',
  source: 'mic',
  speaker: 'me',
  startMs: 1000,
  endMs: 2000,
  text: 'Hello',
  confidence: 0.9,
  words: [{ text: 'Hello', startMs: 1000, endMs: 2000, confidence: 0.9 }],
  createdAt: '2026-10-05T10:00:00.000Z',
};

function client(fetchImpl: typeof fetch): ApiClient {
  return new ApiClient({ baseUrl: 'http://api.test', token: 'secret', fetchImpl });
}

/** The client always sends JSON strings; anything else is a bug the test should surface. */
function bodyJson(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('expected a string body');
  return JSON.parse(init.body);
}

describe('ApiClient', () => {
  it('sends the bearer token and maps segments to the wire format', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { accepted: 1, duplicates: 0 }));
    const result = await client(fetchImpl).appendSegments('m-1', [segment]);

    expect(result).toEqual({ accepted: 1, duplicates: 0 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://api.test/v1/meetings/m-1/segments');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret');
    expect(bodyJson(init)).toEqual({
      segments: [
        {
          id: 'seg-1',
          source: 'mic',
          speaker: 'me',
          start_ms: 1000,
          end_ms: 2000,
          text: 'Hello',
          confidence: 0.9,
          words: [{ text: 'Hello', start_ms: 1000, end_ms: 2000, confidence: 0.9 }],
        },
      ],
    });
  });

  it('creates and ends meetings with snake_case instants', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse(201, { id: 'm-1' })));
    await client(fetchImpl).createMeeting({
      id: 'm-1',
      title: 'T',
      startedAt: '2026-10-05T10:00:00Z',
    });
    await client(fetchImpl).endMeeting('m-1', '2026-10-05T10:30:00Z');

    expect(bodyJson(fetchImpl.mock.calls[0]![1])).toEqual({
      id: 'm-1',
      title: 'T',
      started_at: '2026-10-05T10:00:00Z',
    });
    expect(fetchImpl.mock.calls[1]![0]).toBe('http://api.test/v1/meetings/m-1/end');
    expect(bodyJson(fetchImpl.mock.calls[1]![1])).toEqual({
      ended_at: '2026-10-05T10:30:00Z',
    });
  });

  it('turns the error envelope into a typed ApiError', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(404, { error: { code: 'not_found', message: 'Meeting m-9 not found' } }),
      );
    const error = await client(fetchImpl)
      .endMeeting('m-9', '2026-10-05T10:30:00Z')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'Meeting m-9 not found',
      isNotFound: true,
    });
  });

  describe('getSttToken', () => {
    const stream = {
      model: 'universal-streaming-english',
      language: 'en',
      sample_rate: 16000,
      encoding: 'linear16',
      price_per_hour_usd: 0.19,
    };
    const token = (streamBody: Record<string, unknown>): Record<string, unknown> => ({
      provider: 'assemblyai',
      access_token: 'vendor-token',
      expires_in: 30,
      stream: streamBody,
    });

    it('posts to the token route and returns the jargon list with the stream settings', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(200, token({ ...stream, keyterms: ['Linkt', 'Roger'] })));
      const result = await client(fetchImpl).getSttToken();

      const [url, init] = fetchImpl.mock.calls[0]!;
      expect(url).toBe('http://api.test/v1/stt/token');
      expect(init?.method).toBe('POST');
      expect(result).toEqual(token({ ...stream, keyterms: ['Linkt', 'Roger'] }));
    });

    it('reads a response without keyterms, from an API older than the list, as an empty list', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, token(stream)));
      const result = await client(fetchImpl).getSttToken();

      expect(result.stream.keyterms).toEqual([]);
      expect(result).toEqual(token({ ...stream, keyterms: [] }));
    });
  });

  it('reports non-envelope failures and network errors without throwing raw fetch errors', async () => {
    const html = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>', { status: 502 }));
    await expect(client(html).getSttToken()).rejects.toMatchObject({
      status: 502,
      code: 'http_error',
    });

    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(client(down).getSttToken()).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    });
  });
});
