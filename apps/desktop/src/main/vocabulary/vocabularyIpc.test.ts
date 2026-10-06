import { describe, expect, it, vi } from 'vitest';
import { vocabularyChannels } from '../../shared/ipc/vocabulary';
import { VOCABULARY_LIMITS } from '../../shared/vocabulary';
import type { VocabularyRoutes } from '../api/vocabularyClient';
import { ApiError } from '../api/http';
import type { IpcMainLike, SenderEvent, TrustedWindow } from '../ipc/trust';
import { createLogger } from '../logger';
import { registerVocabularyIpc } from './vocabularyIpc';

const MAIN_PAGE = 7;
const PROMPT_PANEL = 9;

/** A client name a log line must never carry. */
const SECRET = 'Acme Holdings';

type Handler = (event: SenderEvent, payload: unknown) => unknown;

function harness(client: Partial<VocabularyRoutes> = {}) {
  const handlers = new Map<string, Handler>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    on: () => undefined,
  };
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) });
  const routes = {
    getVocabulary: vi.fn<VocabularyRoutes['getVocabulary']>(() =>
      Promise.resolve(['Linkt', SECRET]),
    ),
    replaceVocabulary: vi.fn<VocabularyRoutes['replaceVocabulary']>((terms) =>
      Promise.resolve(terms.map((term) => term.trim())),
    ),
    ...client,
  };
  const window: TrustedWindow = { webContents: { id: MAIN_PAGE } };
  registerVocabularyIpc({ ipcMain, client: routes, getWindow: () => window, logger });

  /** Like ipcRenderer.invoke: a handler that throws rejects the page's promise. */
  const invoke = (channel: string, payload?: unknown, senderId = MAIN_PAGE): Promise<unknown> =>
    Promise.resolve().then(() => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`nothing registered on ${channel}`);
      return handler({ sender: { id: senderId } }, payload);
    });

  const logged = (): Record<string, unknown>[] =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  return { routes, lines, logged, invoke };
}

describe('vocabulary:get', () => {
  it("answers the API's list", async () => {
    const h = harness();
    await expect(h.invoke(vocabularyChannels.VocabularyGet)).resolves.toEqual(['Linkt', SECRET]);
    expect(h.routes.getVocabulary).toHaveBeenCalledTimes(1);
  });

  it("passes the API's failure to the page and logs it, never as an empty list", async () => {
    const h = harness({
      getVocabulary: () =>
        Promise.reject(
          new ApiError(0, 'network_error', 'GET /v1/vocabulary failed: connect ECONNREFUSED'),
        ),
    });
    await expect(h.invoke(vocabularyChannels.VocabularyGet)).rejects.toThrow(
      'GET /v1/vocabulary failed: connect ECONNREFUSED',
    );
    expect(h.logged()).toMatchObject([
      {
        level: 'warn',
        message: 'jargon list read failed',
        error: 'GET /v1/vocabulary failed: connect ECONNREFUSED',
      },
    ]);
  });
});

describe('vocabulary:set', () => {
  it('saves the whole list and answers it as the API stored it, logging only counts', async () => {
    const h = harness({ replaceVocabulary: () => Promise.resolve(['Linkt', SECRET]) });
    await expect(
      h.invoke(vocabularyChannels.VocabularySet, { terms: [SECRET, ' Linkt ', 'LINKT'] }),
    ).resolves.toEqual(['Linkt', SECRET]);
    expect(h.logged()).toMatchObject([
      { level: 'info', message: 'jargon list saved', sent: 3, stored: 2 },
    ]);
    expect(h.lines.join('\n')).not.toContain(SECRET);
  });

  it('sends only the terms, whatever else the payload carries', async () => {
    const h = harness();
    await h.invoke(vocabularyChannels.VocabularySet, { terms: ['Linkt'], workspaceId: 'other' });
    expect(h.routes.replaceVocabulary).toHaveBeenCalledWith(['Linkt']);
  });

  it('refuses a payload that is not a list of strings, before the API', async () => {
    const h = harness();
    for (const payload of [
      undefined,
      null,
      'Linkt',
      ['Linkt'],
      {},
      { terms: 'Linkt' },
      { terms: ['Linkt', 3] },
      { terms: [null] },
    ]) {
      await expect(h.invoke(vocabularyChannels.VocabularySet, payload)).rejects.toThrow(
        'vocabulary:set takes { terms: string[] }',
      );
    }
    expect(h.routes.replaceVocabulary).not.toHaveBeenCalled();
  });

  it('refuses an oversized list with the limit it breaks, before the API', async () => {
    const h = harness();
    const many = Array.from({ length: VOCABULARY_LIMITS.maxTerms + 1 }, (_, i) => `term ${i}`);
    const cases: [unknown[], string][] = [
      [many, 'vocabulary:set refused: the list has 101 terms; at most 100'],
      [
        [SECRET, 'x'.repeat(51)],
        'vocabulary:set refused: terms[1] is 51 characters long; at most 50',
      ],
      [
        ['x'.repeat(1_000_000)],
        'vocabulary:set refused: terms[0] is 1000000 characters long; at most 50',
      ],
      [
        Array.from({ length: 17 }, (_, i) => `${i}`.padEnd(50, 'y')),
        'vocabulary:set refused: the terms add up to 850 characters; at most 800 in all',
      ],
      [[SECRET, ''], 'vocabulary:set refused: terms[1] is blank'],
    ];
    for (const [terms, message] of cases) {
      await expect(h.invoke(vocabularyChannels.VocabularySet, { terms })).rejects.toThrow(message);
    }
    expect(h.routes.replaceVocabulary).not.toHaveBeenCalled();
    expect(h.logged().every((line) => line.message === 'jargon list save refused')).toBe(true);
    expect(h.lines).toHaveLength(cases.length);
    expect(h.lines.join('\n')).not.toContain(SECRET);
  });

  it("passes the API's refusal to the page and logs it with the count, never the terms", async () => {
    const h = harness({
      replaceVocabulary: () =>
        Promise.reject(
          new ApiError(422, 'validation_error', 'Invalid request: body.terms[0]: too long'),
        ),
    });
    await expect(h.invoke(vocabularyChannels.VocabularySet, { terms: [SECRET] })).rejects.toThrow(
      'Invalid request: body.terms[0]: too long',
    );
    expect(h.logged()).toMatchObject([
      {
        level: 'warn',
        message: 'jargon list save failed',
        error: 'Invalid request: body.terms[0]: too long',
        sent: 1,
      },
    ]);
    expect(h.lines.join('\n')).not.toContain(SECRET);
  });
});

describe('the vocabulary channels', () => {
  it('answer only the main window: the prompt panel never reads or replaces the list', async () => {
    const h = harness();
    await expect(
      h.invoke(vocabularyChannels.VocabularyGet, undefined, PROMPT_PANEL),
    ).rejects.toThrow('untrusted sender');
    await expect(
      h.invoke(vocabularyChannels.VocabularySet, { terms: [] }, PROMPT_PANEL),
    ).rejects.toThrow('untrusted sender');
    expect(h.routes.getVocabulary).not.toHaveBeenCalled();
    expect(h.routes.replaceVocabulary).not.toHaveBeenCalled();
  });
});
