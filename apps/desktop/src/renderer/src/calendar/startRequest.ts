import { toMeetingCalendarEvent, type TimedCalendarEvent } from '../../../shared/calendar';
import { fitMeetingTitle, isApiBlank, type StartCaptureRequest } from '../../../shared/capture';

/**
 * The request Home's Start notes sends for an event (`startCapture`): started from Home, titled
 * as the invite, linked to the event.
 *
 * Trap: an invite's title has no length limit (a pasted agenda), while the window's start is
 * refused over 500 code points, naming the field, and nothing would start. Only main's own
 * requests are cut for the page, so it is cut here (fitMeetingTitle). A blank title is left out,
 * not sent: main then names the meeting after its start, and the list still says "Untitled
 * meeting" for the invite.
 */
export function startRequestForEvent(event: TimedCalendarEvent): StartCaptureRequest {
  const request: StartCaptureRequest = {
    source: 'home',
    calendarEvent: toMeetingCalendarEvent(event),
  };
  if (!isApiBlank(event.title)) request.title = fitMeetingTitle(event.title);
  return request;
}
