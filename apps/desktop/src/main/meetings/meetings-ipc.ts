import { meetingsChannels } from '../../shared/ipc/meetings';
import {
  type MeetingSummary,
  parseGetMeetingRequest,
  parseListMeetingsRequest,
  type StoredMeeting,
} from '../../shared/meetings';
import { handleTrusted, type IpcMainLike, type IpcTrust, type TrustedWindow } from '../ipc/trust';
import { errorMessage, type LogFields, type Logger } from '../logger';
import type { LocalMeeting, TranscriptStore } from '../store/TranscriptStore';

/** The store reads the meetings channels answer from. */
export type MeetingReads = Pick<TranscriptStore, 'listMeetings' | 'getMeeting' | 'listSegments'>;

export interface MeetingsIpcDeps {
  ipcMain: IpcMainLike;
  store: MeetingReads;
  /** The main window, whose page alone may read meetings; null while it is closed. */
  getWindow: () => TrustedWindow | null;
  logger: Logger;
}

/**
 * Wires the meetings channels (src/shared/ipc/meetings.ts) to main's local store, roger.sqlite,
 * for the main window's page only (ipc/trust.ts). Never to the API: Home's Earlier list and the meeting
 * page work offline, and show a meeting before it uploads. Each payload goes through the parsers
 * in src/shared/meetings.ts, which the preview fake (preview/fakes/meetings.ts) uses too, so
 * both refuse the same payloads and cap the same limit.
 *
 * Log lines carry the channel and the meeting id, never a payload, a title or a line: titles
 * become calendar invite titles with M5, and lines are what people said. A store failure is
 * logged with its message: the store words its own errors, quoting only CHECK-bound columns,
 * never a segment's free text (its rowToSegment and parseWords).
 */
export function registerMeetingsIpc({ ipcMain, store, getWindow, logger }: MeetingsIpcDeps): void {
  const trust: IpcTrust = { ipcMain, getWindow, logger };

  /** Runs one read; a failure is logged and rejects the page's invoke with the store's error. */
  const read = <T>(channel: string, fields: LogFields, run: () => T): T => {
    try {
      return run();
    } catch (error) {
      logger.warn('meetings read failed', { channel, ...fields, error: errorMessage(error) });
      throw error;
    }
  };

  const refuse = (channel: string, shape: string): Error => {
    logger.warn('meetings read refused', { channel });
    return new Error(`${channel} takes ${shape}`);
  };

  handleTrusted(trust, meetingsChannels.MeetingsList, (payload): MeetingSummary[] => {
    const channel = meetingsChannels.MeetingsList;
    const request = parseListMeetingsRequest(payload);
    if (request === null) throw refuse(channel, '{ limit: a whole number from 1 }');
    return read(channel, {}, () => store.listMeetings(request.limit).map(toSummary));
  });

  handleTrusted(trust, meetingsChannels.MeetingsGet, (payload): StoredMeeting | null => {
    const channel = meetingsChannels.MeetingsGet;
    const request = parseGetMeetingRequest(payload);
    if (request === null) throw refuse(channel, '{ meetingId: a lowercase meeting id }');
    const { meetingId } = request;
    return read(channel, { meetingId }, () => {
      const meeting = store.getMeeting(meetingId);
      // Null, not an error: the page says this Mac has no such meeting (never recorded here, or
      // deleted at Stop because nobody spoke).
      if (meeting === null) return null;
      return {
        ...toSummary(meeting),
        segments: store.listSegments(meetingId),
        // Address and "is the user" only: names and answers stay in main.
        attendees: (meeting.calendarEvent?.attendees ?? []).map(({ email, isSelf }) => ({
          email,
          isSelf,
        })),
      };
    });
  });
}

/** A fresh summary: the upload state (`remoteState`) is main's business, never the page's. */
function toSummary({ id, title, startedAt, endedAt }: LocalMeeting): MeetingSummary {
  return { id, title, startedAt, endedAt };
}
