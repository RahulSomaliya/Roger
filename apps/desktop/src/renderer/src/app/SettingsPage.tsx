import { SlotOutlet } from './SlotOutlet';
import '../settings/settings.css';

/**
 * Settings: the `settings` slot's sections, each with its own heading (M3's jargon list, M5's
 * calendar). Reached from the header's Settings icon and from "Settings…" in the app menu. The
 * sections are space and a hairline (settings/settings.css), so the page draws no empty state: a
 * slot with nothing in it is simply a title.
 */
export function SettingsPage() {
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Settings</h1>
      </header>
      <div className="settings-list">
        <SlotOutlet name="settings" props={{}} />
      </div>
    </div>
  );
}
