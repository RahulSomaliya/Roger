import { readFileSync, writeFileSync } from 'node:fs';
import { errorMessage, type Logger } from '../logger';

/**
 * The main window's size and place. Pure functions plus a tiny JSON file, so they test under Node;
 * window.ts connects Electron's `screen` and BrowserWindow. Nothing was saved before the redesign
 * sweep, so every Mac opens at DEFAULT_WINDOW_SIZE on the first launch with nothing to migrate.
 */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Landscape (Rahul, 2026-10-08). The pages are laid out for it first. */
export const DEFAULT_WINDOW_SIZE = { width: 1080, height: 730 } as const;
/** Narrow still works. Keep in step with `minWidth` / `minHeight` in window.ts (it imports these). */
export const MIN_WINDOW_SIZE = { width: 420, height: 520 } as const;
/** The default leaves this much of the work area free on each side, so it never fills a small display. */
const WORK_AREA_MARGIN = 48;

/** The default window: DEFAULT_WINDOW_SIZE clamped to the work area less the margin, centred in it. */
export function defaultBounds(workArea: Bounds): Bounds {
  const width = Math.max(
    MIN_WINDOW_SIZE.width,
    Math.min(DEFAULT_WINDOW_SIZE.width, workArea.width - 2 * WORK_AREA_MARGIN),
  );
  const height = Math.max(
    MIN_WINDOW_SIZE.height,
    Math.min(DEFAULT_WINDOW_SIZE.height, workArea.height - 2 * WORK_AREA_MARGIN),
  );
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

function isInside(inner: Bounds, outer: Bounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * The saved bounds when they lie wholly inside one connected display's work area, else the default
 * on `fallbackWorkArea`. Wholly, not "touching": a window half off a vanished second display has
 * its title bar out of reach, and there is no way to drag it back.
 */
export function restoreBounds(
  saved: Bounds | null,
  workAreas: readonly Bounds[],
  fallbackWorkArea: Bounds,
): Bounds {
  if (saved !== null && workAreas.some((area) => isInside(saved, area))) return saved;
  return defaultBounds(fallbackWorkArea);
}

/** `value` as saved bounds, or null: four finite numbers, at least the minimum size. */
export function parseSavedBounds(value: unknown): Bounds | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y, width, height } = value as Record<string, unknown>;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    ![x, y, width, height].every(Number.isFinite) ||
    width < MIN_WINDOW_SIZE.width ||
    height < MIN_WINDOW_SIZE.height
  ) {
    return null;
  }
  return { x, y, width, height };
}

/** The file calls the store makes. Tests pass fakes. */
export interface WindowBoundsFiles {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, text: string): void;
}

const NODE_FILES: WindowBoundsFiles = { readFileSync, writeFileSync };

/**
 * The saved bounds, or null when none were saved or the file is unusable (logged, then the default
 * stands: a lost window position is not worth failing a launch for).
 */
export function loadWindowBounds(
  path: string,
  logger: Logger,
  files: WindowBoundsFiles = NODE_FILES,
): Bounds | null {
  let text: string;
  try {
    text = files.readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') {
      logger.warn('window bounds file unreadable; using the default', {
        error: errorMessage(error),
      });
    }
    return null;
  }
  try {
    const bounds = parseSavedBounds(JSON.parse(text));
    if (bounds === null)
      logger.warn('window bounds file holds no usable bounds; using the default');
    return bounds;
  } catch (error) {
    logger.warn('window bounds file is not JSON; using the default', {
      error: errorMessage(error),
    });
    return null;
  }
}

/** Writes the bounds. A failure is logged, not thrown: the window works, only its memory failed. */
export function saveWindowBounds(
  path: string,
  bounds: Bounds,
  logger: Logger,
  files: WindowBoundsFiles = NODE_FILES,
): void {
  try {
    files.writeFileSync(path, JSON.stringify(bounds));
  } catch (error) {
    logger.warn('window bounds could not be saved', { error: errorMessage(error) });
  }
}
