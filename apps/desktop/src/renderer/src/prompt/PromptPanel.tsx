import type {
  CalendarPromptCard,
  CallDetectedPromptCard,
  PromptCard,
  TimedCalendarEvent,
} from '../../../shared/calendar';
import type { PromptActionRequest, PromptPanelState } from '../../../shared/ipc/prompt';
import { Icon } from '../components/ui/icons';
import {
  callDetectedButtons,
  dismissButton,
  eventButtons,
  openRogerButton,
  type PromptButton,
} from './promptButtons';
import {
  callDetectedTitle,
  callOverline,
  eventTitle,
  hours,
  overline,
  stopsLabel,
} from './promptFormat';
import './prompt.css';

/**
 * Every line a person can read on the panel comes from this file, `promptFormat.ts` or main's own
 * plain sentences on the card (`PromptService`). Nothing a thrown error says is ever drawn: a
 * failed read is a flag and a refused click an id, so no vendor, HTTP code, route or IPC text can
 * reach a card floating over someone's call (redesign sweep, P2; PromptPanel.test.ts feeds it).
 */
const READ_FAILED = 'Roger could not show this reminder.';
const CLICK_FAILED = 'Roger could not do that. Try again.';

export interface PromptPanelProps {
  /**
   * Main's state, with the cards that are still sliding out added (leavingCards.ts); null until
   * the page has read it.
   */
  state: PromptPanelState | null;
  /** The first read failed: one plain line on a card of its own. */
  readFailed: boolean;
  /** The clock the "Starting in ..." lines read; the page ticks it. */
  nowMs: number;
  /** Ids of cards whose click main refused (`PromptApi.act` rejected). */
  failed: ReadonlySet<string>;
  /** Ids of cards main has removed that are playing their exit. */
  leaving: ReadonlySet<string>;
  onAct: (request: PromptActionRequest) => void;
  /** A leaving card's exit animation ended: the page may forget it. */
  onLeft: (cardId: string) => void;
}

/**
 * The prompt panel's cards, drawn from the state main sends (M5-T10). It holds nothing: main
 * decides which cards exist and in which phase, and every click goes back as a request. Nothing
 * here waits on a click: a start can take 15 s while the old note's uploads drain, and its
 * progress arrives as the next state (`PromptApi.act`).
 */
export function PromptPanel(props: PromptPanelProps) {
  const { state, readFailed, leaving } = props;
  if (state === null && !readFailed) return null;
  const cards = state?.cards ?? [];
  if (cards.length === 0 && !readFailed) return null;
  // The one primary belongs to the first card that is staying: a leaving card is about to go.
  const leadId = cards.find((card) => !leaving.has(card.id))?.id;
  return (
    <div className="prompt-stack">
      {readFailed && (
        // On a card of its own: the window is transparent, so a bare line would float over the call.
        <section className="prompt-card">
          <Problem>{READ_FAILED}</Problem>
        </section>
      )}
      {state !== null &&
        cards.map((card) => (
          <Card key={card.id} card={card} {...props} state={state} leading={card.id === leadId} />
        ))}
    </div>
  );
}

interface CardProps extends PromptPanelProps {
  card: PromptCard;
  state: PromptPanelState;
  /** The panel's first card: its first start is the one primary button (promptButtons.ts). */
  leading: boolean;
}

function Card(props: CardProps) {
  const { card, failed, leaving, onLeft } = props;
  const going = leaving.has(card.id);
  // One plain sentence: main's own for a failed start, else ours for a click it refused.
  const problem = card.error ?? (failed.has(card.id) ? CLICK_FAILED : null);
  return (
    <section
      className="prompt-card"
      data-kind={card.kind}
      data-leaving={going ? 'true' : undefined}
      // A card sliding out takes no click and no focus; it keeps its buttons so it keeps its height.
      inert={going}
      aria-label={cardLabel(card)}
      onAnimationEnd={(event) => {
        if (going && event.target === event.currentTarget) onLeft(card.id);
      }}
    >
      {card.kind === 'calendar' && <CalendarCard {...props} card={card} problem={problem} />}
      {card.kind === 'call_detected' && (
        <CallDetectedCard {...props} card={card} problem={problem} />
      )}
    </section>
  );
}

function cardLabel(card: PromptCard): string {
  switch (card.kind) {
    case 'calendar':
      return eventTitle(card.events[0]);
    case 'call_detected':
      return callDetectedTitle(card.app);
  }
}

function CalendarCard(props: CardProps & { card: CalendarPromptCard; problem: string | null }) {
  const { card, leading, nowMs, problem, onAct } = props;
  if (card.phase === 'taking_notes') {
    const started = card.events.find((event) => event.id === card.startedEventId) ?? card.events[0];
    return <TakingNotes title={eventTitle(started)} card={card} onAct={onAct} />;
  }
  const single = card.events.length === 1;
  return (
    <>
      <Head card={card} label={overline(card.events[0].start, nowMs)} onAct={onAct} />
      {/* Before what to do: with two calls the line is the card's, so it sits above both. */}
      {!single && problem !== null && <Problem>{problem}</Problem>}
      {card.events.map((event, index) => (
        <CalendarEvent
          key={event.id}
          {...props}
          event={event}
          leading={leading && index === 0}
          problem={single ? problem : null}
        />
      ))}
      <Helper {...props} />
    </>
  );
}

function CalendarEvent(
  props: CardProps & {
    card: CalendarPromptCard;
    event: TimedCalendarEvent;
    problem: string | null;
  },
) {
  const { card, event, leading, problem, onAct } = props;
  return (
    <div className="prompt-event">
      <h2 className="prompt-title">{eventTitle(event)}</h2>
      <p className="prompt-hours">{hours(event.start, event.end)}</p>
      {problem !== null && <Problem>{problem}</Problem>}
      <div className="prompt-actions">
        {eventButtons(card, event, leading).map((button) => (
          <Button key={button.request.action} button={button} onAct={onAct} />
        ))}
      </div>
    </div>
  );
}

function CallDetectedCard(
  props: CardProps & { card: CallDetectedPromptCard; problem: string | null },
) {
  const { card, leading, problem, onAct } = props;
  if (card.phase === 'taking_notes') {
    return <TakingNotes title={callDetectedTitle(card.app)} card={card} onAct={onAct} />;
  }
  return (
    <>
      <Head card={card} label={callOverline()} onAct={onAct} />
      <div className="prompt-event">
        <h2 className="prompt-title">{callDetectedTitle(card.app)}</h2>
        {problem !== null && <Problem>{problem}</Problem>}
        <div className="prompt-actions">
          {callDetectedButtons(card, leading).map((button) => (
            <Button key={button.request.action} button={button} onAct={onAct} />
          ))}
        </div>
      </div>
      <Helper {...props} />
    </>
  );
}

/**
 * The overline and, at the right, Dismiss. The x sits in the same row so the card keeps its
 * footer for the start buttons; prompt.css pulls it into the padding so the glyph, not the 32 px
 * button, lines up with the card's 16 px edge.
 */
function Head({
  card,
  label,
  onAct,
}: {
  card: PromptCard;
  label: string;
  onAct: (request: PromptActionRequest) => void;
}) {
  return (
    <div className="prompt-head">
      <p className="overline prompt-overline">{label}</p>
      <Button button={dismissButton(card)} onAct={onAct} />
    </div>
  );
}

/**
 * "Recording \u00b7 Northwind renewal" and Open Roger, for the 5 s after a start. It names the call
 * because a card of two calls would otherwise not say which started (P10). A prompt action never
 * brings Roger's window forward (the call stays on top); Open Roger is the one button that does, so
 * it is the user's own choice to leave the call. The dot is static: nothing in Roger blinks.
 */
function TakingNotes({
  card,
  title,
  onAct,
}: {
  card: CalendarPromptCard | CallDetectedPromptCard;
  title: string;
  onAct: (request: PromptActionRequest) => void;
}) {
  return (
    <div className="prompt-taking">
      <span className="recording-dot" aria-hidden="true" />
      <span className="prompt-taking-label">Recording</span>
      <span className="prompt-taking-title">{`\u00b7 ${title}`}</span>
      <Button button={openRogerButton(card)} onAct={onAct} />
    </div>
  );
}

/**
 * The one line a start needs when another note records, under the buttons. Said once per card,
 * not once per call: the stop is the same whichever call starts.
 */
function Helper({ state }: CardProps) {
  if (!state.recording) return null;
  return <p className="prompt-helper">{stopsLabel(state.recordingTitle)}</p>;
}

function Button({
  button,
  onAct,
}: {
  button: PromptButton;
  onAct: (request: PromptActionRequest) => void;
}) {
  const click = (): void => {
    onAct(button.request);
  };
  if (button.icon !== undefined) {
    // Icon only: the name is the aria-label, and the tooltip says it to a mouse.
    return (
      <button
        type="button"
        className="btn prompt-icon-button"
        data-variant={button.variant}
        data-size="sm"
        aria-label={button.label}
        title={button.label}
        onClick={click}
      >
        <Icon name={button.icon} />
      </button>
    );
  }
  return (
    <button
      type="button"
      className="btn"
      data-variant={button.variant}
      data-size="sm"
      onClick={click}
    >
      {button.label}
    </button>
  );
}

/** A loud problem line (docs/design.md): an icon, one sentence in ink, no box and no red. */
function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p className="problem" role="alert">
      <Icon name="circle-alert" />
      <span className="problem-text">{children}</span>
    </p>
  );
}
