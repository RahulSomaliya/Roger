import {
  parseInstant,
  promptKey,
  type CalendarEvent,
  type TimedCalendarEvent,
} from '../../shared/calendar';
import type { ReminderLeadMinutes } from '../../shared/calendarPrefs';

/**
 * Which calendar events get a prompt, and when. Pure: the reminder scheduler, the prompt service
 * and the start-request enricher all decide through these functions, so the rules live in one
 * place and are tuned here from the `prompts` log (`missed` rows with reason `policy`).
 *
 * Every time is an instant (epoch ms). Never compute with local dates here: main may keep the time
 * zone it started in while the Mac travels, and a local "01:30" happens twice on a fall-back night.
 * "Today" is the renderer's question, not main's.
 */

const MINUTE_MS = 60_000;

/** A prompt stays up until start + 10 min (or an action, or Dismiss): "Started 4 min ago" still helps. */
export const PROMPT_OPEN_AFTER_START_MS = 10 * MINUTE_MS;

/** A manual start or a detected call links an event that is running or starts within 5 min. */
export const LINK_BEFORE_START_MS = 5 * MINUTE_MS;

/** Calls whose starts are less than this apart share one card. */
export const SHARED_CARD_WITHIN_MS = MINUTE_MS;

/** The rule that kept an event from prompting. */
export type PolicyRule = 'all_day' | 'declined' | 'no_call_evidence';

export type PromptWorthiness =
  { worthy: true; event: TimedCalendarEvent } | { worthy: false; rule: PolicyRule };

/**
 * A call gets a prompt; a block of time does not. Timed, not declined (tentative and unanswered
 * still prompt), and evidence of a call: another attendee, attendees Google left out, or a video
 * link someone typed into the location or description. A `conference` link alone is not evidence:
 * many Workspace orgs add a Meet link to every new event, so it would prompt for Focus and Lunch.
 * Cancelled events never reach the desktop, and `eventTypes=default` already dropped focus time,
 * out of office and working location.
 */
export function promptWorthiness(event: CalendarEvent): PromptWorthiness {
  if (event.allDay) return { worthy: false, rule: 'all_day' };
  if (event.selfResponse === 'declined') return { worthy: false, rule: 'declined' };
  const typedLink =
    event.videoLink !== null &&
    (event.videoLinkSource === 'location' || event.videoLinkSource === 'description');
  const someoneElse = event.attendees.some((attendee) => !attendee.isSelf);
  if (!someoneElse && !event.attendeesOmitted && !typedLink) {
    return { worthy: false, rule: 'no_call_evidence' };
  }
  return { worthy: true, event };
}

export function isPromptWorthy(event: CalendarEvent): event is TimedCalendarEvent {
  return promptWorthiness(event).worthy;
}

export interface DueWindow {
  /** Start − lead. */
  fromMs: number;
  /** Start + 10 min, exclusive. */
  untilMs: number;
}

export function dueWindow(event: TimedCalendarEvent, leadMinutes: ReminderLeadMinutes): DueWindow {
  const startMs = parseInstant(event.start);
  return {
    fromMs: startMs - leadMinutes * MINUTE_MS,
    untilMs: startMs + PROMPT_OPEN_AFTER_START_MS,
  };
}

export function isDue(
  event: TimedCalendarEvent,
  nowMs: number,
  leadMinutes: ReminderLeadMinutes,
): boolean {
  const { fromMs, untilMs } = dueWindow(event, leadMinutes);
  return fromMs <= nowMs && nowMs < untilMs;
}

/**
 * The prompt-worthy events to offer now, earliest first. `loggedKeys` holds every key with a
 * `prompts` row, whatever its outcome: a key is offered once, so a restart, a Dismiss or a start
 * never brings the same prompt back. A moved instance has a new key and is offered again.
 */
export function dueEvents(
  events: readonly CalendarEvent[],
  nowMs: number,
  leadMinutes: ReminderLeadMinutes,
  loggedKeys: ReadonlySet<string>,
): TimedCalendarEvent[] {
  return events
    .filter(isPromptWorthy)
    .filter((event) => isDue(event, nowMs, leadMinutes) && !loggedKeys.has(promptKey(event)))
    .sort((a, b) => parseInstant(a.start) - parseInstant(b.start));
}

/**
 * Whether `candidate` joins the card that `anchor` (the card's earliest event) heads: two calls
 * starting within a minute of each other are one decision for the user, not two panels.
 */
export function sharesCard(anchor: TimedCalendarEvent, candidate: TimedCalendarEvent): boolean {
  return (
    Math.abs(parseInstant(candidate.start) - parseInstant(anchor.start)) < SHARED_CARD_WITHIN_MS
  );
}

/**
 * The one prompt-worthy event that is running or starts within 5 min, or null when there are
 * none or several. A start with no prompt (Home, the menu bar, a detected call) links to it; two
 * overlapping calls link nothing rather than the wrong one.
 */
export function oneClearMatch(
  events: readonly CalendarEvent[],
  nowMs: number,
): TimedCalendarEvent | null {
  const matches = events.filter(isPromptWorthy).filter((event) => {
    const startMs = parseInstant(event.start);
    const running = startMs <= nowMs && nowMs < parseInstant(event.end);
    const imminent = nowMs < startMs && startMs <= nowMs + LINK_BEFORE_START_MS;
    return running || imminent;
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** Why a prompt-worthy call got no prompt; `prompts.reason` on a `missed` row. */
export type MissedReason = 'disconnected' | 'not_running' | 'api_stale' | 'policy';

export interface MissedReasonInput {
  event: TimedCalendarEvent;
  leadMinutes: ReminderLeadMinutes;
  /** The account's `connections_log` rows; `disconnectedAtMs` is null while connected. */
  connections: readonly { connectedAtMs: number; disconnectedAtMs: number | null }[];
  /** Roger's `runs` rows: each run's start and its last heartbeat tick. */
  runs: readonly { startedAtMs: number; lastTickAtMs: number }[];
  /**
   * When this key first reached the `events` cache, or null when it never did: it came only from
   * the catch-up fetch at launch, which feeds the missed log and not the cache.
   */
  firstSeenAtMs: number | null;
}

/**
 * The first reason that explains a missed prompt, judged at the moment it was due (start − lead):
 * no connection then, no Roger run covering it, the event not yet in the local copy, or else the
 * policy (Roger ran with the event cached and showed nothing). For `policy`, the scheduler writes
 * the `PolicyRule` it last saw for the key into `detail`.
 */
export function missedReason(input: MissedReasonInput): MissedReason {
  const dueAtMs = dueWindow(input.event, input.leadMinutes).fromMs;
  const connected = input.connections.some(
    ({ connectedAtMs, disconnectedAtMs }) =>
      connectedAtMs <= dueAtMs && (disconnectedAtMs === null || dueAtMs < disconnectedAtMs),
  );
  if (!connected) return 'disconnected';
  // A run whose last tick came before the due moment died (or quit) before it could show anything.
  const running = input.runs.some(
    ({ startedAtMs, lastTickAtMs }) => startedAtMs <= dueAtMs && dueAtMs <= lastTickAtMs,
  );
  if (!running) return 'not_running';
  if (input.firstSeenAtMs === null || input.firstSeenAtMs > dueAtMs) return 'api_stale';
  return 'policy';
}
