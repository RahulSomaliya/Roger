import { vocabularyChannels, type VocabularyApi } from '../../src/shared/ipc/vocabulary';
import { sameTerm, trimTerm, vocabularyProblem } from '../../src/shared/vocabulary';
import { fromApi } from '../control';
import type { FakeHub } from './hub';

/** The list the preview starts with: a workspace that has saved a few names. */
export const PREVIEW_VOCABULARY: readonly string[] = [
  'AssemblyAI',
  'Deepgram',
  'Granola',
  'Linkt',
  'Roger',
];

/**
 * The jargon list's part of the preview's `window.roger`: main with a healthy API. It stores a
 * list as `PUT /v1/vocabulary` does and refuses one main would refuse, with main's words. Both
 * answers are marked fromApi with the route main calls, so in the api-offline scenario they fail
 * as main's ApiError for that route, as in the app.
 */
export function createVocabularyFake(hub: FakeHub): VocabularyApi {
  let stored: string[] = [...PREVIEW_VOCABULARY];
  return {
    getVocabulary: () =>
      hub.request(
        vocabularyChannels.VocabularyGet,
        fromApi('GET /v1/vocabulary', () => [...stored]),
      ),
    setVocabulary: (terms) =>
      hub.request(
        vocabularyChannels.VocabularySet,
        fromApi('PUT /v1/vocabulary', () => {
          const problem = vocabularyProblem(terms);
          if (problem !== null) {
            // The words a failed ipcRenderer.invoke rejects with when main refuses the list.
            const channel = vocabularyChannels.VocabularySet;
            throw new Error(
              `Error invoking remote method '${channel}': Error: ${channel} refused: ${problem}`,
            );
          }
          stored = storedLikeTheApi(terms);
          return [...stored];
        }),
      ),
  };
}

/**
 * What the API keeps of a list: each term trimmed as the API trims (trimTerm), the first spelling
 * of a repeat, sorted.
 */
function storedLikeTheApi(terms: readonly string[]): string[] {
  const kept: string[] = [];
  for (const term of terms) {
    if (!kept.some((other) => sameTerm(other, term))) kept.push(trimTerm(term));
  }
  // The API sorts by Postgres lower(); for the preview's ASCII names this is the same order.
  return kept.sort((a, b) => {
    const [left, right] = [a.toLowerCase(), b.toLowerCase()];
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
