import type {
  CalendarPromptCard,
  CallDetectedPromptCard,
  PromptCard,
  StaleCalendarPromptCard,
  TimedCalendarEvent,
} from '../../../shared/calendar';
import type { PromptActionRequest, PromptPanelState } from '../../../shared/ipc/prompt';
import {
  callDetectedButtons,
  eventButtons,
  footerButtons,
  openRogerButton,
  type PromptButton,
} from './promptButtons';
import {
  attendeeSummary,
  callDetectedTitle,
  eventTitle,
  staleLabel,
  startLabel,
  timeRange,
} from './promptFormat';
import './prompt.css';

export interface PromptPanelProps {
  /** Main's state; null until the page has read it. */
  state: PromptPanelState | null;
  /** Why the state could not be read, else null. */
  error: string | null;
  /** The clock the "Starting in ..." lines read; the page ticks it. */
  nowMs: number;
  /** A click main refused (`PromptApi.act` rejected), by card id. */
  failures: Readonly<Record<string, string>>;
  /** The card whose notice was just copied: its button says "Copied" for a moment. */
  copiedCardId: string | null;
  onAct: (request: PromptActionRequest) => void;
}

/**
 * The prompt panel's cards, drawn from the state main sends (M5-T10). It holds nothing: main
 * decides which cards exist and in which phase, and every click goes back as a request. Nothing
 * here waits on a click: a start can take 15 s while the old note's uploads drain, and its
 * progress arrives as the next state (`PromptApi.act`).
 */
export function PromptPanel(props: PromptPanelProps) {
  const { state, error } = props;
  if (state === null && error === null) return null;
  const cards = state?.cards ?? [];
  if (cards.length === 0 && error === null) return null;
  return (
    <div className="prompt-stack">
      {error !== null && (
        <p className="prompt-error" role="alert">
          {error}
        </p>
      )}
      {state !== null &&
        cards.map((card) => <Card key={card.id} card={card} {...props} state={state} />)}
    </div>
  );
}

interface CardProps extends PromptPanelProps {
  card: PromptCard;
  state: PromptPanelState;
}

function Card(props: CardProps) {
  const { card, failures } = props;
  const failure = failures[card.id];
  return (
    <section className="prompt-card" data-kind={card.kind} aria-label={cardLabel(card)}>
      {card.kind === 'calendar' && <CalendarCard {...props} card={card} />}
      {card.kind === 'call_detected' && <CallDetectedCard {...props} card={card} />}
      {card.kind === 'stale_calendar' && <StaleCard {...props} card={card} />}
      {card.kind !== 'stale_calendar' && card.error !== null && (
        <p className="prompt-error" role="alert">
          {card.error}
        </p>
      )}
      {failure !== undefined && (
        <p className="prompt-error" role="alert">
          Roger could not do that: {failure}
        </p>
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
    case 'stale_calendar':
      return 'Calendar not updated';
  }
}

function CalendarCard(props: CardProps & { card: CalendarPromptCard }) {
  const { card, state, nowMs } = props;
  if (card.phase === 'taking_notes') return <TakingNotes {...props} card={card} />;
  return (
    <>
      {card.events.map((event) => (
        <CalendarEvent key={event.id} {...props} event={event} />
      ))}
      <Footer {...props} nowMs={nowMs} state={state} />
    </>
  );
}

function CalendarEvent(props: CardProps & { card: CalendarPromptCard; event: TimedCalendarEvent }) {
  const { card, event, state, nowMs, onAct } = props;
  const attendees = attendeeSummary(event);
  return (
    <div className="prompt-event">
      <p className="prompt-when">{startLabel(event.start, nowMs)}</p>
      <h2 className="prompt-title">{eventTitle(event)}</h2>
      <p className="prompt-meta">{timeRange(event.start, event.end)}</p>
      {attendees !== null && <p className="prompt-meta prompt-attendees">{attendees}</p>}
      <div className="prompt-actions">
        {eventButtons(card, event, state.recording).map((button) => (
          <Button key={button.request.action} button={button} onAct={onAct} />
        ))}
      </div>
    </div>
  );
}

function CallDetectedCard(props: CardProps & { card: CallDetectedPromptCard }) {
  const { card, state, onAct } = props;
  if (card.phase === 'taking_notes') return <TakingNotes {...props} card={card} />;
  return (
    <>
      <div className="prompt-event">
        <h2 className="prompt-title">{callDetectedTitle(card.app)}</h2>
        <div className="prompt-actions">
          {callDetectedButtons(card, state.recording).map((button) => (
            <Button key={button.request.action} button={button} onAct={onAct} />
          ))}
        </div>
      </div>
      <Footer {...props} />
    </>
  );
}

function StaleCard(props: CardProps & { card: StaleCalendarPromptCard }) {
  const { card, nowMs } = props;
  return (
    <>
      <p className="prompt-title prompt-stale">{staleLabel(card.lastSuccessAt, nowMs)}</p>
      <Footer {...props} />
    </>
  );
}

/**
 * "Taking notes · Open Roger" for the 5 s after a start. A prompt action never brings Roger's
 * window forward (the call stays on top); this is the one button that does, so it is the user's
 * own choice to leave the call.
 */
function TakingNotes(props: CardProps & { card: CalendarPromptCard | CallDetectedPromptCard }) {
  const { card, onAct } = props;
  return (
    <p className="prompt-taking">
      <span className="prompt-dot" aria-hidden="true" />
      <span>Taking notes</span>
      <span aria-hidden="true">·</span>
      <Button button={openRogerButton(card)} onAct={onAct} />
    </p>
  );
}

function Footer(props: CardProps) {
  const { card, state, onAct, copiedCardId } = props;
  return (
    <div className="prompt-footer">
      {footerButtons(card, state).map((button) => (
        <Button
          key={button.request.action}
          button={
            button.request.action === 'copy_notice' && copiedCardId === card.id
              ? { ...button, label: 'Copied' }
              : button
          }
          onAct={onAct}
        />
      ))}
    </div>
  );
}

function Button({
  button,
  onAct,
}: {
  button: PromptButton;
  onAct: (request: PromptActionRequest) => void;
}) {
  return (
    <button
      type="button"
      className={`prompt-button prompt-${button.tone}`}
      onClick={() => {
        onAct(button.request);
      }}
    >
      {button.label}
    </button>
  );
}
