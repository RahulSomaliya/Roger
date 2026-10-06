import { describe, expect, it } from 'vitest';
import { PreviewHub } from '../control';
import { FakeHub } from './hub';
import { createVocabularyFake, PREVIEW_VOCABULARY } from './vocabulary';

describe('the preview vocabulary fake', () => {
  it('starts with a short list, sorted ignoring case as the API sorts it', async () => {
    const vocabulary = createVocabularyFake(new FakeHub());
    const terms = await vocabulary.getVocabulary();
    expect(terms).toEqual(PREVIEW_VOCABULARY);
    expect(terms.length).toBeGreaterThan(0);
    expect(terms).toEqual([...terms].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
  });

  it('stores a list as the API does: trimmed, the first spelling of a repeat, sorted', async () => {
    const vocabulary = createVocabularyFake(new FakeHub());
    const stored = await vocabulary.setVocabulary(['roger', ' Linkt ', 'LINKT', 'AssemblyAI']);
    expect(stored).toEqual(['AssemblyAI', 'Linkt', 'roger']);
    await expect(vocabulary.getVocabulary()).resolves.toEqual(stored);
    await expect(vocabulary.setVocabulary([])).resolves.toEqual([]);
    await expect(vocabulary.getVocabulary()).resolves.toEqual([]);
  });

  it('hands out copies, so the page cannot change what the fake stores', async () => {
    const vocabulary = createVocabularyFake(new FakeHub());
    const terms = await vocabulary.getVocabulary();
    terms.push('Changed');
    await expect(vocabulary.getVocabulary()).resolves.toEqual(PREVIEW_VOCABULARY);
  });

  it('refuses a list past the limits as main does, and keeps the stored list', async () => {
    const vocabulary = createVocabularyFake(new FakeHub());
    await expect(vocabulary.setVocabulary(['Linkt', 'x'.repeat(51)])).rejects.toThrow(
      "Error invoking remote method 'vocabulary:set': Error: vocabulary:set refused: terms[1] is 51 characters long; at most 50",
    );
    await expect(vocabulary.getVocabulary()).resolves.toEqual(PREVIEW_VOCABULARY);
  });

  it("fails both requests with main's ApiError for the route while the API is offline", async () => {
    const hub = new PreviewHub();
    const vocabulary = createVocabularyFake(hub);
    hub.setApiOffline(true);
    await expect(vocabulary.getVocabulary()).rejects.toThrow(
      "Error invoking remote method 'vocabulary:get': ApiError: GET /v1/vocabulary failed: connect ECONNREFUSED 127.0.0.1:8000",
    );
    await expect(vocabulary.setVocabulary([])).rejects.toThrow(
      "Error invoking remote method 'vocabulary:set': ApiError: PUT /v1/vocabulary failed: connect ECONNREFUSED 127.0.0.1:8000",
    );
    hub.setApiOffline(false);
    await expect(vocabulary.getVocabulary()).resolves.toEqual(PREVIEW_VOCABULARY);
  });
});
