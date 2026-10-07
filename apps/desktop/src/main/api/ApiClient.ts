import type {
  CalendarAttendee,
  CalendarProvider,
  MeetingCalendarEvent,
  ResponseStatus,
} from '../../shared/calendar';
import type { StartSource } from '../../shared/capture';
import type { TranscriptSegment } from '../../shared/transcript';
import { type ApiConnection, type ApiRequest, createApiRequest } from './http';

// Re-exported: the uploader and its tests import ApiError from here.
export { ApiError } from './http';

/**
 * Typed client for the Roger API's meeting and STT token routes (docs/api-contract.md), on the
 * shared HTTP core in ./http.ts. Other features' routes have their own client files. The desktop
 * speaks camelCase; the wire speaks snake_case; each client maps its own routes, never a caller.
 */

/** The contract's `CalendarAttendee`, as the wire spells it. */
export interface CalendarAttendeeDto {
  email: string;
  display_name: string | null;
  response_status: ResponseStatus;
  is_self: boolean;
  is_organizer: boolean;
}

/** The contract's `MeetingCalendarEvent`: the event a meeting was started for. */
export interface MeetingCalendarEventDto {
  provider: CalendarProvider;
  event_id: string;
  ical_uid: string | null;
  recurring_event_id: string | null;
  scheduled_start: string;
  scheduled_end: string;
  attendees: CalendarAttendeeDto[];
}

export interface MeetingDto {
  id: string;
  workspace_id: string;
  title: string;
  status: 'recording' | 'ended';
  started_at: string;
  ended_at: string | null;
  segment_count: number;
  start_source: StartSource;
  calendar_event: MeetingCalendarEventDto | null;
  created_at: string;
  updated_at: string;
}

/** A meeting as the uploader creates it in Postgres (`POST /v1/meetings`). */
export interface NewMeeting {
  id: string;
  title: string;
  startedAt: string;
  startSource: StartSource;
  calendarEvent: MeetingCalendarEvent | null;
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
    /**
     * USD per hour of one stream opened with no keyterms: the base price alone, never the vendor's
     * keyterm surcharge, and the same as `price_per_hour_usd` when `keyterms` is empty (contract,
     * `POST /v1/stt/token`). The vendor bills a stream by what it was opened with, so a stream
     * opened with `keyterms: []` from a token that carried a list is metered at this price: M3-T4b's
     * reopen after the vendor refused the list, and every stream of a bench `--no-keyterms` run
     * (bench/run/credentials.ts). Null when the API knows no base price. Optional for the same
     * reason as `price_per_hour_usd`: an API older than the field omits it, so it arrives as
     * undefined; meter such a stream at `price_per_hour_usd` (it errs high), mapped as above.
     */
    price_per_hour_usd_without_keyterms?: number | null;
    /**
     * The workspace's jargon list for the vendor, [] when it has none. Never missing here, unlike
     * the price: getSttToken fills [] for an API older than the list, which omits it (the response
     * is cast, so it would arrive as undefined).
     */
    keyterms: string[];
  };
}

/** The token response as it arrives: an API older than the jargon list sends no `keyterms`. */
type SttTokenWire = Omit<SttTokenResponse, 'stream'> & {
  stream: Omit<SttTokenResponse['stream'], 'keyterms'> & { keyterms?: string[] };
};

export interface SegmentsAppendResult {
  accepted: number;
  duplicates: number;
}

export class ApiClient {
  private readonly request: ApiRequest;

  constructor(connection: ApiConnection) {
    this.request = createApiRequest(connection);
  }

  async getSttToken(): Promise<SttTokenResponse> {
    const token = await this.request<SttTokenWire>('POST', '/v1/stt/token');
    return { ...token, stream: { ...token.stream, keyterms: token.stream.keyterms ?? [] } };
  }

  /**
   * The create carries how the meeting was started and its calendar event: the API stores them
   * only from the create that makes the meeting, never from a re-send (contract).
   */
  createMeeting(input: NewMeeting): Promise<MeetingDto> {
    return this.request<MeetingDto>('POST', '/v1/meetings', {
      id: input.id,
      title: input.title,
      started_at: input.startedAt,
      start_source: input.startSource,
      calendar_event:
        input.calendarEvent === null ? null : calendarEventToWire(input.calendarEvent),
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

/**
 * The event a meeting was started for, as the create sends it. Calendar events coming the other
 * way, from `GET /v1/calendar/events`, are mapped in calendarClient.ts (M5-T6).
 */
function calendarEventToWire(event: MeetingCalendarEvent): MeetingCalendarEventDto {
  return {
    provider: event.provider,
    event_id: event.eventId,
    ical_uid: event.icalUid,
    recurring_event_id: event.recurringEventId,
    scheduled_start: event.scheduledStart,
    scheduled_end: event.scheduledEnd,
    attendees: event.attendees.map(attendeeToWire),
  };
}

function attendeeToWire(attendee: CalendarAttendee): CalendarAttendeeDto {
  return {
    email: attendee.email,
    display_name: attendee.displayName,
    response_status: attendee.responseStatus,
    is_self: attendee.isSelf,
    is_organizer: attendee.isOrganizer,
  };
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
