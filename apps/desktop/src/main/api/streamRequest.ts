import { type ApiConnection, ApiError, authHeaders, toApiError } from './http';
import { SseParser, type SseEvent } from './sse';

/**
 * The API's streaming routes (M4: `POST .../notes/generate` and `POST .../chat`): a POST with a
 * JSON body whose answer is an event stream. Main reads them (main/notes/LlmStreams.ts) and
 * forwards typed events to the page; the renderer never opens a connection (CLAUDE.md rule 5).
 * Built on http.ts's token header and error envelope, beside apiRequest, which reads whole JSON
 * answers and cannot hand over a body as it arrives.
 */

/**
 * Opens one stream. Resolves once the API answered 2xx with an event stream. Rejects with an
 * ApiError otherwise, as apiRequest does: the contract's envelope for a refusal before the stream
 * (`409 conflict`, `422 empty_meeting`, `502 llm_provider_error`, ...), `invalid_response` for a
 * 2xx that is not a stream, `network_error` (status 0) for no answer in time or an abort.
 *
 * The events then arrive in order, comments and pings left out. The iteration ends when the API
 * closes the stream, and throws a `network_error` ApiError when the connection fails, goes silent
 * longer than the idle timeout, or the caller's signal aborts it. Leaving the iteration early (a
 * `done` event read, a `break`) aborts the request, so no connection is left open. The timers and
 * that cleanup live in the iteration: a caller that resolves a stream and never iterates it must
 * abort its signal, or the connection stays open.
 */
export type StreamRequest = (
  path: string,
  body: unknown,
  signal: AbortSignal,
) => Promise<AsyncIterable<SseEvent>>;

export interface StreamTiming {
  /**
   * How long the API may take to answer. It answers a stream only once the model's vendor took
   * the request (a refusal is a `502` envelope, never an event), and waits for the vendor up to
   * NOTES_TIMEOUT_SECONDS: 120 s by default. With a larger setting the desktop gives up first;
   * the run goes on in the API, and a retry with the same run id attaches to it.
   */
  openTimeoutMs: number;
  /**
   * The longest silence inside a stream. The API sends `: ping` every 15 s, so three missed pings
   * mean a dead connection (a Mac that slept, a wifi change), which would otherwise hang until
   * undici's own body timeout, 5 minutes.
   */
  idleTimeoutMs: number;
}

export const STREAM_TIMING: StreamTiming = { openTimeoutMs: 130_000, idleTimeoutMs: 45_000 };

/**
 * The stream twin of http.ts's createApiRequest, on the same connection. Its `timeoutMs` is
 * apiRequest's whole-request bound and does not apply here: `timing` bounds a stream instead.
 */
export function createStreamRequest(
  connection: ApiConnection,
  timing: StreamTiming = STREAM_TIMING,
): StreamRequest {
  const fetchImpl = connection.fetchImpl ?? globalThis.fetch;

  return async (path, body, signal) => {
    const label = `POST ${path}`;
    // Aborted by the open timeout, the idle timeout, and on the way out of the iteration.
    const connectionAbort = new AbortController();
    const requestSignal = AbortSignal.any([signal, connectionAbort.signal]);
    const openTimer = setTimeout(() => {
      connectionAbort.abort();
    }, timing.openTimeoutMs);
    // Until the stream is handed over, only the open timer aborts the connection.
    const failure = (error: unknown): ApiError => {
      const reason = signal.aborted
        ? 'aborted'
        : connectionAbort.signal.aborted
          ? `no answer within ${timing.openTimeoutMs} ms`
          : describe(error);
      return new ApiError(0, 'network_error', `${label} failed: ${reason}`);
    };
    try {
      let response: Response;
      try {
        response = await fetchImpl(`${connection.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            ...authHeaders(connection.token),
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: requestSignal,
        });
      } catch (error) {
        throw failure(error);
      }
      if (!response.ok) {
        const text = await response.text().catch((error: unknown) => {
          throw failure(error);
        });
        throw toApiError(response.status, text, 'POST', path);
      }
      if (!isEventStream(response) || response.body === null) {
        connectionAbort.abort();
        throw new ApiError(
          response.status,
          'invalid_response',
          `${label} did not answer an event stream`,
        );
      }
      return readEvents(response.body, { label, signal, connectionAbort, timing });
    } finally {
      clearTimeout(openTimer);
    }
  };
}

interface ReadContext {
  label: string;
  /** The caller's signal. */
  signal: AbortSignal;
  connectionAbort: AbortController;
  timing: StreamTiming;
}

async function* readEvents(
  body: ReadableStream<Uint8Array>,
  { label, signal, connectionAbort, timing }: ReadContext,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const parser = new SseParser();
  try {
    for (;;) {
      // Armed only while waiting for bytes: the time a caller spends on an event is not silence.
      let silent = false;
      const idleTimer = setTimeout(() => {
        silent = true;
        connectionAbort.abort();
      }, timing.idleTimeoutMs);
      const chunk = await reader
        .read()
        .catch((error: unknown) => {
          const reason = signal.aborted
            ? 'aborted'
            : silent
              ? `silent for ${timing.idleTimeoutMs} ms`
              : describe(error);
          throw new ApiError(0, 'network_error', `${label} stream failed: ${reason}`);
        })
        .finally(() => {
          clearTimeout(idleTimer);
        });
      if (chunk.done) return;
      yield* parser.push(chunk.value);
    }
  } finally {
    // Also on the way out of an iteration left early: the API stops sending to a closed socket,
    // and the run goes on there (M4 "Where generation runs").
    connectionAbort.abort();
  }
}

/** `text/event-stream`, with or without parameters (`; charset=utf-8`). */
function isEventStream(response: Response): boolean {
  const type = response.headers.get('Content-Type') ?? '';
  return type.split(';')[0]?.trim().toLowerCase() === 'text/event-stream';
}

/** undici's `fetch failed` keeps the reason (ECONNREFUSED, ...) in `cause`; as http.ts does. */
function describe(error: unknown): string {
  if (error instanceof Error)
    return error.cause instanceof Error ? error.cause.message : error.message;
  return String(error);
}
