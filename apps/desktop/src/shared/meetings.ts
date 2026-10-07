import { isMeetingId } from './ipc/app';
import type { TranscriptSegment } from './transcript';

/**
 * The meetings stored on this Mac, as the renderer reads them from main (`meetings:list` and
 * `meetings:get`, src/shared/ipc/meetings.ts). Main answers both from its local SQLite store
 * (M4-S4b, src/main/meetings/meetings-ipc.ts), never from the API, so they work offline. Main and
 * the preview fake validate requests with the parsers here, so both refuse the same payloads.
 */

/** A meeting as the sidebar lists it. */
export interface MeetingSummary {
  id: string;
  /** Main names a meeting when it starts ("Meeting 6 Oct 2026 09:30"); M5 brings invite titles. */
  title: string;
  /** ISO 8601 instant, UTC. */
  startedAt: string;
  /** ISO 8601 instant, UTC; null while it records, or when a crash left it open. */
  endedAt: string | null;
}

/** One meeting with the lines main's store holds for it. */
export interface StoredMeeting extends MeetingSummary {
  /**
   * Final lines in transcript order (compareTranscriptOrder), the TranscriptSegment fields only.
   * Lines the echo filter hid are left out, as the uploader leaves them out of Postgres.
   */
  segments: TranscriptSegment[];
}

/** How many meetings the sidebar asks for. */
export const RECENT_MEETINGS_LIMIT = 30;

/** The most meetings one `meetings:list` answers; a larger limit is capped to this, not refused. */
export const MAX_MEETINGS_LIST_LIMIT = 100;

export interface ListMeetingsRequest {
  /** A whole number from 1; the answer holds at most this many, newest first. */
  limit: number;
}

export interface GetMeetingRequest {
  meetingId: string;
}

/**
 * A `meetings:list` payload, its limit capped at MAX_MEETINGS_LIST_LIMIT, or null when it is not
 * one. Builds a fresh object, so nothing else the payload carries reaches main's handler.
 */
export function parseListMeetingsRequest(payload: unknown): ListMeetingsRequest | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { limit } = payload as Record<string, unknown>;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) return null;
  return { limit: Math.min(limit, MAX_MEETINGS_LIST_LIMIT) };
}

/**
 * A `meetings:get` payload, or null. The id must be a meeting id as isMeetingId spells it, the
 * same check the `meeting/<id>` route passes: never a path, never another case of the same id.
 */
export function parseGetMeetingRequest(payload: unknown): GetMeetingRequest | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { meetingId } = payload as Record<string, unknown>;
  return typeof meetingId === 'string' && isMeetingId(meetingId) ? { meetingId } : null;
}

const SOURCE_ORDER = { mic: 0, system: 1 } as const;

/** Transcript order: by start, the mic before call audio at the same start, then by id. */
export function compareTranscriptOrder(a: TranscriptSegment, b: TranscriptSegment): number {
  return (
    a.startMs - b.startMs ||
    SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * The stored lines plus the live lines not among them, in transcript order. A line in both keeps
 * its stored copy: main's store has its latest text (an echo trim rewrites it there). With no new
 * live line it answers `stored` itself, so a page re-rendered on every status sees no change.
 */
export function mergeTranscriptLines(
  stored: readonly TranscriptSegment[],
  live: readonly TranscriptSegment[],
): readonly TranscriptSegment[] {
  const known = new Set(stored.map((segment) => segment.id));
  const added: TranscriptSegment[] = [];
  for (const segment of live) {
    if (known.has(segment.id)) continue;
    known.add(segment.id);
    added.push(segment);
  }
  if (added.length === 0) return stored;
  return [...stored, ...added].sort(compareTranscriptOrder);
}
