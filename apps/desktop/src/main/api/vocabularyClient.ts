import { isTermList } from '../../shared/vocabulary';
import { ApiError, type ApiConnection, type ApiRequest, createApiRequest } from './http';

const PATH = '/v1/vocabulary';

/**
 * Typed client for the workspace jargon list (docs/api-contract.md, "Vocabulary"), on the shared
 * HTTP core in ./http.ts. Its answers are checked, not only cast: the editor lists the terms it
 * gets, and a body without them would break the page instead of showing an error.
 */
export class VocabularyClient {
  private readonly request: ApiRequest;

  constructor(connection: ApiConnection) {
    this.request = createApiRequest(connection);
  }

  /** The list as the API stores it, sorted ignoring case; `[]` when the workspace has none. */
  async getVocabulary(): Promise<string[]> {
    return termsOf(await this.request<unknown>('GET', PATH), 'GET');
  }

  /**
   * Replaces the whole list and answers it as stored: each term trimmed, repeats that differ in
   * case dropped (the first spelling wins), in `getVocabulary`'s order. A list past the limits is
   * the API's 422, and nothing is stored.
   */
  async replaceVocabulary(terms: readonly string[]): Promise<string[]> {
    return termsOf(await this.request<unknown>('PUT', PATH, { terms }), 'PUT');
  }
}

/** The client as the vocabulary IPC uses it; a test fake typed by it needs no cast. */
export type VocabularyRoutes = Pick<VocabularyClient, 'getVocabulary' | 'replaceVocabulary'>;

/** `GET` and `PUT` both answer `{"terms": [...]}` (docs/api-contract.md). */
function termsOf(body: unknown, method: 'GET' | 'PUT'): string[] {
  const terms = typeof body === 'object' && body !== null && 'terms' in body ? body.terms : null;
  if (!isTermList(terms)) {
    throw new ApiError(200, 'invalid_response', `${method} ${PATH} returned no list of terms`);
  }
  return terms;
}
