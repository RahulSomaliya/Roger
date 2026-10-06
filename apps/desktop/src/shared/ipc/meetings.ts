import type {
  GetMeetingRequest,
  ListMeetingsRequest,
  MeetingSummary,
  StoredMeeting,
} from '../meetings';

/**
 * The meetings feature: reads of the meetings stored on this Mac, for the sidebar's recent list and
 * the meeting page (src/renderer/src/meeting/). Main answers them from roger.sqlite and registers
 * them in src/main/meetings/meetings-ipc.ts (M4-S4b), validating each payload with the parsers in
 * src/shared/meetings.ts. Add a member here together with its bridge
 * (src/preload/bridges/meetings.ts) and its preview fake (preview/fakes/meetings.ts): the type
 * check fails until all three agree.
 */
export const meetingsChannels = {
  /** renderer → main, invoke */
  MeetingsList: 'meetings:list',
  MeetingsGet: 'meetings:get',
} as const;

/** The meetings feature's part of `window.roger`. */
export interface MeetingsApi {
  /**
   * The meetings stored on this Mac, newest start first, at most `limit` (main caps a larger one
   * at MAX_MEETINGS_LIST_LIMIT). Main keeps no meeting in which nobody spoke: Stop deletes it.
   */
  listMeetings(request: ListMeetingsRequest): Promise<MeetingSummary[]>;
  /**
   * One meeting with its stored lines, or null when this Mac has no such meeting (never recorded
   * here, or deleted at Stop because nobody spoke). Rejects an id that is not a meeting id.
   */
  getMeeting(request: GetMeetingRequest): Promise<StoredMeeting | null>;
}
