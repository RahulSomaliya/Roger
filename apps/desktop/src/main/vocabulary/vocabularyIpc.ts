import { vocabularyChannels } from '../../shared/ipc/vocabulary';
import { isTermList, vocabularyProblem } from '../../shared/vocabulary';
import type { VocabularyRoutes } from '../api/vocabularyClient';
import { handleTrusted, type IpcMainLike, type IpcTrust, type TrustedWindow } from '../ipc/trust';
import { errorMessage, type Logger } from '../logger';

export interface VocabularyIpcDeps {
  ipcMain: IpcMainLike;
  client: VocabularyRoutes;
  /** The main window, whose page alone may read and replace the list; null while it is closed. */
  getWindow: () => TrustedWindow | null;
  logger: Logger;
}

/**
 * Wires the jargon list's channels (src/shared/ipc/vocabulary.ts) to the Roger API, for the main
 * window's page only (ipc/trust.ts). Nothing is cached: every read asks the API, so the editor
 * starts from the list as stored now. Two Macs saving at once can still overwrite each other: a
 * save replaces the whole list with no version check (M3 plan, "Jargon list storage").
 *
 * Trap: a read waits for every save this Mac sent before it. The page's editor lives only while
 * Settings is open (renderer/src/settings/VocabularySettings.tsx), so leaving during a save and
 * coming back reads again at once; answered before the save commits, that read shows the old list
 * as saved and the next Save writes it back over the change. Keep the wait here, in main, which
 * outlives every page: an editor kept outside the component would not survive a page reload. A
 * save that times out (api/http.ts, 10 s) ends the wait while the API may still commit it.
 *
 * Log lines carry counts and the API's error, never a term: terms name clients and colleagues.
 * The API's 422 messages name positions (`body.terms[3]`), not values, so they are safe to log.
 */
export function registerVocabularyIpc({
  ipcMain,
  client,
  getWindow,
  logger,
}: VocabularyIpcDeps): void {
  const trust: IpcTrust = { ipcMain, getWindow, logger };
  /** Settles once every save sent so far has answered, either way. */
  let savesAnswered: Promise<void> = Promise.resolve();

  handleTrusted(trust, vocabularyChannels.VocabularyGet, async () => {
    await savesAnswered;
    try {
      return await client.getVocabulary();
    } catch (error) {
      // Rethrown, never answered as []: an editor that saves what it read would wipe the list.
      logger.warn('jargon list read failed', { error: errorMessage(error) });
      throw error;
    }
  });

  handleTrusted(trust, vocabularyChannels.VocabularySet, async (payload) => {
    const terms = parseSetRequest(payload, logger);
    const save = client.replaceVocabulary(terms);
    // Set before the first await, so a read that arrives next already waits for this save. Its
    // outcome reaches the page through `await save` below; the reads wait only for it to end.
    savesAnswered = Promise.allSettled([savesAnswered, save]).then(() => undefined);
    try {
      const stored = await save;
      logger.info('jargon list saved', { sent: terms.length, stored: stored.length });
      return stored;
    } catch (error) {
      logger.warn('jargon list save failed', { error: errorMessage(error), sent: terms.length });
      throw error;
    }
  });
}

/**
 * The renderer's list, checked as the API would check it (src/shared/vocabulary.ts), so a list the
 * API refuses never leaves the Mac and an oversized payload is refused before any request. Builds
 * a fresh array of the checked terms: nothing else the payload carries reaches the API.
 */
function parseSetRequest(payload: unknown, logger: Logger): string[] {
  const channel = vocabularyChannels.VocabularySet;
  const terms =
    typeof payload === 'object' && payload !== null && 'terms' in payload ? payload.terms : null;
  if (!isTermList(terms)) {
    logger.warn('jargon list save refused', { problem: 'not a list of strings' });
    throw new Error(`${channel} takes { terms: string[] }`);
  }
  const problem = vocabularyProblem(terms);
  if (problem !== null) {
    // The problem names a term's index, never its text (vocabularyProblem), so it may be logged.
    logger.warn('jargon list save refused', { problem });
    throw new Error(`${channel} refused: ${problem}`);
  }
  return [...terms];
}
