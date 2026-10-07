import { parseInstant, type CalendarAttendee, type CallApp } from '../../../shared/calendar';

/**
 * The words on the prompt panel's cards (M5-T10): pure, so the exact strings are tested. The
 * locale and zone parameters default to the Mac's own and exist for the tests.
 */

const MINUTE_MS = 60_000;

/**
 * "Starting in 1 min", "Starting now", "Started just now" or "Started 3 min ago". The wait rounds
 * UP and the elapsed time rounds DOWN, so neither claims more than the clock does: a call 5 s off
 * is "Starting in 1 min", never "in 0 min".
 */
export function startLabel(startIso: string, nowMs: number): string {
  const diff = parseInstant(startIso) - nowMs;
  if (diff > 0) return `Starting in ${Math.ceil(diff / MINUTE_MS)} min`;
  if (diff === 0) return 'Starting now';
  const elapsed = Math.floor(-diff / MINUTE_MS);
  return elapsed < 1 ? 'Started just now' : `Started ${elapsed} min ago`;
}

/** The invite's title; "Untitled meeting" when it has none (Google allows an empty one). */
export function eventTitle(event: { title: string }): string {
  const title = event.title.trim();
  return title === '' ? 'Untitled meeting' : title;
}

/** "Zoom is using the mic": the call-detected card's headline. */
export function callDetectedTitle(app: CallApp): string {
  return `${app.name} is using the mic`;
}

/** A first name for the card: the display name's first word, else the address before the "@". */
function shortName(attendee: CalendarAttendee): string {
  const first = attendee.displayName?.trim().split(/\s+/)[0];
  if (first !== undefined && first !== '') return first;
  return attendee.email.split('@')[0] ?? attendee.email;
}

/**
 * Who else is on the call, for one line: "Jane, Ali and 3 others", "Jane and Ali", or null when
 * nobody else is listed. The user is never counted. Up to three are named; more are the first two
 * and a count, so 40 attendees stay one short line. When Google left some out
 * (`attendeesOmitted`) the count is a floor: "3+ others", or "and others" when two or fewer are
 * known.
 */
export function attendeeSummary(event: {
  attendees: readonly CalendarAttendee[];
  attendeesOmitted: boolean;
}): string | null {
  const names = event.attendees.filter((each) => !each.isSelf).map(shortName);
  if (event.attendeesOmitted) {
    if (names.length === 0) return 'Others';
    if (names.length <= 2) return `${names.join(', ')} and others`;
    return `${names.slice(0, 2).join(', ')} and ${names.length - 2}+ others`;
  }
  switch (names.length) {
    case 0:
      return null;
    case 1:
      return names[0] ?? null;
    case 2:
      return `${names[0]} and ${names[1]}`;
    case 3:
      return `${names[0]}, ${names[1]} and ${names[2]}`;
    default:
      return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
  }
}

/** "10:00 – 10:30 AM", in the Mac's clock style (12 or 24 hour). */
export function timeRange(
  startIso: string,
  endIso: string,
  locale?: string,
  timeZone?: string,
): string {
  const format = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone });
  // ICU 72+ writes a narrow no-break space before AM/PM and thin spaces around the dash: plain
  // spaces read the same and let a line wrap and a test match.
  return plainSpaces(format.formatRange(parseInstant(startIso), parseInstant(endIso)));
}

/**
 * "Calendar not updated since 9:41 AM" (today) or "… since Tue 9:05 PM" (an earlier day: a stale
 * spell can run to 36 h). `null`: the calendar has never synced.
 */
export function staleLabel(
  lastSuccessAt: string | null,
  nowMs: number,
  locale?: string,
  timeZone?: string,
): string {
  if (lastSuccessAt === null) return 'Calendar has not updated yet';
  const last = parseInstant(lastSuccessAt);
  const day = (ms: number): string =>
    new Intl.DateTimeFormat('en-CA', { dateStyle: 'short', timeZone }).format(ms);
  const time = plainSpaces(
    new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(last),
  );
  if (day(last) === day(nowMs)) return `Calendar not updated since ${time}`;
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone }).format(last);
  return `Calendar not updated since ${weekday} ${time}`;
}

function plainSpaces(text: string): string {
  return text.replace(/[\u202f\u2009\u00a0]/g, ' ');
}
