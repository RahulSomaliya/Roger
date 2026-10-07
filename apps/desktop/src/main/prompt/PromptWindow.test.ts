import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptPanelState } from '../../shared/ipc/prompt';
import { createLogger } from '../logger';
import type { AppPage } from '../page-policy';
import { PANEL_MARGIN, PANEL_WIDTH, type Rectangle } from './promptBounds';
import { PromptWindow, parsePanelHeight } from './PromptWindow';

// Never a real window: BrowserWindow is a recording stand-in, and `screen` is two displays.
const electron = vi.hoisted(() => {
  interface Display {
    id: number;
    bounds: { x: number; y: number; width: number; height: number };
    workArea: { x: number; y: number; width: number; height: number };
  }
  const world = {
    windows: [] as FakeWindow[],
    cursor: { x: 700, y: 400 },
    displays: [] as Display[],
    failCreate: false,
  };

  class FakeWindow {
    readonly calls: string[] = [];
    visible = false;
    destroyed = false;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    loaded: string | null = null;
    private readonly handlers = new Map<string, ((...args: never[]) => void)[]>();
    private readonly contentHandlers = new Map<string, ((...args: never[]) => void)[]>();
    openHandler: ((details: { url: string }) => { action: string }) | null = null;
    readonly webContents = {
      id: 40 + world.windows.length,
      send: (): void => {
        this.calls.push('send');
      },
      isDestroyed: (): boolean => this.destroyed,
      setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }): void => {
        this.openHandler = handler;
      },
      on: (event: string, listener: (...args: never[]) => void): void => {
        this.contentHandlers.set(event, [...(this.contentHandlers.get(event) ?? []), listener]);
      },
    };
    constructor(readonly options: Record<string, unknown>) {
      if (world.failCreate) throw new Error('cannot create a window');
      world.windows.push(this);
    }
    on(event: string, listener: (...args: never[]) => void): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
    }
    /** An event from the page's webContents, as Electron sends it. */
    emitContent(event: string, ...args: unknown[]): void {
      for (const listener of this.contentHandlers.get(event) ?? []) {
        (listener as (...rest: unknown[]) => void)(...args);
      }
    }
    setAlwaysOnTop(flag: boolean, level: string): void {
      this.calls.push(`setAlwaysOnTop(${String(flag)},${level})`);
    }
    setVisibleOnAllWorkspaces(flag: boolean, options: object): void {
      this.calls.push(`setVisibleOnAllWorkspaces(${String(flag)},${JSON.stringify(options)})`);
    }
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
      this.bounds = bounds;
      this.calls.push('setBounds');
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return this.bounds;
    }
    showInactive(): void {
      this.visible = true;
      this.calls.push('showInactive');
    }
    show(): void {
      this.calls.push('show');
    }
    focus(): void {
      this.calls.push('focus');
    }
    moveTop(): void {
      this.calls.push('moveTop');
    }
    hide(): void {
      this.visible = false;
      this.calls.push('hide');
    }
    isVisible(): boolean {
      return this.visible;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
      this.visible = false;
      this.calls.push('destroy');
      for (const listener of this.handlers.get('closed') ?? []) listener();
    }
    loadURL(url: string): Promise<void> {
      this.loaded = url;
      return Promise.resolve();
    }
    loadFile(path: string): Promise<void> {
      this.loaded = path;
      return Promise.resolve();
    }
  }
  return {
    world,
    BrowserWindow: FakeWindow,
    screen: {
      getCursorScreenPoint: () => world.cursor,
      getAllDisplays: () => world.displays,
    },
  };
});
vi.mock('electron', () => ({
  BrowserWindow: electron.BrowserWindow,
  screen: electron.screen,
}));

const RENDERER_DIR = '/Applications/Roger.app/Contents/Resources/app.asar/out/renderer';
const PACKAGED: AppPage = { devServerUrl: null, rendererDir: RENDERER_DIR };
const DEV: AppPage = { devServerUrl: 'http://localhost:5173/', rendererDir: RENDERER_DIR };

const area = (x: number, y: number, width: number, height: number): Rectangle => ({
  x,
  y,
  width,
  height,
});
const MAIN_DISPLAY = { id: 1, bounds: area(0, 0, 1440, 900), workArea: area(0, 25, 1440, 875) };
const LEFT_DISPLAY = {
  id: 2,
  bounds: area(-1920, -180, 1920, 1080),
  workArea: area(-1920, -155, 1920, 1055),
};

const ONE_CARD: PromptPanelState = {
  cards: [
    {
      kind: 'call_detected',
      id: 'prompt-1',
      phase: 'open',
      error: null,
      app: { bundleId: 'us.zoom.xos', name: 'Zoom' },
    },
  ],
  recording: false,
  recordingTitle: null,
};
const NO_CARDS: PromptPanelState = { cards: [], recording: false, recordingTitle: null };

function harness(page: AppPage = PACKAGED) {
  let state = NO_CARDS;
  let listener: ((next: PromptPanelState) => void) | null = null;
  let unsubscribed = 0;
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    format: 'json',
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const window = new PromptWindow({
    prompts: {
      getState: () => state,
      onChange: (next) => {
        listener = next;
        return () => {
          unsubscribed += 1;
          listener = null;
        };
      },
    },
    page,
    preloadPath: '/app/out/preload/prompt.js',
    logger,
  });
  return {
    window,
    lines,
    unsubscribed: () => unsubscribed,
    /** main's state changes, as PromptService.onChange reports it. */
    change: (next: PromptPanelState): void => {
      state = next;
      listener?.(next);
    },
    /** The state is already set when the window starts, as at app launch. */
    startWith: (next: PromptPanelState): void => {
      state = next;
      window.start();
    },
  };
}

/** The page reporting its card height, as its title. */
const reportHeight = (win: InstanceType<typeof electron.BrowserWindow>, height: number): void => {
  win.emitContent(
    'page-title-updated',
    { preventDefault: () => undefined },
    `roger-prompt-height:${height}`,
  );
};

const only = (): InstanceType<typeof electron.BrowserWindow> => {
  const [first, ...rest] = electron.world.windows;
  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one window, got ${electron.world.windows.length}`);
  }
  return first;
};

beforeEach(() => {
  electron.world.windows.length = 0;
  electron.world.cursor = { x: 700, y: 400 };
  electron.world.displays = [MAIN_DISPLAY, LEFT_DISPLAY];
  electron.world.failCreate = false;
});

describe('parsePanelHeight', () => {
  // main reads what src/renderer/src/prompt/panelHeight.ts writes: the two tests spell it out apart.
  it('reads the height from the page title the page writes', () => {
    expect(parsePanelHeight('roger-prompt-height:140')).toBe(140);
    expect(parsePanelHeight('roger-prompt-height:0')).toBe(0);
  });

  it('ignores every other title, and a height that is not whole digits', () => {
    for (const title of [
      'Roger prompt',
      '',
      'roger-prompt-height:',
      'roger-prompt-height:-5',
      'roger-prompt-height:12.5',
      'roger-prompt-height:abc',
      'roger-prompt-height:140 ',
      'x roger-prompt-height:140',
      'roger-prompt-height:1400000',
    ]) {
      expect(parsePanelHeight(title)).toBeNull();
    }
  });
});

describe('PromptWindow: creating the panel', () => {
  it('builds no window while there are no cards', () => {
    const h = harness();
    h.startWith(NO_CARDS);
    expect(electron.world.windows).toHaveLength(0);
    expect(h.window.panel).toBeNull();
  });

  it('builds one window for the first card: a frameless, transparent, non-focusable panel', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    const win = only();
    expect(win.options).toMatchObject({
      type: 'panel',
      focusable: false,
      acceptFirstMouse: true,
      frame: false,
      transparent: true,
      show: false,
      resizable: false,
      skipTaskbar: true,
      width: PANEL_WIDTH,
    });
    expect(win.options.webPreferences).toEqual({
      preload: '/app/out/preload/prompt.js',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // A hidden window's page is throttled: its height report would never come.
      backgroundThrottling: false,
    });
    expect(h.window.panel).toBe(win);
  });

  it('floats above a full-screen call on every space, without the process-type transform', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    expect(only().calls).toEqual(
      expect.arrayContaining([
        'setAlwaysOnTop(true,screen-saver)',
        'setVisibleOnAllWorkspaces(true,{"visibleOnFullScreen":true,"skipTransformProcessType":true})',
      ]),
    );
  });

  it('loads prompt.html from the bundle, or from the dev server', () => {
    const packaged = harness(PACKAGED);
    packaged.startWith(ONE_CARD);
    expect(only().loaded).toBe(`${RENDERER_DIR}/prompt.html`);

    electron.world.windows.length = 0;
    const dev = harness(DEV);
    dev.startWith(ONE_CARD);
    expect(only().loaded).toBe('http://localhost:5173/prompt.html');
  });

  it('builds the window once, however many states follow', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    h.change({ ...ONE_CARD, recording: true });
    h.change(NO_CARDS);
    h.change(ONE_CARD);
    expect(electron.world.windows).toHaveLength(1);
  });
});

describe('PromptWindow: showing it', () => {
  it('waits for the page to report its height, then shows without taking focus', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    const win = only();
    expect(win.visible).toBe(false);
    reportHeight(win, 150);
    expect(win.visible).toBe(true);
    expect(win.bounds).toEqual({
      x: 1440 - PANEL_WIDTH - PANEL_MARGIN,
      y: 25 + PANEL_MARGIN,
      width: PANEL_WIDTH,
      height: 150,
    });
    // The call keeps focus: show(), focus() and moveTop() all activate Roger.
    expect(win.calls).not.toContain('show');
    expect(win.calls).not.toContain('focus');
    expect(win.calls).not.toContain('moveTop');
    expect(win.calls.filter((call) => call === 'showInactive')).toHaveLength(1);
  });

  it('opens on the display under the cursor, a negative origin included', () => {
    electron.world.cursor = { x: -900, y: 100 };
    const h = harness();
    h.startWith(ONE_CARD);
    reportHeight(only(), 150);
    expect(only().bounds).toEqual({
      x: 0 - PANEL_WIDTH - PANEL_MARGIN,
      y: -155 + PANEL_MARGIN,
      width: PANEL_WIDTH,
      height: 150,
    });
  });

  it('is cut to the display for a stack taller than it', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    reportHeight(only(), 5000);
    expect(only().bounds.height).toBe(875 - 2 * PANEL_MARGIN);
  });

  it('resizes as the cards change, keeping its display when the cursor has moved off it', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    const win = only();
    reportHeight(win, 150);
    electron.world.cursor = { x: -900, y: 100 }; // the cursor moves to the other display
    h.change({ ...ONE_CARD, recording: true });
    reportHeight(win, 300);
    expect(win.bounds.x).toBe(1440 - PANEL_WIDTH - PANEL_MARGIN);
    expect(win.bounds.height).toBe(300);
    expect(win.calls.filter((call) => call === 'showInactive')).toHaveLength(1);
  });

  it('shows at once when its last height is known and a card comes back', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    const win = only();
    reportHeight(win, 150);
    h.change(NO_CARDS);
    expect(win.visible).toBe(false);
    h.change(ONE_CARD);
    expect(win.visible).toBe(true);
    expect(electron.world.windows).toHaveLength(1);
    expect(win.calls).not.toContain('show');
  });

  it('never shows for a late height report once the cards are gone', () => {
    const h = harness();
    h.startWith(NO_CARDS);
    h.change(ONE_CARD);
    const win = only();
    reportHeight(win, 120);
    expect(win.visible).toBe(true);
    h.change(NO_CARDS);
    reportHeight(win, 120);
    expect(win.visible).toBe(false);
  });
});

describe('PromptWindow: hiding it', () => {
  it('hides when the last card goes, and keeps the window for the next one', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    const win = only();
    reportHeight(win, 150);
    h.change(NO_CARDS);
    expect(win.calls).toContain('hide');
    expect(win.destroyed).toBe(false);
  });

  it('hides for a height of 0, which the page reports when it draws nothing', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    const win = only();
    reportHeight(win, 150);
    reportHeight(win, 0);
    expect(win.visible).toBe(false);
  });

  it('ignores titles that are not a height', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    const win = only();
    win.emitContent('page-title-updated', { preventDefault: () => undefined }, 'Roger prompt');
    win.emitContent(
      'page-title-updated',
      { preventDefault: () => undefined },
      'roger-prompt-height:x',
    );
    expect(win.visible).toBe(false);
  });
});

describe('PromptWindow: the page stays on the panel', () => {
  it('opens no new window', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    expect(only().openHandler?.({ url: 'https://evil.example/' })).toEqual({ action: 'deny' });
  });

  it('lets the prompt page reload and blocks every other navigation', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    const win = only();
    const attempt = (url: string): boolean => {
      let prevented = false;
      win.emitContent('will-navigate', { preventDefault: () => (prevented = true), url }, url);
      return prevented;
    };
    expect(attempt(`file://${RENDERER_DIR}/prompt.html`)).toBe(false);
    expect(attempt(`file://${RENDERER_DIR}/index.html`)).toBe(true); // the main page has window.roger
    expect(attempt('https://evil.example/')).toBe(true);
    expect(h.lines.some((line) => line.message === 'prompt panel navigation blocked')).toBe(true);
  });
});

describe('PromptWindow: failures', () => {
  it('drops a window whose page crashed, logs it, and builds a new one for the next change', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    const first = only();
    reportHeight(first, 150);
    first.emitContent('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
    expect(first.destroyed).toBe(true);
    expect(h.window.panel).toBeNull();
    expect(h.lines).toContainEqual(
      expect.objectContaining({
        level: 'error',
        message: 'prompt panel page gone',
        reason: 'crashed',
      }),
    );
    // Not rebuilt on the spot: a page that crashes as it loads would spin. The next change does.
    expect(electron.world.windows).toHaveLength(1);
    h.change({ ...ONE_CARD, recording: true });
    expect(electron.world.windows).toHaveLength(2);
    expect(electron.world.windows[1]?.visible).toBe(false); // its height is not known yet
  });

  it('logs a window that cannot be built, never throws into the service, and tries again next change', () => {
    const h = harness();
    h.startWith(NO_CARDS);
    electron.world.failCreate = true;
    expect(() => {
      h.change(ONE_CARD);
    }).not.toThrow();
    expect(h.lines).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'prompt panel update failed' }),
    );
    electron.world.failCreate = false;
    h.change({ ...ONE_CARD, recording: true });
    expect(electron.world.windows).toHaveLength(1);
  });

  it('logs a placement that fails, and shows nothing at a wrong place', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    electron.world.displays = [];
    reportHeight(only(), 150);
    expect(h.lines).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'prompt panel resize failed' }),
    );
    expect(only().visible).toBe(false);
  });
});

describe('PromptWindow: stop', () => {
  it('stops listening and closes the window', () => {
    const h = harness();
    h.startWith(ONE_CARD);
    const win = only();
    h.window.stop();
    expect(h.unsubscribed()).toBe(1);
    expect(win.destroyed).toBe(true);
    expect(h.window.panel).toBeNull();
  });

  it('can be stopped before it ever built a window, and twice', () => {
    const h = harness();
    h.window.start();
    h.window.stop();
    h.window.stop();
    expect(h.unsubscribed()).toBe(1);
  });
});
