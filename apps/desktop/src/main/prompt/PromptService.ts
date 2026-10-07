import {
  parseInstant,
  promptKey,
  toMeetingCalendarEvent,
  type CalendarPromptCard,
  type CalendarSyncState,
  type CallApp,
  type CallDetectedPromptCard,
  type PromptCard,
  type PromptCardPhase,
  type PromptOffer,
  type PromptShownBy,
  type TimedCalendarEvent,
} from '../../shared/calendar';
import type { CapturePhase, CaptureStatus, StartCaptureRequest } from '../../shared/capture';
import type { PromptActionRequest, PromptPanelState } from '../../shared/ipc/prompt';
import { parseJoinLink } from '../../shared/meetingLinks';
import { AUDIO_SOURCES, type AudioSource } from '../../shared/transcript';
import type { CalendarSync } from '../calendar/CalendarSync';
import type { ConsentNotice } from '../calendar/consentNotice';
import { NO_ACCOUNT, type PromptLog, type PromptOutcome } from '../calendar/PromptLog';
import type { PromptOfferPort } from '../calendar/ReminderScheduler';
import { oneClearMatch, PROMPT_OPEN_AFTER_START_MS, sharesCard } from '../calendar/reminderPolicy';
import type { SqliteCalendarCache } from '../calendar/SqliteCalendarCache';
import { errorMessage, type Logger } from '../logger';
import type { Navigation } from '../navigation';
import { Emitter } from '../util/emitter';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;

/**
 * A start is judged this long after its request reaches capture: both sources delivering audio
 * and both speech streams open is `started` (or `joined_and_started`), anything less
 * `started_degraded` or `start_failed` (M5 design, "Prompt log"). Counted from the request, not
 * the click: stopping the note being recorded first may drain uploads for up to 15 s.
 */
export const START_OUTCOME_WINDOW_MS = 20 * SECOND_MS;

/** "Taking notes · Open Roger" stays on the card this long after a start action, then it goes. */
export const TAKING_NOTES_SHOWN_MS = 5 * SECOND_MS;

/**
 * D5 rule 2: a calendar card answered this recently (any action, Dismiss included) keeps a detected
 * call from putting up a card of its own while that card's call is still running or about to.
 */
export const CALL_OFFER_QUIET_AFTER_ACTION_MS = 15 * MINUTE_MS;

/**
 * A call-detected card stays up this long unless answered. No event bounds it, so it gets the
 * calendar card's 10 minutes; a calendar card a detected call put up for a call already running
 * gets the same from the moment it shows (`closesAtMs`).
 */
export const CALL_CARD_OPEN_MS = PROMPT_OPEN_AFTER_START_MS;

/**
 * Deadlines are re-read on the wall clock at least this often. Node timers stop while the Mac
 * sleeps and resume with their remaining wait (apps/desktop/CLAUDE.md), so a card due to expire
 * during a sleep would otherwise stay up after the wake, "Started 55 min ago", for its whole wait.
 */
const DEADLINE_CHECK_MS = 10 * SECOND_MS;

/** What the card says when a click starts nothing because no window took the request. */
const NOT_TAKEN_MESSAGE = "Roger's window did not start the note. Open Roger and press Start.";
const NO_JOIN_LINK_MESSAGE = 'This meeting has no Meet, Zoom or Teams link Roger can open.';
const BUSY_MESSAGE = 'Roger is still starting the last note. Try again in a moment.';

/**
 * Capture as the prompt reads and drives it: CaptureService fits as it is (PromptService.test.ts
 * checks it with the type checker), so index.ts passes it without an adapter.
 */
export interface PromptCapture {
  readonly phase: CapturePhase;
  getStatus(): CaptureStatus;
  on(event: 'status', listener: (status: CaptureStatus) => void): () => void;
  stop(): Promise<CaptureStatus>;
  requestStart(request: StartCaptureRequest): void;
  takePendingStart(): StartCaptureRequest | null;
}

/** The main window, as far as `revealWithoutFocus` touches it. Electron's BrowserWindow fits. */
export interface RevealableWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  showInactive(): void;
}

/**
 * The `revealWindow` port for the main window: orders a hidden window in with `showInactive()`,
 * and does nothing to a window that is visible or minimized.
 *
 * Trap: never `show()` or `focus()` here, nor anywhere a prompt action leads. Either activates
 * Roger: over a full-screen Meet macOS switches Spaces away from the call, and after Join the
 * window covers the tab that just opened, undoing the panel's `focusable: false` (M5 design, "One
 * click starts the note"). Whether even `showInactive()` pulls the Space away is real-Mac check 3;
 * if it does, pass a port that leaves the window hidden: the panel's "Taking notes · Open Roger"
 * is then the way in.
 */
export function revealWithoutFocus(getWindow: () => RevealableWindow | null): () => void {
  return () => {
    const window = getWindow();
    if (window === null || window.isDestroyed() || window.isVisible() || window.isMinimized()) {
      return;
    }
    window.showInactive();
  };
}

export interface PromptServiceOptions {
  cache: Pick<SqliteCalendarCache, 'activeConnection' | 'listEvents'>;
  sync: Pick<CalendarSync, 'getState' | 'onStateChange'>;
  log: Pick<PromptLog, 'recordShown' | 'recordCallDetected' | 'recordAction'>;
  capture: PromptCapture;
  /** `app:navigate`, the const of `[slot M4-S1]`: the started note's page opens in the window. */
  navigation: Pick<Navigation, 'navigate'>;
  /** Called by every start action: `revealWithoutFocus(() => window)`. */
  revealWindow: () => void;
  /**
   * Show and focus the main window: Open Roger only, the one action the user takes to leave the
   * call for Roger. index.ts passes what the app menu's `open` does.
   */
  openWindow: () => void;
  /** `shell.openExternal`, for Join. Only links `parseJoinLink` accepts reach it. */
  openExternal: (url: string) => Promise<void>;
  notice: ConsentNotice;
  logger: Logger;
  /** Epoch ms. */
  clock?: () => number;
}

/** One event on a calendar card. */
interface CardEvent {
  event: TimedCalendarEvent;
  key: string;
  /** When the card stops offering it (logged `expired`). */
  closesAtMs: number;
}

interface CardBase {
  id: string;
  phase: PromptCardPhase;
  error: string | null;
  /** Set while `phase` is `taking_notes`. */
  takingNotesUntilMs: number | null;
}

interface CalendarCardState extends CardBase {
  kind: 'calendar';
  accountEmail: string;
  shownBy: PromptShownBy;
  /** Earliest first. */
  events: CardEvent[];
  /** The event a start action is under way for: its row is not open, so it never expires here. */
  startingKey: string | null;
}

interface CallCardState extends CardBase {
  kind: 'call_detected';
  /** `NO_ACCOUNT` when no calendar was connected. */
  accountEmail: string;
  key: string;
  app: CallApp;
  closesAtMs: number;
}

interface StaleCardState {
  kind: 'stale_calendar';
  id: string;
  lastSuccessAt: string | null;
}

type CardState = CalendarCardState | CallCardState | StaleCardState;
type StartableCard = CalendarCardState | CallCardState;

/** A start action, from the click until its outcome is logged. */
interface StartAttempt {
  card: StartableCard;
  accountEmail: string;
  key: string;
  /** Join opened the video link. */
  joined: boolean;
  /** The request reached capture (after the note being recorded stopped). */
  requested: boolean;
  /** When the outcome is judged; null until requested. */
  decideAtMs: number | null;
  /** A status after the request showed a start under way. */
  begun: boolean;
  /** The recording this start made, from its first `recording` status. */
  meetingId: string | null;
  lastRecording: CaptureStatus | null;
}

interface PromptServiceEvents extends Record<string, unknown> {
  change: PromptPanelState;
  'call-card-dismissed': CallApp;
}

/**
 * The one prompt panel's brain (M5 D5): every source offers it a prompt (`offer`), it decides the
 * cards, logs them in `calendar.sqlite` → `prompts` (PromptLog), runs the panel's clicks (`act`)
 * and logs how each start ended. M5-T10's window renders `getState()`; promptIpc.ts carries it.
 *
 * - Calendar offers come from ReminderScheduler at start − lead. Calls starting within a minute of
 *   each other share a card (`sharesCard`). A card expires at its call's start + 10 min.
 * - Detected calls (M2-T17b) go through the D5 rules (`offerCallDetected`).
 * - A start action logs `starting`, stops a note being recorded, then asks the window to start
 *   (`CaptureService.requestStart`: capture runs in the renderer). The outcome is read from the
 *   capture statuses that follow: `started` once both sources deliver and both streams are open,
 *   within START_OUTCOME_WINDOW_MS; else `started_degraded` naming the source, or `start_failed`
 *   (the card comes back with the error, to try again).
 * - "Calendar not updated since …": one card per stale spell of the local copy.
 *
 * Log lines name keys, bundle ids and codes, never a title, an attendee or the notice text.
 */
export class PromptService implements PromptOfferPort {
  private readonly clock: () => number;
  private readonly events = new Emitter<PromptServiceEvents>();
  private cards: CardState[] = [];
  private nextCardId = 1;
  private attempt: StartAttempt | null = null;
  /** What the panel was last told about `recording`, to send a change only when it flips. */
  private recordingShown = false;
  /** The stale spell (its `staleSince`) a card was shown for; a spell gets one card. */
  private staleSpellCarded: string | null = null;
  /** Calendar cards answered lately, with their events: D5 rule 2. */
  private recentAnswers: { atMs: number; events: TimedCalendarEvent[] }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stops: (() => void)[] = [];
  private running = false;

  constructor(private readonly options: PromptServiceOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Follows capture, the calendar copy's health and the notice setting. Call once, at launch. */
  start(): void {
    if (this.running) throw new Error('the prompt service is already running');
    this.running = true;
    const { capture, sync, notice } = this.options;
    this.recordingShown = isRecording(capture.phase);
    this.stops = [
      capture.on('status', (status) => {
        this.onCaptureStatus(status);
      }),
      sync.onStateChange((state) => {
        this.onSyncState(state);
      }),
      notice.onEnabledChange(() => {
        this.changed();
      }),
    ];
    this.onSyncState(sync.getState());
  }

  /**
   * At quit. Cards still up and a start still settling are left as they are: the next launch logs
   * them `expired` and `start_failed` with reason `app_exit` (PromptLog.settleAfterExit).
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const stop of this.stops) stop();
    this.stops = [];
    this.clearTimer();
  }

  getState(): PromptPanelState {
    return {
      cards: this.cards.flatMap((card) => {
        const shown = toPromptCard(card);
        return shown === null ? [] : [shown];
      }),
      recording: isRecording(this.options.capture.phase),
      noticeEnabled: this.options.notice.enabled(),
    };
  }

  /** Called with the new state after every change. Returns the removal. */
  onChange(listener: (state: PromptPanelState) => void): () => void {
    return this.events.on('change', listener);
  }

  /**
   * The user dismissed a call-detected card: M2-T17b's CallOffer starts its 10-minute cooldown for
   * that app from here (M2 plan, "Offer and auto-stop"). Returns the removal.
   */
  onCallCardDismissed(listener: (app: CallApp) => void): () => void {
    return this.events.on('call-card-dismissed', listener);
  }

  /**
   * A prompt to show (PromptOfferPort). Never throws: a failure is logged and the offer dropped.
   * The scheduler then offers the call no more in this run, and its window closes with no row, so
   * the sweep logs it `missed`: the honest outcome of a prompt that never showed.
   */
  offer(offer: PromptOffer): void {
    try {
      if (offer.source === 'calendar') this.offerCalendar(offer.eventKey);
      else this.offerCallDetected(offer.app);
    } catch (error) {
      this.options.logger.error('prompt offer failed', {
        source: offer.source,
        ...(offer.source === 'calendar'
          ? { key: offer.eventKey }
          : { bundleId: offer.app.bundleId }),
        error: errorMessage(error),
      });
    }
  }

  /**
   * Runs a click from the panel. Resolves once the action is done or, for a start, once capture
   * has the request; the outcome follows in the state. An action on a card that is gone (it
   * expired as the user clicked) is logged and ignored.
   */
  async act(request: PromptActionRequest): Promise<void> {
    const card = this.cards.find((candidate) => candidate.id === request.cardId);
    if (card === undefined) {
      this.options.logger.info('prompt action on a card that is gone', {
        action: request.action,
      });
      return;
    }
    switch (request.action) {
      case 'dismiss':
        this.dismiss(card);
        return;
      case 'copy_notice':
        this.copyNotice(card);
        return;
      case 'open_roger':
        this.openRoger(card);
        return;
      case 'take_notes':
        await this.startFrom(card, request.eventId ?? null, false);
        return;
      case 'join_and_take_notes':
        await this.startFrom(card, request.eventId, true);
        return;
    }
  }

  // Offers ---------------------------------------------------------------------------------------

  private offerCalendar(eventKey: string): void {
    const account = this.options.cache.activeConnection()?.accountEmail ?? null;
    if (account === null) {
      this.options.logger.warn('calendar prompt not shown: no calendar is connected', {
        key: eventKey,
      });
      return;
    }
    const event = this.findEvent(eventKey);
    if (event === null) {
      this.options.logger.warn('calendar prompt not shown: the event is not in the copy', {
        key: eventKey,
      });
      return;
    }
    this.showCalendarCard(account, event, 'calendar');
  }

  /**
   * The D5 rules, in order (M5 design, "Prompt feed shared with M2"). M2's own 10-minute cooldown
   * after a dismiss runs before this, in its CallOffer (`onCallCardDismissed`).
   */
  private offerCallDetected(app: CallApp): void {
    const nowMs = this.clock();
    // 1. A note is starting or recording: the call is being taken already.
    if (isRecording(this.options.capture.phase) || this.attempt !== null) {
      this.options.logger.info('call offer dropped: a note is starting or recording', {
        bundleId: app.bundleId,
      });
      return;
    }
    // 2. The calendar already asked about this call.
    if (this.calendarAskedAboutNow(nowMs)) {
      this.options.logger.info('call offer dropped: a calendar prompt covers this call', {
        bundleId: app.bundleId,
      });
      return;
    }
    // 3. Exactly one call running or about to start: its own card, so a click is a
    // `notification` start that counts for the streak. Not when it has a row already (missed,
    // answered long ago): a prompt is logged, and shown, once.
    const account = this.options.cache.activeConnection()?.accountEmail ?? null;
    if (account !== null) {
      const match = oneClearMatch(this.options.cache.listEvents(), nowMs);
      if (match !== null && this.showCalendarCard(account, match, 'call_detected')) return;
    }
    // 4. A call-detected card. Its start links an event only through M5-T9c's enricher.
    const key = this.options.log.recordCallDetected({
      accountEmail: account,
      app,
      at: new Date(nowMs).toISOString(),
    });
    this.cards.push({
      kind: 'call_detected',
      id: this.newCardId(),
      accountEmail: account ?? NO_ACCOUNT,
      key,
      app,
      closesAtMs: nowMs + CALL_CARD_OPEN_MS,
      phase: 'open',
      error: null,
      takingNotesUntilMs: null,
    });
    this.options.logger.info('call prompt shown', { key });
    this.changed();
  }

  /**
   * D5 rule 2: a calendar card up, or answered in the last 15 min, for a call that is running or
   * starts within 5 min (`oneClearMatch` over that one event: the manual-start rule).
   */
  private calendarAskedAboutNow(nowMs: number): boolean {
    this.forgetOldAnswers(nowMs);
    const attachable = (event: TimedCalendarEvent): boolean =>
      oneClearMatch([event], nowMs) !== null;
    return (
      this.cards.some(
        (card) => card.kind === 'calendar' && card.events.some(({ event }) => attachable(event)),
      ) || this.recentAnswers.some((answer) => answer.events.some(attachable))
    );
  }

  /**
   * Logs the event shown and puts it on a card. Returns false, showing nothing, when the key has a
   * row already. A calendar card that comes up replaces any call-detected card (D5).
   */
  private showCalendarCard(
    accountEmail: string,
    event: TimedCalendarEvent,
    shownBy: PromptShownBy,
  ): boolean {
    const nowMs = this.clock();
    const key = promptKey(event);
    if (!this.options.log.recordShown({ accountEmail, event, shownBy, at: iso(nowMs) })) {
      this.options.logger.info('calendar prompt logged already; not shown again', { key });
      return false;
    }
    this.replaceCallCards(nowMs);
    const startMs = parseInstant(event.start);
    const closesAtMs =
      shownBy === 'calendar'
        ? startMs + PROMPT_OPEN_AFTER_START_MS
        : Math.max(startMs + PROMPT_OPEN_AFTER_START_MS, nowMs + CALL_CARD_OPEN_MS);
    const entry: CardEvent = { event, key, closesAtMs };
    const shared = this.cards.find(
      (card): card is CalendarCardState =>
        card.kind === 'calendar' &&
        card.phase === 'open' &&
        card.accountEmail === accountEmail &&
        card.events[0] !== undefined &&
        sharesCard(card.events[0].event, event),
    );
    if (shared === undefined) {
      this.cards.push({
        kind: 'calendar',
        id: this.newCardId(),
        accountEmail,
        shownBy,
        events: [entry],
        startingKey: null,
        phase: 'open',
        error: null,
        takingNotesUntilMs: null,
      });
    } else {
      shared.events = [...shared.events, entry].sort(
        (a, b) => parseInstant(a.event.start) - parseInstant(b.event.start),
      );
    }
    this.options.logger.info('calendar prompt shown', {
      key,
      shownBy,
      shared: shared !== undefined,
    });
    this.changed();
    return true;
  }

  /** A call-detected card still open gives way to a calendar card: one panel, one question. */
  private replaceCallCards(nowMs: number): void {
    for (const card of this.cards) {
      if (card.kind !== 'call_detected' || card.phase !== 'open') continue;
      this.record(card.accountEmail, card.key, 'expired', nowMs, {
        reason: 'replaced_by_calendar',
      });
      this.removeCard(card);
    }
  }

  private findEvent(eventKey: string): TimedCalendarEvent | null {
    for (const event of this.options.cache.listEvents()) {
      if (!event.allDay && promptKey(event) === eventKey) return event;
    }
    return null;
  }

  // Actions --------------------------------------------------------------------------------------

  private dismiss(card: CardState): void {
    const nowMs = this.clock();
    if (card.kind === 'stale_calendar') {
      this.removeCard(card);
      this.changed();
      return;
    }
    if (card.phase !== 'open') {
      this.options.logger.info('dismiss ignored: the card is taking notes');
      return;
    }
    if (card.kind === 'calendar') {
      for (const { key } of card.events) this.record(card.accountEmail, key, 'dismissed', nowMs);
      this.noteAnswered(card, nowMs);
    } else {
      this.record(card.accountEmail, card.key, 'dismissed', nowMs);
      this.events.emit('call-card-dismissed', card.app);
    }
    this.removeCard(card);
    this.changed();
  }

  private copyNotice(card: CardState): void {
    if (card.kind === 'stale_calendar') return;
    if (!this.options.notice.copy()) {
      // The panel hides Copy notice while the notice is off; a click can still race the setting.
      this.options.logger.info('copy notice ignored: the notice is off');
      return;
    }
    if (card.kind === 'calendar') this.noteAnswered(card, this.clock());
  }

  /** "Taking notes · Open Roger": the user leaves the call for Roger, so activating is right. */
  private openRoger(card: CardState): void {
    if (card.kind === 'stale_calendar' || card.phase !== 'taking_notes') {
      this.options.logger.info('open Roger ignored: the card is not taking notes');
      return;
    }
    this.options.openWindow();
    this.endTakingNotes(card, this.clock());
    this.changed();
  }

  private async startFrom(card: CardState, eventId: string | null, join: boolean): Promise<void> {
    if (card.kind === 'stale_calendar' || card.phase !== 'open') {
      this.options.logger.info('start ignored: the card cannot start a note now');
      return;
    }
    if (this.attempt !== null) {
      this.showError(card, BUSY_MESSAGE);
      return;
    }
    const target = this.startTarget(card, eventId, join);
    if (target === null) return;

    const nowMs = this.clock();
    // `starting` first: the row then holds the click's time, whatever the stop below costs.
    if (!this.record(card.accountEmail, target.key, 'starting', nowMs)) {
      this.showError(card, 'Roger could not start a note from this prompt.');
      return;
    }
    const attempt: StartAttempt = {
      card,
      accountEmail: card.accountEmail,
      key: target.key,
      joined: false,
      requested: false,
      decideAtMs: null,
      begun: false,
      meetingId: null,
      lastRecording: null,
    };
    this.attempt = attempt;
    if (card.kind === 'calendar') {
      card.startingKey = target.key;
      this.noteAnswered(card, nowMs);
    }
    card.phase = 'taking_notes';
    card.error = null;
    card.takingNotesUntilMs = nowMs + TAKING_NOTES_SHOWN_MS;
    this.changed();
    this.options.logger.info('prompt start', { key: target.key, join });

    this.options.revealWindow();
    if (target.joinUrl !== null) {
      try {
        await this.options.openExternal(target.joinUrl);
        attempt.joined = true;
      } catch (error) {
        // The note still starts: the user may join another way, and the outcome says `started`.
        this.options.logger.warn('join link could not be opened', {
          key: target.key,
          error: errorMessage(error),
        });
      }
    }
    const { capture } = this.options;
    try {
      // Trap: stop first, then request. A request that meets a recording joins it: the answer is
      // that note's status with no error, and this card's title and event go only to a warning in
      // the log (CaptureService.requestStart).
      if (capture.phase !== 'idle') await capture.stop();
    } catch (error) {
      this.settleFailed(attempt, 'stop_failed', errorMessage(error));
      return;
    }
    if (this.attempt !== attempt) return;
    try {
      capture.requestStart(target.request);
    } catch (error) {
      // requestStart names the field it refused, never its value: safe for the log and the card.
      this.settleFailed(attempt, 'request_refused', errorMessage(error));
      return;
    }
    attempt.requested = true;
    attempt.decideAtMs = this.clock() + START_OUTCOME_WINDOW_MS;
    this.schedule();
  }

  /**
   * What a start from `card` asks for, or null when it cannot: logged, and on the card when the
   * user can act on it (a Join with no link they can use).
   */
  private startTarget(
    card: StartableCard,
    eventId: string | null,
    join: boolean,
  ): { key: string; request: StartCaptureRequest; joinUrl: string | null } | null {
    if (card.kind === 'call_detected') {
      if (join) {
        this.options.logger.warn('join refused: a call-detected card has no meeting link');
        return null;
      }
      return { key: card.key, request: { source: 'call_detected' }, joinUrl: null };
    }
    const entry =
      eventId === null
        ? card.events.length === 1
          ? card.events[0]
          : undefined
        : card.events.find(({ event }) => event.id === eventId);
    if (entry === undefined) {
      this.options.logger.warn('start refused: the card holds no such event', {
        events: card.events.length,
      });
      return null;
    }
    let joinUrl: string | null = null;
    if (join) {
      // Checked again here, whatever the API vetted: only an allowlisted link is ever opened.
      const link = entry.event.videoLink === null ? null : parseJoinLink(entry.event.videoLink);
      if (link === null) {
        this.options.logger.warn('join refused: no allowlisted video link', { key: entry.key });
        this.showError(card, NO_JOIN_LINK_MESSAGE);
        return null;
      }
      joinUrl = link.url;
    }
    return {
      key: entry.key,
      // The event's title as it is: requestStart cuts it to fit (fitMeetingTitle).
      request: {
        source: 'notification',
        title: entry.event.title,
        calendarEvent: toMeetingCalendarEvent(entry.event),
      },
      joinUrl,
    };
  }

  // Start outcomes ---------------------------------------------------------------------------------

  private onCaptureStatus(status: CaptureStatus): void {
    const attempt = this.attempt;
    if (attempt?.requested === true) {
      try {
        this.judge(attempt, status);
      } catch (error) {
        this.options.logger.error('prompt start outcome could not be read', {
          key: attempt.key,
          error: errorMessage(error),
        });
      }
    }
    const recording = isRecording(status.phase);
    if (recording !== this.recordingShown) {
      this.recordingShown = recording;
      this.changed();
    }
  }

  /** Settles the attempt when `status` decides it; otherwise waits for the next or the deadline. */
  private judge(attempt: StartAttempt, status: CaptureStatus): void {
    if (status.phase === 'starting') attempt.begun = true;
    if (status.phase === 'recording' && status.meetingId !== null) {
      attempt.begun = true;
      if (attempt.meetingId === null) {
        attempt.meetingId = status.meetingId;
        this.openMeeting(status.meetingId);
      }
      if (status.meetingId === attempt.meetingId) {
        attempt.lastRecording = status;
        if (AUDIO_SOURCES.every((source) => sourceProblems(status, source).length === 0)) {
          this.settle(attempt, attempt.joined ? 'joined_and_started' : 'started', {
            meetingId: status.meetingId,
          });
        }
        return;
      }
    }
    if (
      attempt.lastRecording !== null &&
      (status.phase === 'stopping' || status.phase === 'idle')
    ) {
      // Stopped before both sources were live (the user pressed Stop within the window).
      this.settleDegraded(attempt, attempt.lastRecording);
      return;
    }
    if (attempt.begun && status.phase === 'idle' && status.error !== null) {
      // A refusal: the microphone, the open budget, the vendor. Its text is for people.
      this.settleFailed(attempt, 'capture_failed', status.error);
    }
  }

  /** START_OUTCOME_WINDOW_MS after the request: whatever the start has reached decides it. */
  private decide(attempt: StartAttempt): void {
    const { capture } = this.options;
    const status = capture.getStatus();
    this.judge(attempt, status);
    if (this.attempt !== attempt) return;
    if (attempt.lastRecording !== null) {
      this.settleDegraded(attempt, attempt.lastRecording);
      return;
    }
    if (status.phase === 'starting') {
      // Still starting (a vendor slow to open): too slow to count. The window shows how the start
      // ends, so the card does not come back with a button that would stop it.
      this.settleFailed(attempt, 'not_started_in_time', 'still starting after 20 s', {
        showCard: false,
      });
      return;
    }
    // Nothing began. Withdrawn, a request no window took cannot start a note later, unasked.
    if (capture.takePendingStart() !== null) {
      this.settleFailed(attempt, 'not_taken', NOT_TAKEN_MESSAGE);
      return;
    }
    // Taken, but the start answered without a status (a configuration error found at launch).
    this.settleFailed(attempt, 'capture_failed', status.error ?? NOT_TAKEN_MESSAGE);
  }

  private settleDegraded(attempt: StartAttempt, status: CaptureStatus): void {
    const failing = AUDIO_SOURCES.filter((source) => sourceProblems(status, source).length > 0);
    this.settle(attempt, 'started_degraded', {
      meetingId: attempt.meetingId,
      reason: failing.join(','),
      detail: failing
        .map((source) => `${source}: ${sourceProblems(status, source).join(', ')}`)
        .join('; '),
    });
  }

  private settleFailed(
    attempt: StartAttempt,
    reason: string,
    message: string,
    { showCard }: { showCard: boolean } = { showCard: true },
  ): void {
    this.settle(attempt, 'start_failed', { reason, detail: message });
    if (showCard) this.restoreCard(attempt, message);
  }

  private settle(
    attempt: StartAttempt,
    outcome: Extract<
      PromptOutcome,
      'started' | 'joined_and_started' | 'started_degraded' | 'start_failed'
    >,
    fields: { meetingId?: string | null; reason?: string; detail?: string },
  ): void {
    this.attempt = null;
    this.record(attempt.accountEmail, attempt.key, outcome, this.clock(), {
      reason: fields.reason ?? null,
      detail: fields.detail ?? null,
      meetingId: fields.meetingId ?? null,
    });
    this.options.logger.info('prompt start settled', {
      key: attempt.key,
      outcome,
      reason: fields.reason ?? null,
      meetingId: fields.meetingId ?? null,
    });
    this.schedule();
  }

  /** The start failed: its card comes back with the error, while its call is still on. */
  private restoreCard(attempt: StartAttempt, message: string): void {
    const { card } = attempt;
    const closesAtMs =
      card.kind === 'calendar'
        ? card.events.find(({ key }) => key === attempt.key)?.closesAtMs
        : card.closesAtMs;
    if (closesAtMs === undefined || closesAtMs <= this.clock()) return;
    card.phase = 'open';
    card.error = message;
    card.takingNotesUntilMs = null;
    if (card.kind === 'calendar') card.startingKey = null;
    if (!this.cards.includes(card)) this.cards.push(card);
    this.changed();
  }

  private openMeeting(meetingId: string): void {
    try {
      this.options.navigation.navigate(`meeting/${meetingId}`);
    } catch (error) {
      this.options.logger.error('the started note could not be opened in the window', {
        meetingId,
        error: errorMessage(error),
      });
    }
  }

  // Deadlines ------------------------------------------------------------------------------------

  /** Settles every deadline that has passed, then waits for the next. */
  private checkDeadlines(): void {
    const nowMs = this.clock();
    let changed = false;
    try {
      for (const card of [...this.cards]) {
        if (card.kind === 'stale_calendar') continue;
        if (card.takingNotesUntilMs !== null && card.takingNotesUntilMs <= nowMs) {
          this.endTakingNotes(card, nowMs);
          changed = true;
        } else if (this.expire(card, nowMs)) {
          changed = true;
        }
      }
      const attempt = this.attempt;
      if (attempt?.decideAtMs != null && attempt.decideAtMs <= nowMs) this.decide(attempt);
    } catch (error) {
      this.options.logger.error('prompt deadlines could not be settled', {
        error: errorMessage(error),
      });
    }
    if (changed) this.changed();
    else this.schedule();
  }

  /** Logs `expired` for each open event past its window. Returns whether the card changed. */
  private expire(card: StartableCard, nowMs: number): boolean {
    if (card.phase !== 'open') return false;
    if (card.kind === 'call_detected') {
      if (card.closesAtMs > nowMs) return false;
      this.record(card.accountEmail, card.key, 'expired', nowMs);
      this.removeCard(card);
      return true;
    }
    const due = card.events.filter(({ closesAtMs }) => closesAtMs <= nowMs);
    if (due.length === 0) return false;
    for (const { key } of due) this.record(card.accountEmail, key, 'expired', nowMs);
    card.events = card.events.filter((entry) => !due.includes(entry));
    if (card.events.length === 0) this.removeCard(card);
    return true;
  }

  /**
   * The "Taking notes" moment is over: the card leaves the panel. The other calls on a shared card
   * go with it, `expired`: the user chose one of the two.
   */
  private endTakingNotes(card: StartableCard, nowMs: number): void {
    card.takingNotesUntilMs = null;
    if (card.kind === 'calendar') {
      const others = card.events.filter(({ key }) => key !== card.startingKey);
      for (const { key } of others) {
        this.record(card.accountEmail, key, 'expired', nowMs, { reason: 'another_event_started' });
      }
      card.events = card.events.filter(({ key }) => key === card.startingKey);
    }
    this.removeCard(card);
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.running) return;
    const nextMs = this.nextDeadlineMs();
    if (nextMs === null) return;
    const waitMs = Math.min(Math.max(nextMs - this.clock(), 0), DEADLINE_CHECK_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.checkDeadlines();
    }, waitMs);
  }

  private nextDeadlineMs(): number | null {
    const deadlines: number[] = [];
    for (const card of this.cards) {
      if (card.kind === 'stale_calendar') continue;
      if (card.takingNotesUntilMs !== null) deadlines.push(card.takingNotesUntilMs);
      if (card.phase !== 'open') continue;
      if (card.kind === 'call_detected') deadlines.push(card.closesAtMs);
      else deadlines.push(...card.events.map(({ closesAtMs }) => closesAtMs));
    }
    if (this.attempt?.decideAtMs != null) deadlines.push(this.attempt.decideAtMs);
    return deadlines.length === 0 ? null : Math.min(...deadlines);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  // The stale card -------------------------------------------------------------------------------

  private onSyncState(state: CalendarSyncState): void {
    const card = this.cards.find((candidate) => candidate.kind === 'stale_calendar');
    if (state.staleSince === null) {
      if (card === undefined) return;
      this.removeCard(card);
      this.changed();
      return;
    }
    // Once per spell: a dismissed card stays dismissed until the copy is fresh again and goes
    // stale anew. Remembered for this run only; a relaunch mid-spell shows it once more.
    if (state.staleSince === this.staleSpellCarded) return;
    this.staleSpellCarded = state.staleSince;
    if (card !== undefined) this.removeCard(card);
    this.cards.push({
      kind: 'stale_calendar',
      id: this.newCardId(),
      lastSuccessAt: state.lastSuccessAt,
    });
    this.options.logger.info('stale calendar prompt shown', { staleSince: state.staleSince });
    this.changed();
  }

  // Helpers --------------------------------------------------------------------------------------

  /**
   * Logs an outcome; a refusal by the row's state (a late expiry after a start, a Dismiss after a
   * failed start: PromptLog's ALLOWED_FROM) is logged at debug and answers false.
   */
  private record(
    accountEmail: string,
    key: string,
    action: PromptOutcome,
    nowMs: number,
    fields: { reason?: string | null; detail?: string | null; meetingId?: string | null } = {},
  ): boolean {
    const written = this.options.log.recordAction({
      accountEmail,
      key,
      action,
      at: iso(nowMs),
      ...fields,
    });
    if (!written) {
      this.options.logger.debug('prompt outcome not logged: the row has moved on', { key, action });
    }
    return written;
  }

  private noteAnswered(card: CalendarCardState, nowMs: number): void {
    this.forgetOldAnswers(nowMs);
    this.recentAnswers.push({ atMs: nowMs, events: card.events.map(({ event }) => event) });
  }

  private forgetOldAnswers(nowMs: number): void {
    this.recentAnswers = this.recentAnswers.filter(
      (answer) => nowMs - answer.atMs < CALL_OFFER_QUIET_AFTER_ACTION_MS,
    );
  }

  private showError(card: StartableCard, message: string): void {
    card.error = message;
    this.changed();
  }

  private removeCard(card: CardState): void {
    this.cards = this.cards.filter((candidate) => candidate !== card);
  }

  private newCardId(): string {
    const id = `prompt-${this.nextCardId}`;
    this.nextCardId += 1;
    return id;
  }

  private changed(): void {
    this.schedule();
    this.events.emit('change', this.getState());
  }
}

/** A note is on its way or running: a start action stops it first. */
function isRecording(phase: CapturePhase): boolean {
  return phase === 'starting' || phase === 'recording';
}

/**
 * What keeps `source` from counting as live in a recording status: no audio yet (or a stalled,
 * ended or failed source), or a speech stream that is not open. Codes only, never the stream's
 * message: those quote the vendor.
 */
function sourceProblems(status: CaptureStatus, source: AudioSource): string[] {
  const problems: string[] = [];
  const { health, chunks } = status.sources[source];
  if (chunks === 0 || health === 'pending') problems.push('no audio');
  else if (health !== 'active') problems.push(`source ${health}`);
  const stream = status.streams[source];
  if (stream !== 'open') problems.push(`stream ${stream}`);
  return problems;
}

function toPromptCard(card: CardState): PromptCard | null {
  switch (card.kind) {
    case 'stale_calendar':
      return { kind: 'stale_calendar', id: card.id, lastSuccessAt: card.lastSuccessAt };
    case 'call_detected': {
      const shown: CallDetectedPromptCard = {
        kind: 'call_detected',
        id: card.id,
        phase: card.phase,
        error: card.error,
        app: card.app,
      };
      return shown;
    }
    case 'calendar': {
      const [first, ...rest] = card.events.map(({ event }) => event);
      if (first === undefined) return null;
      const shown: CalendarPromptCard = {
        kind: 'calendar',
        id: card.id,
        phase: card.phase,
        error: card.error,
        shownBy: card.shownBy,
        events: [first, ...rest],
      };
      return shown;
    }
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
