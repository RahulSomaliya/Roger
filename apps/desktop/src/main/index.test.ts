import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Importing index.ts starts the app, so these tests read it as text.
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const lines = source.split('\n');

/** Phase 2's slots in file order (phase-2-build-order.md, section 1). */
const SLOTS_IN_FILE_ORDER = [
  'M2-T13',
  'M5-T11 userData',
  'M4-S2',
  'M2-T4 store',
  'M2-T23',
  'M4-T16 notes store',
  'M2-T4 runtime',
  // In the lifecycle's quit-hook list, inside the runtime block: the notes flush runs first.
  'M4-T16 quit',
  'M2-T4 quit',
  'M4-S1',
  'M4-S4b',
  'M3-T8',
  'M4-T16 notes',
  'M5-T9c',
  'M5-T11 lifecycle',
];

const SLOT_MARKER = /^\s*\/\/ \[slot ([^\]]+)\]/;

function lineOf(text: string): number {
  const index = lines.findIndex((line) => line.includes(text));
  if (index === -1) throw new Error(`index.ts has no line with ${text}`);
  return index;
}

describe('the slots in main/index.ts', () => {
  // A task writes under its own marker and never moves one; a marker that moved or went missing
  // turns the next merge into a conflict, or runs a feature before what it needs exists.
  it('keeps every marker, once, in file order', () => {
    const markers = lines.flatMap((line) => SLOT_MARKER.exec(line)?.slice(1, 2) ?? []);
    expect(markers).toEqual(SLOTS_IN_FILE_ORDER);
  });

  it('follows every marker with a blank line, so blocks under two markers never touch', () => {
    const crowded = lines.filter(
      (line, index) => SLOT_MARKER.test(line) && lines[index + 1]?.trim() !== '',
    );
    expect(crowded).toEqual([]);
  });

  it('runs the userData slots before the single-instance lock, which locks that folder', () => {
    const lock = lineOf('app.requestSingleInstanceLock()');
    expect(lineOf('[slot M2-T13]')).toBeLessThan(lock);
    expect(lineOf('[slot M5-T11 userData]')).toBeLessThan(lock);
  });

  it('creates the window after every IPC slot and before the tray slot', () => {
    const window = lineOf('window = createMainWindow(');
    expect(lineOf('[slot M5-T9c]')).toBeLessThan(window);
    expect(lineOf('[slot M5-T11 lifecycle]')).toBeGreaterThan(window);
  });

  // M5-T11: closing the window hides it and Roger runs on in the menu bar. A handler here that
  // quits on the last window, or a second `second-instance` listener, would undo that; both now
  // live in app/windowLifecycle.ts, wired once through startKeepRunning.
  it('leaves window-all-closed, activate and second-instance to app/keepRunning.ts', () => {
    expect(source).not.toMatch(/app\.on\(\s*'(window-all-closed|activate|second-instance)'/);
    expect(source).toContain('startKeepRunning(');
  });

  it('sets the dev data folder through userDataOverride, which leaves the e2e run alone', () => {
    expect(source).toContain('userDataOverride(');
    expect(source).toMatch(/e2eOn: e2e\.on/);
  });
});
