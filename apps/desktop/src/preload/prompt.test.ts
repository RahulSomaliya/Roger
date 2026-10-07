import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promptChannels } from '../shared/ipc/prompt';

// Electron, as far as the prompt preload uses it. Hoisted, because vi.mock runs before imports.
const electron = vi.hoisted(() => {
  const exposed: { name: string; api: Record<string, unknown> }[] = [];
  const calls: { how: 'invoke' | 'on' | 'removeListener'; channel: string; payload?: unknown }[] =
    [];
  const listeners = new Map<string, ((event: object, payload: unknown) => void)[]>();
  return {
    exposed,
    calls,
    listeners,
    contextBridge: {
      exposeInMainWorld: (name: string, api: Record<string, unknown>): void => {
        exposed.push({ name, api });
      },
    },
    ipcRenderer: {
      invoke: (channel: string, payload: unknown): Promise<unknown> => {
        calls.push({ how: 'invoke', channel, payload });
        return Promise.resolve(null);
      },
      on: (channel: string, listener: (event: object, payload: unknown) => void): void => {
        calls.push({ how: 'on', channel });
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      },
      removeListener: (channel: string): void => {
        calls.push({ how: 'removeListener', channel });
      },
    },
  };
});
vi.mock('electron', () => ({
  contextBridge: electron.contextBridge,
  ipcRenderer: electron.ipcRenderer,
}));

describe('the prompt preload', () => {
  beforeEach(() => {
    electron.calls.length = 0;
  });

  it('exposes window.rogerPrompt and nothing else to the page', async () => {
    await import('./prompt');
    expect(electron.exposed.map((each) => each.name)).toEqual(['rogerPrompt']);
    expect(Object.keys(electron.exposed[0]?.api ?? {}).sort()).toEqual([
      'act',
      'getState',
      'onStateChanged',
    ]);
  });

  it('sends each call on the panel channels, the click as it was given', async () => {
    await import('./prompt');
    const api = electron.exposed[0]?.api as {
      getState(): Promise<unknown>;
      act(request: unknown): Promise<unknown>;
      onStateChanged(listener: (state: unknown) => void): () => void;
    };
    const request = { cardId: 'prompt-1', action: 'take_notes', eventId: 'e1' };
    await api.getState();
    await api.act(request);
    const stop = api.onStateChanged(() => undefined);
    stop();
    expect(electron.calls).toEqual([
      { how: 'invoke', channel: promptChannels.PromptGetState, payload: undefined },
      { how: 'invoke', channel: promptChannels.PromptAct, payload: request },
      { how: 'on', channel: promptChannels.PromptStateChanged },
      { how: 'removeListener', channel: promptChannels.PromptStateChanged },
    ]);
  });

  it('hands the page the state without the IPC event', async () => {
    await import('./prompt');
    const api = electron.exposed[0]?.api as {
      onStateChanged(listener: (state: unknown) => void): () => void;
    };
    const received: unknown[] = [];
    api.onStateChanged((state) => received.push(state));
    const state = { cards: [], recording: false, recordingTitle: null };
    for (const listener of electron.listeners.get(promptChannels.PromptStateChanged) ?? []) {
      listener({ sender: 'main' }, state);
    }
    expect(received).toEqual([state]);
  });
});

/** The runtime modules a file pulls in by relative import, transitively, as absolute paths. */
function localImports(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = readFileSync(entry, 'utf8');
  // `import type` and `export type` are erased by the build, so they never join a chunk.
  const specifiers = [
    ...source.matchAll(/^(?:import|export)\s(?!type\s)[^;]*?from\s+'(\.[^']+)'/gms),
  ];
  for (const [, specifier] of specifiers) {
    if (specifier !== undefined) localImports(resolve(dirname(entry), `${specifier}.ts`), seen);
  }
  return seen;
}

describe('the two preload entries', () => {
  // electron-vite makes a chunk of any module both entries import, and a sandboxed preload cannot
  // require a chunk: see the trap comment in prompt.ts.
  it('share no module, so the build makes no chunk for a sandboxed preload to require', () => {
    const here = (file: string): string => resolve(import.meta.dirname, file);
    const app = localImports(here('index.ts'));
    const prompt = localImports(here('prompt.ts'));
    const shared = [...prompt].filter((file) => app.has(file));
    expect(shared).toEqual([]);
    expect(prompt.size).toBeGreaterThan(1); // it did read the shared channel file
  });
});
