import { SlotOutlet } from './SlotOutlet';

/**
 * The full-window setup route (no sidebar): the `setup` slot, M2's permission setup. Main opens it
 * with app:navigate, from "Set up Roger…" in the app menu and, from M2-T19, on first run. Its Done
 * button is in the slot, not here: it shows only once every check passes, and only the screen
 * knows (components/setup/SetupScreen.tsx). The slot is always mounted, so the route has no empty
 * state of its own.
 */
export function SetupRoute() {
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Set up Roger</h1>
      </header>
      <SlotOutlet name="setup" props={{}} />
    </div>
  );
}
