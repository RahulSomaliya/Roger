import { meetingsChannels, type MeetingsApi } from '../../shared/ipc/meetings';
import { invoke } from '../bridge';

/** The meetings feature's part of `window.roger`: reads of main's local store. */
export const meetingsBridge: MeetingsApi = {
  listMeetings: (request) => invoke(meetingsChannels.MeetingsList, request),
  getMeeting: (request) => invoke(meetingsChannels.MeetingsGet, request),
};
