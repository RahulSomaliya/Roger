import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './http';
import type { SseEvent } from './sse';
import { createStreamRequest, type StreamTiming } from './streamRequest';

const encoder = new TextEncoder();

/**
 * An event-stream body the test writes to, as undici serves one: aborting the request's signal
 * errors the body, so a pending read rejects.
 */
function sseBody(signal: AbortSignal | null | undefined) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  signal?.addEventListener('abort', () => {
    controller.error(new DOMException('This operation was aborted', 'AbortError'));
  });
  return {
    body,
    write: (text: string) => {
      controller.enqueue(encoder.encode(text));
    },
    end: () => {
      controller.close();
    },
    fail: () => {
      controller.error(new TypeError('terminated'));
    },
  };
}

type Body = ReturnType<typeof sseBody>;

/** A fetch that answers every request with a fresh event stream, handed to the test. */
function streamingFetch() {
  const bodies: Body[] = [];
  const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
    const body = sseBody(init?.signal);
    bodies.push(body);
    return Promise.resolve(
      new Response(body.body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
      }),
    );
  });
  return { fetchImpl, bodies };
}

function streamRequest(fetchImpl: typeof fetch, timing?: Partial<StreamTiming>) {
  return createStreamRequest(
    { baseUrl: 'http://api.test', token: 'secret', fetchImpl },
    { openTimeoutMs: 1_000, idleTimeoutMs: 1_000, ...timing },
  );
}

async function collect(events: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const seen: SseEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe('streamRequest', () => {
  it('posts the JSON body with the bearer token and asks for an event stream', async () => {
    const { fetchImpl, bodies } = streamingFetch();
    const events = await streamRequest(fetchImpl)(
      '/v1/meetings/m-1/chat',
      { message_id: 'q-1', text: 'What did we decide?' },
      new AbortController().signal,
    );
    bodies[0]!.end();
    await collect(events);

    const [url, init] = fetchImpl.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(url).toBe('http://api.test/v1/meetings/m-1/chat');
    expect(init?.method).toBe('POST');
    expect(headers.get('Authorization')).toBe('Bearer secret');
    expect(headers.get('Accept')).toBe('text/event-stream');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify({ message_id: 'q-1', text: 'What did we decide?' }));
  });

  it('an error envelope before the stream rejects with ApiError', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'empty_meeting', message: 'Meeting m-1 has no lines' } }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    const error = await streamRequest(fetchImpl)(
      '/v1/meetings/m-1/notes/generate',
      {},
      new AbortController().signal,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'empty_meeting',
      message: 'Meeting m-1 has no lines',
    });
  });

  it('refuses a success that is not an event stream, and a request that never answers', async () => {
    const json = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
    await expect(
      streamRequest(json)('/v1/meetings/m-1/chat', {}, new AbortController().signal),
    ).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
      message: 'POST /v1/meetings/m-1/chat did not answer an event stream',
    });

    const down = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:8000') }),
      );
    await expect(
      streamRequest(down)('/v1/meetings/m-1/chat', {}, new AbortController().signal),
    ).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
      message: 'POST /v1/meetings/m-1/chat failed: connect ECONNREFUSED 127.0.0.1:8000',
    });

    // The API answers a stream only once the model's vendor took the request; this one never does.
    const hangs = vi.fn<typeof fetch>((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    });
    await expect(
      streamRequest(hangs, { openTimeoutMs: 20 })(
        '/v1/meetings/m-1/chat',
        {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
      message: 'POST /v1/meetings/m-1/chat failed: no answer within 20 ms',
    });
  });

  it('yields events as they arrive and ends when the API closes the stream', async () => {
    const { fetchImpl, bodies } = streamingFetch();
    const events = await streamRequest(fetchImpl)(
      '/v1/meetings/m-1/chat',
      {},
      new AbortController().signal,
    );
    const iterator = events[Symbol.asyncIterator]();

    bodies[0]!.write('event: run\ndata: {"run_id":"r-1"}\n\n: ping\n\nevent: del');
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { event: 'run', data: '{"run_id":"r-1"}' },
    });
    bodies[0]!.write('ta\ndata: Hi\n\n');
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { event: 'delta', data: 'Hi' },
    });
    bodies[0]!.end();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('a connection that drops or goes silent fails the stream with network_error', async () => {
    const { fetchImpl, bodies } = streamingFetch();
    const dropped = await streamRequest(fetchImpl)(
      '/v1/meetings/m-1/chat',
      {},
      new AbortController().signal,
    );
    bodies[0]!.write('event: delta\ndata: Hi\n\n');
    bodies[0]!.fail();
    await expect(collect(dropped)).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
      message: 'POST /v1/meetings/m-1/chat stream failed: terminated',
    });

    // Pings keep a healthy stream talking; silence past the idle timeout is a dead connection
    // (a Mac that slept, a wifi change), which would otherwise hang until undici's own timeout.
    const silent = await streamRequest(fetchImpl, { idleTimeoutMs: 30 })(
      '/v1/meetings/m-1/chat',
      {},
      new AbortController().signal,
    );
    const iterator = silent[Symbol.asyncIterator]();
    setTimeout(() => {
      bodies[1]!.write(': ping\n\n');
    }, 15);
    setTimeout(() => {
      bodies[1]!.write(': ping\n\nevent: delta\ndata: still here\n\n');
    }, 30);
    await expect(iterator.next()).resolves.toMatchObject({ value: { data: 'still here' } });
    await expect(iterator.next()).rejects.toMatchObject({
      code: 'network_error',
      message: 'POST /v1/meetings/m-1/chat stream failed: silent for 30 ms',
    });
    expect(fetchImpl.mock.calls[1]![1]?.signal?.aborted).toBe(true);
  });

  it("the caller's signal aborts it, and leaving the iteration early closes the request", async () => {
    const { fetchImpl, bodies } = streamingFetch();
    const caller = new AbortController();
    const events = await streamRequest(fetchImpl)('/v1/meetings/m-1/chat', {}, caller.signal);
    const iterator = events[Symbol.asyncIterator]();
    const next = iterator.next();
    caller.abort();
    await expect(next).rejects.toMatchObject({
      code: 'network_error',
      message: 'POST /v1/meetings/m-1/chat stream failed: aborted',
    });

    const early = await streamRequest(fetchImpl)(
      '/v1/meetings/m-1/chat',
      {},
      new AbortController().signal,
    );
    bodies[1]!.write('event: done\ndata: {}\n\nevent: extra\ndata: {}\n\n');
    for await (const event of early) {
      expect(event.event).toBe('done');
      break;
    }
    expect(fetchImpl.mock.calls[1]![1]?.signal?.aborted).toBe(true);
  });
});
