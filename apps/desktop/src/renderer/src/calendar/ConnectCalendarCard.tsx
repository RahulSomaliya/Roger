import { useId } from 'react';

export interface ConnectCalendarCardProps {
  /** A sign-in is waiting on the browser. */
  connecting: boolean;
  /** Why the last connect failed (the API's refusal, "tick the calendar box"), or null. */
  error: string | null;
  onConnect: () => void;
}

/**
 * Home's card while no calendar is connected: what Roger does with one, and the button. Connect
 * opens Google's sign-in in the browser and waits for the user to come back (up to 3 minutes), so
 * while it waits the button says so and offers to start over: a second connect cancels the first,
 * which is the only way out of a sign-in the user abandoned in the browser.
 */
export function ConnectCalendarCard({ connecting, error, onConnect }: ConnectCalendarCardProps) {
  const headingId = useId();
  return (
    <section className="card calendar-connect" aria-labelledby={headingId}>
      <h2 id={headingId} className="calendar-connect-title">
        See your day in Roger
      </h2>
      <p className="calendar-connect-text">
        Connect Google Calendar and Roger lists today’s meetings, reminds you just before a call and
        starts your notes in one click. Roger only reads your calendar.
      </p>
      <div className="calendar-connect-actions">
        <button type="button" className="shell-button calendar-start" onClick={onConnect}>
          {connecting ? 'Open Google again' : 'Connect Google Calendar'}
        </button>
      </div>
      {connecting ? (
        <p className="calendar-connect-status" role="status">
          Finish signing in in your browser. Roger waits up to 3 minutes.
        </p>
      ) : null}
      {error === null ? null : (
        <div className="error calendar-connect-error" role="alert">
          Roger could not connect Google Calendar: {error}
        </div>
      )}
    </section>
  );
}
