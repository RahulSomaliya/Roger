import type { TranscriptSegment } from '../../shared/transcript';
import { type ApiConnection, type ApiRequest, createApiRequest } from './http';

// Re-exported: the uploader and its tests import ApiError from here.
export { ApiError } from './http';

/**
 * Typed client for the Roger API's meeting and STT token routes (docs/api-contract.md), on the
 * shared HTTP core in ./http.ts. Other features' routes have their own client files. The desktop
 * speaks camelCase; the wire speaks snake_case; each client maps its own routes, never a caller.
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
  stream: {
    model: string;
    language: string;
    sample_rate: number;
    encoding: string;
    /**
     * USD per hour of one open stream; null when the API knows no price for the model. Optional
     * here although the contract requires it: an API older than the field omits it, and this
     * response is cast, not validated (ApiRequest, http.ts), so it arrives as undefined. Map it
     * with `?? null` (CaptureService.resolveStt): undefined passes every `=== null` check in the
     * meter and the status line read "about $NaN".
     */
    price_per_hour_usd?: number | null;
  };
}

export interface SegmentsAppendResult {
  accepted: number;
  duplicates: number;
}

export class ApiClient {
  private readonly request: ApiRequest;

  constructor(connection: ApiConnection) {
    this.request = createApiRequest(connection);
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
}

/**
 * The slices of the client each service uses. Services take these instead of `ApiClient`, so a test
 * fake typed by them needs no cast (ApiClient's private members make it nominal).
 */
export type UploadApi = Pick<ApiClient, 'createMeeting' | 'appendSegments' | 'endMeeting'>;
export type SttTokenApi = Pick<ApiClient, 'getSttToken'>;

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
