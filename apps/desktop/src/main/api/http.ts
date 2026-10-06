/**
 * The HTTP core every Roger API client is built on (docs/api-contract.md): ApiClient for meetings
 * and tokens, and one file per feature (vocabularyClient, notesClient, calendarClient, ...) so no
 * two features edit the same client. A client takes an ApiRequest and maps its own types; the
 * bearer token, the timeout and the error envelope are handled here once.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export interface ApiConnection {
  baseUrl: string;
  /** The Roger API token: the only credential the desktop holds (CLAUDE.md rule 3). */
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * One request to the Roger API. The body, when given, is sent as JSON; the answer is the parsed
 * JSON body, typed by the caller from the contract (cast, not validated). A 204 resolves to
 * undefined: type such a call `<undefined>`. Any failure is an ApiError: the contract's envelope,
 * `http_error`, `invalid_response`, or `network_error` (status 0) for no answer or a timeout.
 */
export type ApiRequest = <T>(method: HttpMethod, path: string, body?: unknown) => Promise<T>;

const DEFAULT_TIMEOUT_MS = 10_000;

/** The header that carries the token, for a request apiRequest does not make (a stream). */
export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function createApiRequest(connection: ApiConnection): ApiRequest {
  const fetchImpl = connection.fetchImpl ?? globalThis.fetch;
  const timeoutMs = connection.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async <T>(method: HttpMethod, path: string, body?: unknown): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${connection.baseUrl}${path}`, {
        method,
        headers: {
          ...authHeaders(connection.token),
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? null : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = controller.signal.aborted
        ? `timed out after ${timeoutMs} ms`
        : describe(error);
      throw new ApiError(0, 'network_error', `${method} ${path} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) throw toApiError(response.status, text, method, path);
    // A DELETE answers 204 with no body; the caller typed the call `<undefined>`.
    if (response.status === 204) return undefined as T;
    try {
      // The contract promises JSON on every other 2xx; the caller's type parameter names the shape.
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(
        response.status,
        'invalid_response',
        `${method} ${path} returned non-JSON`,
      );
    }
  };
}

/** The contract's error envelope as an ApiError, or `http_error` naming the status. */
export function toApiError(status: number, text: string, method: string, path: string): ApiError {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof parsed.error === 'object' &&
      parsed.error !== null &&
      'code' in parsed.error &&
      'message' in parsed.error
    ) {
      return new ApiError(status, String(parsed.error.code), String(parsed.error.message));
    }
  } catch {
    // fall through: not the contract envelope
  }
  return new ApiError(status, 'http_error', `${method} ${path} returned HTTP ${status}`);
}

function describe(error: unknown): string {
  if (error instanceof Error)
    return error.cause instanceof Error ? error.cause.message : error.message;
  return String(error);
}
