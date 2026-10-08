import { AppearanceSetting } from '../settings/AppearanceSetting';
import { MacSettings } from '../settings/MacSettings';
import { SlotOutlet } from './SlotOutlet';
import '../settings/settings.css';

/**
 * Settings, in the order a person comes for things (sweep section 4): Appearance, then the
 * `settings` slot's sections (Calendar at order 5, M3's jargon list at 10), then Mac. Appearance
 * and Mac are the page's own, so they never depend on a slot mounting; the slot's two sections
 * keep their registry orders (app/slots/m5-calendar.ts, m3-transcript.ts). Reached from the
 * header's Settings icon and from "Settings…" in the app menu; the header's "Home" leaves it. The
 * sections are space and a hairline (settings/settings.css), so the page draws no empty state: a
 * slot with nothing in it is simply a missing section.
 */
export function SettingsPage() {
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Settings</h1>
      </header>
      <div className="settings-list">
        <AppearanceSetting />
        <SlotOutlet name="settings" props={{}} />
        <MacSettings />
      </div>
    </div>
  );
}
