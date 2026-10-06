import { describe, expect, it, vi } from 'vitest';
import { vocabularyBridge } from './vocabulary';

// Electron's ipcRenderer, as far as the bridge helpers (../bridge.ts) use it. Hoisted, because
// vi.mock runs before the imports.
const ipc = vi.hoisted(() => {
  const invoked: unknown[][] = [];
  return {
    invoked,
    renderer: {
      invoke: (...args: unknown[]): Promise<unknown> => {
        invoked.push(args);
        return Promise.resolve([]);
      },
    },
  };
});
vi.mock('electron', () => ({ ipcRenderer: ipc.renderer }));

describe('the vocabulary bridge', () => {
  it('reads with no payload and saves the whole list as { terms }', async () => {
    await vocabularyBridge.getVocabulary();
    await vocabularyBridge.setVocabulary(['Linkt', 'Roger']);
    expect(ipc.invoked).toEqual([
      ['vocabulary:get', undefined],
      ['vocabulary:set', { terms: ['Linkt', 'Roger'] }],
    ]);
  });
});
