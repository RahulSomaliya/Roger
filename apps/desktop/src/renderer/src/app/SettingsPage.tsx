import { isSlotEmpty, SlotOutlet } from './SlotOutlet';

/**
 * Settings: the `settings` slot's sections, each with its own heading (M3's jargon list, M4's
 * notes, M5's calendar). Reached from the sidebar and from "Settings…" in the app menu.
 */
export function SettingsPage() {
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Settings</h1>
      </header>
      {isSlotEmpty('settings') ? (
        <p className="empty-state-text">Nothing to set here yet.</p>
      ) : (
        <div className="settings-sections">
          <SlotOutlet name="settings" props={{}} />
        </div>
      )}
    </div>
  );
}
