import {
  vocabularyChannels,
  type VocabularyApi,
  type VocabularySetRequest,
} from '../../shared/ipc/vocabulary';
import { invoke } from '../bridge';

/**
 * The jargon list's part of `window.roger`. Main checks the list again before it reaches the API
 * (main/vocabulary/vocabularyIpc.ts).
 */
export const vocabularyBridge: VocabularyApi = {
  getVocabulary: () => invoke(vocabularyChannels.VocabularyGet),
  setVocabulary: (terms) => {
    const request: VocabularySetRequest = { terms };
    return invoke(vocabularyChannels.VocabularySet, request);
  },
};
