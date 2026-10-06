import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { appChannels, type AppRoute } from '../shared/ipc/app';
import type { IpcMainLike, SenderEvent } from './ipc/trust';
import { createLogger } from './logger';
import { NAVIGATE_HOLD_MS, registerNavigation, type NavigableWindow } from './navigation';

const MAIN_PAGE = 7;
const OTHER_PAGE = 9;
const MEETING: AppRoute = 'meeting/0b6f1c5e-3f7a-4c1e-9d2b-6a8e4f1d2c3b';

type Listener = (event: SenderEvent, payload: unknown) => void;

/** The main window as navigation.ts sees it: a page that can be sent to, reload and crash. */
function fakeWindow(id: number) {
  const sent: unknown[] = [];
  const webContents = Object.assign(new EventEmitter(), {
    id,
    destroyed: false,
    send: (channel: string, payload: unknown) => {
      if (channel === appChannels.AppNavigate) sent.push(payload);
    },
    isDestroyed: () => webContents.destroyed,
  });
  const window: NavigableWindow = { webContents };
  return {
    window,
    webContents,
    /** Every route this page was sent. */
    sent,
    /** A reload, or any load of a new document into the main frame. */
    reload: () => {
      webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    },
  };
}

function harness() {
  const listeners = new Map<string, Listener>();
  const ipcMain: IpcMainLike = {
    handle: () => {
      throw new Error('navigation registers no invoke handler');
    },
    on: (channel, listener) => listeners.set(channel, listener),
  };
  let window: NavigableWindow | null = null;
  let now = 1_000_000;
  const lines: string[] = [];
  const navigation = registerNavigation({
    ipcMain,
    getWindow: () => window,
    logger: createLogger({ level: 'debug', format: 'json', sink: (line) => lines.push(line) }),
    now: () => now,
  });
  return {
    navigation,
    lines,
    open: (page: ReturnType<typeof fakeWindow>) => {
      window = page.window;
    },
    close: () => {
      window = null;
    },
    /** The renderer's appReady() from the page with this webContents id. */
    ready: (senderId: number) => {
      const listener = listeners.get(appChannels.AppReady);
      if (!listener) throw new Error('app:ready is not registered');
      listener({ sender: { id: senderId } }, null);
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('registerNavigation', () => {
  it('a navigate sent before the page loads is delivered once, after load', () => {
    const h = harness();
    const page = fakeWindow(MAIN_PAGE);
    h.open(page);

    h.navigation.navigate('settings');
    expect(page.sent).toEqual([]);

    h.ready(MAIN_PAGE);
    expect(page.sent).toEqual(['settings']);
    // React's StrictMode, or a second listener, may say ready again: nothing is sent twice.
    h.ready(MAIN_PAGE);
    expect(page.sent).toEqual(['settings']);
  });

  it('sends at once while the page is ready', () => {
    const h = harness();
    const page = fakeWindow(MAIN_PAGE);
    h.open(page);
    h.ready(MAIN_PAGE);

    h.navigation.navigate(MEETING);
    h.navigation.navigate('home');
    expect(page.sent).toEqual([MEETING, 'home']);
  });

  it(`drops a route that waited more than ${NAVIGATE_HOLD_MS / 1000} s for the page, and says so`, () => {
    const h = harness();
    const page = fakeWindow(MAIN_PAGE);
    h.open(page);

    h.navigation.navigate('setup');
    h.advance(NAVIGATE_HOLD_MS + 1);
    h.ready(MAIN_PAGE);
    expect(page.sent).toEqual([]);
    expect(
      h.lines.some((line) => line.includes('"route":"setup"') && line.includes('dropped')),
    ).toBe(true);
  });

  it('delivers a route that waited exactly the limit', () => {
    const h = harness();
    const page = fakeWindow(MAIN_PAGE);
    h.open(page);

    h.navigation.navigate('setup');
    h.advance(NAVIGATE_HOLD_MS);
    h.ready(MAIN_PAGE);
    expect(page.sent).toEqual(['setup']);
  });

  it('keeps only the latest route while the page is not ready', () => {
    const h = harness();
    const page = fakeWindow(MAIN_PAGE);
    h.open(page);

    h.navigation.navigate('settings');
    h.navigation.navigate(MEETING);
    h.ready(MAIN_PAGE);
    expect(page.sent).toEqual([MEETING]);
  });

  it('refuses app:ready from any other page, and logs it', () => {
    const h = harness();
    const page = fakeWindow(MAIN_PAGE);
    h.open(page);

    h.navigation.navigate('settings');
    h.ready(OTHER_PAGE);
    expect(page.sent).toEqual([]);
    expect(
      h.lines.some((line) => line.includes('ipc message from unexpected sender ignored')),
    ).toBe(true);

    h.ready(MAIN_PAGE);
    expect(page.sent).toEqual(['settings']);
  });

  it('holds routes while the page reloads, until the new page is ready', () => {
    const h = harness();
    const page = fakeWindow(MAIN_PAGE);
    h.open(page);
    h.ready(MAIN_PAGE);

    page.reload();
    h.navigation.navigate('settings');
    expect(page.sent).toEqual([]);

    h.ready(MAIN_PAGE);
    expect(page.sent).toEqual(['settings']);
  });

  it('stays ready through a same-document or a subframe navigation', () => {
    const h = harness();
    const page = fakeWindow(MAIN_PAGE);
    h.open(page);
    h.ready(MAIN_PAGE);

    page.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    page.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    h.navigation.navigate('settings');
    expect(page.sent).toEqual(['settings']);
  });

  it('holds routes after the renderer is gone, until a page is ready again', () => {
    const h = harness();
    const page = fakeWindow(MAIN_PAGE);
    h.open(page);
    h.ready(MAIN_PAGE);

    page.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    h.navigation.navigate('home');
    expect(page.sent).toEqual([]);

    h.ready(MAIN_PAGE);
    expect(page.sent).toEqual(['home']);
  });

  it('holds routes while no window is open, and gives them to the next window once ready', () => {
    const h = harness();
    const first = fakeWindow(MAIN_PAGE);
    h.open(first);
    h.ready(MAIN_PAGE);
    h.close();

    h.navigation.navigate('settings');
    const second = fakeWindow(OTHER_PAGE);
    h.open(second);
    // The new window's page has not said ready yet; the old page's ready does not count for it.
    h.navigation.navigate('setup');
    expect(second.sent).toEqual([]);

    h.ready(OTHER_PAGE);
    expect(second.sent).toEqual(['setup']);
    expect(first.sent).toEqual([]);
  });

  it('holds routes while the window is being destroyed', () => {
    const h = harness();
    const page = fakeWindow(MAIN_PAGE);
    h.open(page);
    h.ready(MAIN_PAGE);

    page.webContents.destroyed = true;
    h.navigation.navigate('settings');
    expect(page.sent).toEqual([]);
  });

  it('refuses a route outside the closed set, naming it', () => {
    const h = harness();
    h.open(fakeWindow(MAIN_PAGE));
    h.ready(MAIN_PAGE);

    expect(() => {
      h.navigation.navigate('meeting/not-a-meeting-id');
    }).toThrow('meeting/not-a-meeting-id');
  });
});
