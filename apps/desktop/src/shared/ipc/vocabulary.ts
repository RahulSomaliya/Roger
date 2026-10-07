/**
 * The workspace jargon list's channels. Main registers them in
 * src/main/vocabulary/vocabularyIpc.ts, for the main window's page only, and answers both from the
 * Roger API (`GET` and `PUT /v1/vocabulary`): no copy of the list is kept on the Mac. Add a member
 * here together with its bridge (src/preload/bridges/vocabulary.ts) and its preview fake
 * (preview/fakes/vocabulary.ts): the type check fails until all three agree.
 *
 * Every channel name starts with `vocabulary:`. The preview's offline API fails requests by that
 * prefix (preview/control.ts, API_CHANNEL_PREFIXES; control.test.ts checks it), so a channel named
 * otherwise would keep answering in the api-offline scenario while the app shows an error.
 */
export const vocabularyChannels = {
  /** renderer → main, invoke */
  VocabularyGet: 'vocabulary:get',
  VocabularySet: 'vocabulary:set',
} as const;

/** What `vocabulary:set` carries: the whole list, as `PUT /v1/vocabulary` takes it. */
export interface VocabularySetRequest {
  terms: readonly string[];
}

/** The jargon list's part of `window.roger` (rules and limits: src/shared/vocabulary.ts). */
export interface VocabularyApi {
  /**
   * The list as the API stores it, sorted ignoring case; `[]` when the workspace has none. Rejects
   * with the API's error when it cannot be read: never answer `[]` for that, or an editor that
   * saves what it read would wipe the real list.
   */
  getVocabulary(): Promise<string[]>;
  /**
   * Replaces the whole list and resolves to it as stored: trimmed, repeats that differ only in case
   * dropped (the first spelling wins), in getVocabulary's order. Rejects when main or the API
   * refuses the list (the limits in src/shared/vocabulary.ts) or the API cannot be reached; the
   * stored list is unchanged then.
   */
  setVocabulary(terms: readonly string[]): Promise<string[]>;
}
