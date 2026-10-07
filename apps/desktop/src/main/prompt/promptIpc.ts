import {
  promptChannels,
  type PromptActionName,
  type PromptActionRequest,
  type PromptPanelState,
} from '../../shared/ipc/prompt';
import { MAX_CALENDAR_TEXT_LENGTH } from '../ipc-validation';
import { handleTrusted, type IpcMainLike, type IpcTrust } from '../ipc/trust';
import type { Logger } from '../logger';
import type { PromptService } from './PromptService';

/** The prompt panel's window (M5-T10's PromptWindow), as far as its channels need it. */
export interface PromptPanelWindow {
  readonly webContents: {
    readonly id: number;
    send(channel: string, payload: unknown): void;
    isDestroyed(): boolean;
  };
}

export interface PromptIpcDeps {
  ipcMain: IpcMainLike;
  /**
   * The prompt panel, or null while it is not built. Its page is the only sender these channels
   * answer: the trust check is by window (ipc/trust.ts), so this is the panel, never the main
   * window, whose page has no business clicking a prompt.
   */
  getWindow: () => PromptPanelWindow | null;
  prompts: Pick<PromptService, 'getState' | 'act' | 'onChange'>;
  logger: Logger;
}

/**
 * Wires the prompt panel's channels (src/shared/ipc/prompt.ts) to the PromptService: the state on
 * request and on every change, and the clicks. Returns the stop of the change forwarding.
 *
 * Trap: register these through handleTrusted with the panel as `getWindow`, never with the main
 * window's getter that every other registrar passes. Each registrar trusts exactly one window, so
 * the main window's would refuse every click from the panel, and the panel's here keeps every
 * other channel shut to it (the panel's own preload, M5-T10, exposes only these).
 */
export function registerPromptIpc({
  ipcMain,
  getWindow,
  prompts,
  logger,
}: PromptIpcDeps): () => void {
  const trust: IpcTrust = { ipcMain, getWindow, logger };
  handleTrusted(trust, promptChannels.PromptGetState, () => prompts.getState());
  handleTrusted(trust, promptChannels.PromptAct, (payload) =>
    prompts.act(parsePromptActionRequest(payload)),
  );
  return prompts.onChange((state: PromptPanelState) => {
    const panel = getWindow();
    // A panel not built yet or gone reads the whole state when its page loads (getState).
    if (panel === null || panel.webContents.isDestroyed()) return;
    panel.webContents.send(promptChannels.PromptStateChanged, state);
  });
}

/** Card ids are PromptService's `prompt-<n>`; the cap only keeps a bad payload small. */
const MAX_CARD_ID_LENGTH = 64;

const ACTIONS: readonly PromptActionName[] = [
  'take_notes',
  'join_and_take_notes',
  'copy_notice',
  'dismiss',
  'open_roger',
];

/**
 * The panel's click, checked, as a fresh object: nothing else the payload carries reaches the
 * service. Throws naming the field, never quoting its value.
 */
export function parsePromptActionRequest(payload: unknown): PromptActionRequest {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    refuse('not an object');
  }
  // Checked just above: an object that is not an array, read field by field as unknown.
  const { cardId, action, eventId } = payload as Record<string, unknown>;
  if (!isText(cardId, MAX_CARD_ID_LENGTH)) refuse('cardId is not a card id');
  const name = ACTIONS.find((candidate) => candidate === action);
  if (name === undefined) refuse('action is not a prompt action');
  const hasEventId = eventId !== undefined;
  if (hasEventId && !isText(eventId, MAX_CALENDAR_TEXT_LENGTH))
    refuse('eventId is not an event id');
  switch (name) {
    case 'join_and_take_notes':
      if (!hasEventId) refuse('eventId is not an event id');
      return { cardId, action: name, eventId };
    case 'take_notes':
      return hasEventId ? { cardId, action: name, eventId } : { cardId, action: name };
    default:
      return { cardId, action: name };
  }
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function refuse(why: string): never {
  throw new Error(`${promptChannels.PromptAct} refused: ${why}`);
}
