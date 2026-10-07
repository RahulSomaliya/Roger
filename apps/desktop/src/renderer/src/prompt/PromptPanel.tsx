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
  eventButtons,
  footerButtons,
  openRogerButton,
  type PromptButton,
} from './promptButtons';
import { callDetectedTitle, eventTitle, startLabel, stopsLabel, timeRange } from './promptFormat';
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
        // On a card of its own: the window is transparent, so a bare line would float over the call.
        <section className="prompt-card">
          <Problem>{error}</Problem>
        </section>
      )}
      {state !== null &&
        cards.map((card, index) => (
          <Card key={card.id} card={card} {...props} state={state} leading={index === 0} />
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
  const { card, failures } = props;
  const failure = failures[card.id];
  return (
    <section className="prompt-card" data-kind={card.kind} aria-label={cardLabel(card)}>
      {card.kind === 'calendar' && <CalendarCard {...props} card={card} />}
      {card.kind === 'call_detected' && <CallDetectedCard {...props} card={card} />}
      {card.error !== null && <Problem>{card.error}</Problem>}
      {failure !== undefined && <Problem>Roger could not do that: {failure}</Problem>}
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

function CalendarCard(props: CardProps & { card: CalendarPromptCard }) {
  const { card, leading } = props;
  if (card.phase === 'taking_notes') return <TakingNotes {...props} card={card} />;
  return (
    <>
      {card.events.map((event, index) => (
        <CalendarEvent key={event.id} {...props} event={event} leading={leading && index === 0} />
      ))}
      <Footer {...props} />
    </>
  );
}

function CalendarEvent(props: CardProps & { card: CalendarPromptCard; event: TimedCalendarEvent }) {
  const { card, event, nowMs, leading, onAct } = props;
  return (
    <div className="prompt-event">
      <p className="prompt-when">{startLabel(event.start, nowMs)}</p>
      <h2 className="prompt-title">{eventTitle(event)}</h2>
      <p className="prompt-meta">{timeRange(event.start, event.end)}</p>
      <div className="prompt-actions">
        {eventButtons(card, event, leading).map((button) => (
          <Button key={button.request.action} button={button} onAct={onAct} />
        ))}
      </div>
    </div>
  );
}

function CallDetectedCard(props: CardProps & { card: CallDetectedPromptCard }) {
  const { card, leading, onAct } = props;
  if (card.phase === 'taking_notes') return <TakingNotes {...props} card={card} />;
  return (
    <>
      <div className="prompt-event">
        <h2 className="prompt-title">{callDetectedTitle(card.app)}</h2>
        <div className="prompt-actions">
          {callDetectedButtons(card, leading).map((button) => (
            <Button key={button.request.action} button={button} onAct={onAct} />
          ))}
        </div>
      </div>
      <Footer {...props} />
    </>
  );
}

/**
 * "Recording and Open Roger" for the 5 s after a start. A prompt action never brings Roger's
 * window forward (the call stays on top); this is the one button that does, so it is the user's
 * own choice to leave the call. The dot is static: nothing in Roger blinks.
 */
function TakingNotes(props: CardProps & { card: CalendarPromptCard | CallDetectedPromptCard }) {
  const { card, onAct } = props;
  return (
    <p className="prompt-taking">
      <span className="recording-dot" aria-hidden="true" />
      <span>Recording</span>
      <Button button={openRogerButton(card)} onAct={onAct} />
    </p>
  );
}

/**
 * Dismiss, and on its left the one line a start needs when another note records. Said once per
 * card, not once per call: the stop is the same whichever call starts.
 */
function Footer(props: CardProps) {
  const { card, state, onAct } = props;
  return (
    <div className="prompt-footer">
      {state.recording && <p className="prompt-helper">{stopsLabel(state.recordingTitle)}</p>}
      {footerButtons(card).map((button) => (
        <Button key={button.request.action} button={button} onAct={onAct} />
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
      className="btn"
      data-variant={button.variant}
      data-size="sm"
      onClick={() => {
        onAct(button.request);
      }}
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
