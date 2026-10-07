import { HOME } from './router';
import { isSlotEmpty, SlotOutlet } from './SlotOutlet';
import { useShell } from './ShellContext';

/**
 * The full-window setup route (no sidebar): the `setup` slot, M2's permission setup. Main opens it
 * with app:navigate, from "Set up Roger…" in the app menu and, from M2-T19, on first run. "Done"
 * goes Home, since there is no sidebar to leave by.
 */
export function SetupRoute() {
  const { navigate } = useShell();
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Set up Roger</h1>
        <button
          type="button"
          className="btn"
          data-variant="secondary"
          data-size="sm"
          onClick={() => {
            navigate(HOME);
          }}
        >
          Done
        </button>
      </header>
      {isSlotEmpty('setup') ? (
        <p className="empty-state-text">Roger needs nothing set up on this Mac yet.</p>
      ) : (
        <SlotOutlet name="setup" props={{}} />
      )}
    </div>
  );
}
