import type { PreferencesStore } from '../preferences/PreferencesStore';
import type { Logger } from '../logger';

/**
 * The notice to the other people on a call (M5 design, "Notice to others"; owner decision D3 for
 * the wording): on by default, its text a setting (`notice.enabled`, `notice.text` in
 * src/shared/calendarPrefs.ts). The prompt's Copy notice puts the text on the clipboard for the
 * user to paste into the meeting chat; Roger never posts it (that is M9's extension).
 *
 * The copy goes through Electron's `clipboard` in main: the prompt panel is never focused
 * (`focusable: false`, so the call keeps the keyboard), and a page's `navigator.clipboard` refuses
 * to write from an unfocused document.
 */

/** Electron's `clipboard`, as far as the notice uses it. */
export interface NoticeClipboard {
  writeText(text: string): void;
}

export interface ConsentNoticeDeps {
  preferences: Pick<PreferencesStore, 'get' | 'onChange'>;
  clipboard: NoticeClipboard;
  logger: Logger;
}

export interface ConsentNotice {
  /** `notice.enabled`: cards offer Copy notice only while it is on. */
  enabled(): boolean;
  /**
   * Puts the current `notice.text` on the clipboard, read at this moment so an edit in Settings
   * applies to the next copy. Returns false, copying nothing, while the notice is off.
   */
  copy(): boolean;
  /** Called with the new value each time `notice.enabled` changes. Returns the removal. */
  onEnabledChange(listener: (enabled: boolean) => void): () => void;
}

export function createConsentNotice({
  preferences,
  clipboard,
  logger,
}: ConsentNoticeDeps): ConsentNotice {
  return {
    enabled: () => preferences.get('notice.enabled'),
    copy: () => {
      if (!preferences.get('notice.enabled')) return false;
      const text = preferences.get('notice.text');
      clipboard.writeText(text);
      // Its length only: the wording is the user's own and may name the company or a client.
      logger.info('consent notice copied', { characters: text.length });
      return true;
    },
    onEnabledChange: (listener) =>
      preferences.onChange((change) => {
        if (change.key === 'notice.enabled') listener(change.value);
      }),
  };
}
