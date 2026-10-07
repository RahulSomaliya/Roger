import { parseInstant, type CallApp } from '../../../shared/calendar';
import { formatClock } from '../clock';

/**
 * The words on the prompt panel's cards (M5-T10): pure, so the exact strings are tested.
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

/** "Zoom is using the microphone": the call-detected card's headline. */
export function callDetectedTitle(app: CallApp): string {
  return `${app.name} is using the microphone`;
}

/**
 * "10:00 - 10:30 am", or "11:30 am - 12:30 pm" across noon, with an en dash: the shared `formatClock`
 * (12-hour, lowercase, whatever the Mac's own setting says), with the first end's am or pm
 * dropped when both ends share it.
 */
export function timeRange(startIso: string, endIso: string): string {
  const start = formatClock(parseInstant(startIso));
  const end = formatClock(parseInstant(endIso));
  const period = end.slice(end.lastIndexOf(' '));
  const lead = start.endsWith(period) ? start.slice(0, -period.length) : start;
  return `${lead} \u2013 ${end}`;
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
