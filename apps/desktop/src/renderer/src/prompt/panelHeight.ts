/**
 * How the panel page tells main how tall its cards are (M5-T10). The window is sized to its cards
 * and only the page knows their height, but the panel's three channels belong to M5-T9b
 * (shared/ipc/prompt.ts, main/prompt/promptIpc.ts), so the height travels as the page's TITLE:
 * main hears `page-title-updated` and reads it (`parsePanelHeight` in main/prompt/PromptWindow.ts).
 * A frameless window shows no title, so nothing else reads it.
 *
 * Keep the text in step with `parsePanelHeight`: change one and the other's test fails, and a
 * mismatch is silent in the app (the window would never get a height, so it would never show).
 */
const TITLE_PREFIX = 'roger-prompt-height:';

/** The page title that reports `height` CSS pixels, rounded up. 0 means no cards. */
export function panelHeightTitle(height: number): string {
  return `${TITLE_PREFIX}${Math.ceil(height)}`;
}
