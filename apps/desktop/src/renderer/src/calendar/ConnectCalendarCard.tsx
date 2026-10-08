import { Icon } from '../components/ui/icons';

export interface ConnectCalendarCardProps {
  /** A sign-in is waiting on the browser. */
  connecting: boolean;
  /** Why the last connect failed (the API's refusal, "tick the calendar box"), or null. */
  error: string | null;
  onConnect: () => void;
}

/**
 * Home's line while no calendar is connected: one secondary button and one helper line. The
 * helper says, once, what connecting gives and that Roger opens at login to do it (the switch is
 * in Settings): there is no "Roger will open at login" line after the connect any more.
 *
 * Connect opens Google's sign-in in the browser and waits for the user to come back (up to 3
 * minutes), so while it waits the line says so and the button stays: a second connect cancels the
 * first, which is the only way out of a sign-in the user abandoned in the browser.
 */
export function ConnectCalendarCard({ connecting, error, onConnect }: ConnectCalendarCardProps) {
  return (
    <section className="calendar-connect" aria-label="Google Calendar">
      <div className="calendar-connect-row">
        <button type="button" className="btn" onClick={onConnect}>
          Connect Google Calendar
        </button>
        {connecting ? (
          <p className="calendar-connect-help" role="status">
            Finish signing in in your browser. Roger waits up to 3 minutes.
          </p>
        ) : (
          <p className="calendar-connect-help">
            Roger shows today’s meetings and reminds you before a call, so it opens at login. It
            only reads your calendar.
          </p>
        )}
      </div>
      {error === null ? null : (
        <div className="problem" role="alert">
          <Icon name="circle-alert" />
          <span className="problem-text">Roger could not connect Google Calendar: {error}</span>
        </div>
      )}
    </section>
  );
}
