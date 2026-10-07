import type { PromptCard } from '../calendar';
import type { Unsubscribe } from './unsubscribe';

/**
 * The prompt panel's channels and its API (M5-T9b). The panel is not part of `window.roger`
 * (RogerApi): its own preload (src/preload/prompt.ts, M5-T10) exposes only `window.rogerPrompt`,
 * and main/prompt/promptIpc.ts answers the panel's page as the only sender, the main window
 * included. Its channels still go into IpcChannel (src/shared/ipc.ts) and its uniqueness test,
 * because they share ipcMain's one namespace with every other channel.
 *
 * Main decides everything the panel shows (main/prompt/PromptService.ts): the panel renders the
 * state it is sent and reports clicks. It holds no state of its own, so a reload loses nothing.
 */
export const promptChannels = {
  /** prompt panel → main, invoke: the panel as it should look now */
  PromptGetState: 'prompt:get-state',
  /** main → prompt panel event: the panel changed (a card came, went, or changed phase) */
  PromptStateChanged: 'prompt:state-changed',
  /** prompt panel → main, invoke: a click on a card */
  PromptAct: 'prompt:act',
} as const;

/** Everything the panel renders. */
export interface PromptPanelState {
  /** In the order they came up. The panel shows itself while this is not empty (M5-T10). */
  cards: PromptCard[];
  /**
   * A note is starting or recording: a start action stops it first, so its button reads "Stop
   * current note and start".
   */
  recording: boolean;
  /** `notice.enabled`: calendar cards offer Copy notice only while it is on. */
  noticeEnabled: boolean;
}

/**
 * A click on a card. `cardId` is `PromptCard.id`.
 * - take_notes: start a note. On a calendar card `eventId` names which of its events (a card can
 *   hold two calls starting within a minute); a call-detected card takes none.
 * - join_and_take_notes: open the event's video link (allowlisted hosts only), then start.
 * - copy_notice: put the consent notice on the clipboard; the card stays.
 * - dismiss: close the card.
 * - open_roger: on a card that is taking notes, bring Roger's window forward. The one action that
 *   may activate Roger: the user asked to leave the call for it.
 */
export type PromptActionRequest =
  | { cardId: string; action: 'take_notes'; eventId?: string }
  | { cardId: string; action: 'join_and_take_notes'; eventId: string }
  | { cardId: string; action: 'copy_notice' | 'dismiss' | 'open_roger' };

export type PromptActionName = PromptActionRequest['action'];

/** The prompt panel's API: `window.rogerPrompt` (src/preload/prompt.ts, M5-T10). */
export interface PromptApi {
  /**
   * The panel's state now. Subscribe with onStateChanged first, then call this: a change sent
   * between the two is then not missed.
   */
  getState(): Promise<PromptPanelState>;
  onStateChanged(listener: (state: PromptPanelState) => void): Unsubscribe;
  /**
   * Runs a click. Resolves once main has taken it; what follows (the card taking notes, an error
   * on it, the card gone) arrives as a new state. Rejects only for a request that is not one.
   */
  act(request: PromptActionRequest): Promise<void>;
}
