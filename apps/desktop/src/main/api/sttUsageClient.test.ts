import { describe, expect, it, vi } from 'vitest';
import type { MeetingSttUsage } from '../store/TranscriptStore';
import { ApiError } from './http';
import { SttUsageClient } from './sttUsageClient';

const MEETING = '6f1d2b7e-8a4c-4f0e-9b1a-2c3d4e5f6a7b';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function client(fetchImpl: typeof fetch): SttUsageClient {
  return new SttUsageClient({ baseUrl: 'http://api.test', token: 'secret', fetchImpl });
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

/** A row as the store reads it: camelCase, the figures as the Mac metered them. */
function usage(overrides: Partial<MeetingSttUsage> = {}): MeetingSttUsage {
  return {
    meetingId: MEETING,
    provider: 'assemblyai',
    total: {
      sessionsOpened: 3,
      connectedMs: 125_000,
      // pcmBytesToMs sums whole chunks in floating point; the API rounds it (contract, STT usage).
      audioSentMs: 16_100.000000000002,
      droppedChunks: 2,
      estimatedCostUsd: 0.0052,
    },
    bySource: {
      mic: {
        sessionsOpened: 2,
        connectedMs: 65_000,
        audioSentMs: 8_100.000000000002,
        droppedChunks: 2,
        estimatedCostUsd: 0.0027,
        gatedMs: 30_000,
      },
      system: {
        sessionsOpened: 1,
        connectedMs: 60_000,
        audioSentMs: 8_000,
        droppedChunks: 0,
        estimatedCostUsd: 0.0025,
      },
    },
    gatedMs: 30_000,
    stopReason: 'user',
    updatedAt: '2026-10-07T10:02:00.000Z',
    ...overrides,
  };
}

describe('SttUsageClient', () => {
  it("PUTs the meeting's whole usage to its route, in the contract's snake_case", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, {}));

    await expect(client(fetchImpl).saveMeetingUsage(usage())).resolves.toBeUndefined();
    expect(sent(fetchImpl)).toEqual({
      url: `http://api.test/v1/stt-usage/meetings/${MEETING}`,
      method: 'PUT',
      authorization: 'Bearer secret',
      body: {
        provider: 'assemblyai',
        sessions_opened: 3,
        connected_ms: 125_000,
        audio_sent_ms: 16_100.000000000002,
        dropped_chunks: 2,
        gated_ms: 30_000,
        estimated_cost_usd: 0.0052,
        by_source: {
          mic: {
            sessions_opened: 2,
            connected_ms: 65_000,
            audio_sent_ms: 8_100.000000000002,
            dropped_chunks: 2,
            gated_ms: 30_000,
            estimated_cost_usd: 0.0027,
          },
          // Gated time left out reads as 0 at the API too; sent as 0, so the wire is whole.
          system: {
            sessions_opened: 1,
            connected_ms: 60_000,
            audio_sent_ms: 8_000,
            dropped_chunks: 0,
            gated_ms: 0,
            estimated_cost_usd: 0.0025,
          },
        },
        stop_reason: 'user',
      },
    });
  });

  it('sends an unknown price and a recording still running as null, never leaving the key out', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, {}));
    const row = usage({ stopReason: null });
    row.total.estimatedCostUsd = null;
    row.bySource.system.estimatedCostUsd = null;
    const { gatedMs: _gated, ...withoutGated } = row;

    await client(fetchImpl).saveMeetingUsage(withoutGated);
    // The API requires `estimated_cost_usd`: a client that left it out must not read as unknown.
    expect(sent(fetchImpl).body).toMatchObject({
      estimated_cost_usd: null,
      gated_ms: 0,
      stop_reason: null,
      by_source: { system: { estimated_cost_usd: null }, mic: { estimated_cost_usd: 0.0027 } },
    });
  });

  it('sends only the fields the contract names: never the meeting id, the save time or the mark', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, {}));
    await client(fetchImpl).saveMeetingUsage(usage());
    const body = sent(fetchImpl).body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'audio_sent_ms',
      'by_source',
      'connected_ms',
      'dropped_chunks',
      'estimated_cost_usd',
      'gated_ms',
      'provider',
      'sessions_opened',
      'stop_reason',
    ]);
  });

  it("passes the API's refusal on as its ApiError, the 422's message naming the field", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(422, {
        error: {
          code: 'validation_error',
          message: 'Invalid request: body.stop_reason: String should have at most 64 characters',
        },
      }),
    );

    const error = await client(fetchImpl)
      .saveMeetingUsage(usage())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'validation_error',
      message: 'Invalid request: body.stop_reason: String should have at most 64 characters',
    });
  });

  it('reports no answer as a network error (status 0), naming the route', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(client(fetchImpl).saveMeetingUsage(usage())).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
      message: `PUT /v1/stt-usage/meetings/${MEETING} failed: fetch failed`,
    });
  });

  it('escapes the meeting id in the path', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, {}));
    await client(fetchImpl).saveMeetingUsage(usage({ meetingId: 'not/a uuid' }));
    expect(sent(fetchImpl).url).toBe('http://api.test/v1/stt-usage/meetings/not%2Fa%20uuid');
  });
});
