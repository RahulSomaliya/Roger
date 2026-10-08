import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prefsChannels } from '../../shared/ipc/prefs';
import { APP_PREFERENCES } from '../../shared/preferences';
import type { IpcMainLike, SenderEvent } from '../ipc/trust';
import { createLogger } from '../logger';
import { PreferencesStore } from './PreferencesStore';
import { registerPreferencesIpc, type PreferencesWindow } from './preferences-ipc';

const MAIN_PAGE = 7;
const PROMPT_PANEL = 9;

type Handler = (event: SenderEvent, payload: unknown) => unknown;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roger-prefs-ipc-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const handlers = new Map<string, Handler>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    on: () => undefined,
  };
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) });
  const store = new PreferencesStore({ path: join(dir, 'preferences.json'), logger });
  store.register(APP_PREFERENCES);

  const sent: [string, unknown][] = [];
  let destroyed = false;
  let window: PreferencesWindow | null = {
    isDestroyed: () => destroyed,
    webContents: {
      id: MAIN_PAGE,
      send: (channel, payload) => {
        sent.push([channel, payload]);
      },
    },
  };
  registerPreferencesIpc({ ipcMain, store, getWindow: () => window, logger });

  /** Like ipcRenderer.invoke: a handler that throws rejects the page's promise. */
  const invoke = (channel: string, senderId: number, payload?: unknown): Promise<unknown> =>
    Promise.resolve().then(() => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`nothing registered on ${channel}`);
      return handler({ sender: { id: senderId } }, payload);
    });

  return {
    store,
    sent,
    lines,
    invoke,
    closeWindow: () => {
      window = null;
    },
    destroyWindow: () => {
      destroyed = true;
    },
  };
}

describe('the preferences IPC', () => {
  it('answers get-all with every registered preference', async () => {
    const h = harness();
    h.store.set('theme', 'dark');
    await expect(h.invoke(prefsChannels.PrefsGetAll, MAIN_PAGE)).resolves.toEqual({
      theme: 'dark',
    });
  });

  it('saves a set and sends one prefs:changed to the main window', async () => {
    const h = harness();
    await expect(
      h.invoke(prefsChannels.PrefsSet, MAIN_PAGE, { key: 'theme', value: 'light' }),
    ).resolves.toBeUndefined();
    expect(h.store.get('theme')).toBe('light');
    expect(h.sent).toEqual([[prefsChannels.PrefsChanged, { key: 'theme', value: 'light' }]]);
  });

  it('refuses an unknown key or a bad value naming the key, and logs it', async () => {
    const h = harness();
    await expect(
      h.invoke(prefsChannels.PrefsSet, MAIN_PAGE, { key: 'colour', value: 'dark' }),
    ).rejects.toThrow('unknown preference "colour"');
    await expect(
      h.invoke(prefsChannels.PrefsSet, MAIN_PAGE, { key: 'theme', value: 'sepia' }),
    ).rejects.toThrow('theme must be one of system, light or dark (got "sepia")');
    expect(h.sent).toEqual([]);
    expect(h.lines.map((line) => JSON.parse(line) as unknown)).toMatchObject([
      { level: 'warn', message: 'preference set refused', error: 'unknown preference "colour"' },
      { level: 'warn', message: 'preference set refused' },
    ]);
  });

  it('refuses a set that is not a key and a value', async () => {
    const h = harness();
    for (const payload of [undefined, 'theme', ['theme', 'dark'], { key: 'theme' }]) {
      await expect(h.invoke(prefsChannels.PrefsSet, MAIN_PAGE, payload)).rejects.toThrow(
        'prefs:set takes { key, value }',
      );
    }
    expect(h.store.get('theme')).toBe('system');
  });

  it('ignores untrusted senders', async () => {
    const h = harness();
    await expect(h.invoke(prefsChannels.PrefsGetAll, PROMPT_PANEL)).rejects.toThrow(
      'untrusted sender',
    );
    await expect(
      h.invoke(prefsChannels.PrefsSet, PROMPT_PANEL, { key: 'theme', value: 'dark' }),
    ).rejects.toThrow('untrusted sender');
    expect(h.store.get('theme')).toBe('system');
    expect(h.sent).toEqual([]);
  });

  it('sends a change made in main to the page as well', () => {
    const h = harness();
    h.store.set('theme', 'light');
    expect(h.sent).toEqual([[prefsChannels.PrefsChanged, { key: 'theme', value: 'light' }]]);
  });

  it('sends nothing while the window is closed or destroyed, and the set still saves', () => {
    const h = harness();
    h.destroyWindow();
    h.store.set('theme', 'dark');
    h.closeWindow();
    h.store.set('theme', 'light');
    expect(h.sent).toEqual([]);
    expect(h.store.get('theme')).toBe('light');
  });
});
