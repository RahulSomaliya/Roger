import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger';
import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  defaultBounds,
  loadWindowBounds,
  parseSavedBounds,
  restoreBounds,
  saveWindowBounds,
  type WindowBoundsFiles,
} from './windowBounds';

const display1280 = { x: 0, y: 25, width: 1280, height: 775 };
const display1440 = { x: 0, y: 25, width: 1440, height: 875 };
const rightDisplay = { x: 1440, y: 0, width: 1920, height: 1080 };
const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

describe('defaultBounds', () => {
  it('is 1080 x 730 centred in a roomy work area', () => {
    expect(defaultBounds(display1440)).toEqual({
      x: 180,
      y: 25 + Math.round((875 - 730) / 2),
      ...DEFAULT_WINDOW_SIZE,
    });
  });

  it('is clamped to the work area less 48 px each way on a 1280 x 800 display', () => {
    const bounds = defaultBounds(display1280);
    expect(bounds.width).toBe(1080);
    expect(bounds.height).toBe(775 - 96);
    expect(bounds.x).toBe(100);
    expect(bounds.y).toBe(25 + 48);
  });

  it('never goes under the minimum, even on a tiny work area', () => {
    const bounds = defaultBounds({ x: 0, y: 0, width: 400, height: 500 });
    expect(bounds.width).toBe(MIN_WINDOW_SIZE.width);
    expect(bounds.height).toBe(MIN_WINDOW_SIZE.height);
  });
});

describe('restoreBounds', () => {
  it('restores saved bounds that sit inside a connected display', () => {
    const saved = { x: 1500, y: 100, width: 900, height: 600 };
    expect(restoreBounds(saved, [display1440, rightDisplay], display1440)).toEqual(saved);
  });

  it('falls back to the default when the display it was on is gone', () => {
    const saved = { x: 1500, y: 100, width: 900, height: 600 };
    expect(restoreBounds(saved, [display1440], display1440)).toEqual(defaultBounds(display1440));
  });

  it('falls back when the window only half fits (it would hang off the screen)', () => {
    const saved = { x: 1000, y: 100, width: 900, height: 600 };
    expect(restoreBounds(saved, [display1440], display1440)).toEqual(defaultBounds(display1440));
  });

  it('falls back when nothing was saved', () => {
    expect(restoreBounds(null, [display1440], display1440)).toEqual(defaultBounds(display1440));
  });
});

describe('parseSavedBounds', () => {
  it('accepts four finite numbers at or over the minimum size', () => {
    expect(parseSavedBounds({ x: 1, y: 2, width: 500, height: 600 })).toEqual({
      x: 1,
      y: 2,
      width: 500,
      height: 600,
    });
  });

  it.each([
    null,
    'x',
    { x: 1, y: 2, width: 500 },
    { x: 1, y: 2, width: 'a', height: 600 },
    { x: 1, y: 2, width: 100, height: 600 },
    { x: Number.NaN, y: 2, width: 500, height: 600 },
  ])('refuses %j', (value) => {
    expect(parseSavedBounds(value)).toBeNull();
  });
});

function fakeFiles(initial: string | null): WindowBoundsFiles & { text: string | null } {
  const files = {
    text: initial,
    readFileSync: (): string => {
      if (files.text === null) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return files.text;
    },
    writeFileSync: (_path: string, text: string): void => {
      files.text = text;
    },
  };
  return files;
}

describe('the bounds file', () => {
  it('round-trips', () => {
    const files = fakeFiles(null);
    const bounds = { x: 10, y: 20, width: 800, height: 600 };
    saveWindowBounds('/u/window-bounds.json', bounds, logger, files);
    expect(loadWindowBounds('/u/window-bounds.json', logger, files)).toEqual(bounds);
  });

  it('reads as nothing saved when the file is missing, torn or wrong', () => {
    expect(loadWindowBounds('/p', logger, fakeFiles(null))).toBeNull();
    expect(loadWindowBounds('/p', logger, fakeFiles('{"x":'))).toBeNull();
    expect(loadWindowBounds('/p', logger, fakeFiles('{"x":1}'))).toBeNull();
  });
});
