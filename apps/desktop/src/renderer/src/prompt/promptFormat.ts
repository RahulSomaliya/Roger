import { parseInstant, type CallApp } from '../../../shared/calendar';
import { formatClock, meetingHours } from '../../../shared/clock';

/**
 * The words on the prompt panel's cards (M5-T10): pure, so the exact strings are tested.
 */

const MINUTE_MS = 60_000;

/** What the card's overline calls the app: a card over another app's call must name itself. */
const IDENTITY = 'Roger';

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

/**
 * The invite's title; a blank one (Google allows an empty title) is named as its meeting will be,
 * "Meeting at 3:27 pm" (CaptureService `defaultMeetingTitle`), never "Untitled meeting": the card
 * and the note must not call one meeting two things. The time is the invite's start, not the
 * click's, so the card reads the same however long it stays up.
 */
export function eventTitle(event: { title: string; start: string }): string {
  const title = event.title.trim();
  return title === '' ? `Meeting at ${formatClock(parseInstant(event.start))}` : title;
}

/** "Call in Zoom": the call-detected card's headline. An offer to take notes, not a privacy warning. */
export function callDetectedTitle(app: CallApp): string {
  return `Call in ${app.name}`;
}

/**
 * The card's overline: "Roger \u00b7 Starting in 1 min". Roger names itself because the card floats
 * over another app's call and every macOS banner names its app. The wait is Home's `startLabel`;
 * CSS upper-cases it (prompt.css `.prompt-overline`), so the text stays sentence case for
 * a screen reader.
 */
export function overline(startIso: string, nowMs: number): string {
  return `${IDENTITY} \u00b7 ${startLabel(startIso, nowMs)}`;
}

/** A call Roger noticed has no start to count from: "Roger \u00b7 Now". */
export function callOverline(): string {
  return `${IDENTITY} \u00b7 Now`;
}

/**
 * "3:27 pm to 3:57 pm": the one form Home and the meeting page use (`meetingHours`, the shared
 * clock). The panel's old "3:27 \u2013 3:57 pm" dropped the first period and used a dash.
 */
export function hours(startIso: string, endIso: string): string {
  return meetingHours(parseInstant(startIso), parseInstant(endIso));
}

/**
 * The one line under a start while another note records: "Stops notes on Weekly sync". Starting
 * stops that note first (PromptService), and the label stays "Start notes". The title is null
 * while the note is still starting and has no meeting yet.
 */
export function stopsLabel(recordingTitle: string | null): string {
  const title = recordingTitle?.trim() ?? '';
  return title === '' ? 'Stops your current notes' : `Stops notes on ${title}`;
}
