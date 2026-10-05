import type { TranscriptSegment } from '../../shared/transcript';

/**
 * Typed client for the Roger API (docs/api-contract.md). The desktop speaks camelCase; the wire
 * speaks snake_case; the mapping lives here and nowhere else.
 */

export interface MeetingDto {
  id: string;
  workspace_id: string;
  title: string;
  status: 'recording' | 'ended';
  started_at: string;
  ended_at: string | null;
  segment_count: number;
  created_at: string;
  updated_at: string;
}

export interface SttTokenResponse {
  provider: string;
  access_token: string;
  expires_in: number;
  stream: { model: string; language: string; sample_rate: number; encoding: string };
}

export interface SegmentsAppendResult {
  accepted: number;
  duplicates: number;
}

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

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: ApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  getSttToken(): Promise<SttTokenResponse> {
    return this.request<SttTokenResponse>('POST', '/v1/stt/token');
  }

  createMeeting(input: { id: string; title: string; startedAt: string }): Promise<MeetingDto> {
    return this.request<MeetingDto>('POST', '/v1/meetings', {
      id: input.id,
      title: input.title,
      started_at: input.startedAt,
    });
  }

  appendSegments(meetingId: string, segments: TranscriptSegment[]): Promise<SegmentsAppendResult> {
    return this.request<SegmentsAppendResult>(
      'POST',
      `/v1/meetings/${encodeURIComponent(meetingId)}/segments`,
      { segments: segments.map(segmentToWire) },
    );
  }

  endMeeting(meetingId: string, endedAt: string): Promise<MeetingDto> {
    return this.request<MeetingDto>('POST', `/v1/meetings/${encodeURIComponent(meetingId)}/end`, {
      ended_at: endedAt,
    });
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? null : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = controller.signal.aborted
        ? `timed out after ${this.timeoutMs} ms`
        : describe(error);
      throw new ApiError(0, 'network_error', `${method} ${path} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) throw toApiError(response.status, text, method, path);
    try {
      // The contract promises JSON on every 2xx; the caller's type parameter names the shape.
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(
        response.status,
        'invalid_response',
        `${method} ${path} returned non-JSON`,
      );
    }
  }
}

function segmentToWire(segment: TranscriptSegment): Record<string, unknown> {
  return {
    id: segment.id,
    source: segment.source,
    speaker: segment.speaker,
    start_ms: segment.startMs,
    end_ms: segment.endMs,
    text: segment.text,
    confidence: segment.confidence,
    words:
      segment.words === null
        ? null
        : segment.words.map((word) => ({
            text: word.text,
            start_ms: word.startMs,
            end_ms: word.endMs,
            confidence: word.confidence,
          })),
  };
}

function toApiError(status: number, text: string, method: string, path: string): ApiError {
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
