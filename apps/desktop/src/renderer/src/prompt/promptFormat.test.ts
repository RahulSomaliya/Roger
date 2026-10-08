import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callDetectedTitle,
  callOverline,
  eventTitle,
  hours,
  overline,
  startLabel,
  stopsLabel,
} from './promptFormat';

const START = '2026-10-07T10:00:00.000Z';
const at = (offsetMs: number): number => Date.parse(START) + offsetMs;
const MIN = 60_000;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('startLabel', () => {
  it('says how far off the start is, rounding up so it never claims less than the wait', () => {
    expect(startLabel(START, at(-MIN))).toBe('Starting in 1 min');
    expect(startLabel(START, at(-61_000))).toBe('Starting in 2 min');
    expect(startLabel(START, at(-10 * MIN))).toBe('Starting in 10 min');
    expect(startLabel(START, at(-5_000))).toBe('Starting in 1 min');
  });

  it('says how long ago it started, rounding down', () => {
    expect(startLabel(START, at(3 * MIN))).toBe('Started 3 min ago');
    expect(startLabel(START, at(3 * MIN + 59_000))).toBe('Started 3 min ago');
    expect(startLabel(START, at(MIN))).toBe('Started 1 min ago');
  });

  it('says "Starting now" at the start and "Started just now" in its first minute', () => {
    expect(startLabel(START, at(0))).toBe('Starting now');
    expect(startLabel(START, at(30_000))).toBe('Started just now');
  });
});

describe('eventTitle and callDetectedTitle', () => {
  const unnamed = { start: START };

  it('names a blank invite the way its meeting will be named: "Meeting at 3:27 pm"', () => {
    vi.stubEnv('TZ', 'Asia/Kolkata');
    expect(new Date(START).getTimezoneOffset()).toBe(-330);
    expect(eventTitle({ title: '', ...unnamed })).toBe('Meeting at 3:30 pm');
    expect(eventTitle({ title: '   ', ...unnamed })).toBe('Meeting at 3:30 pm');
    expect(eventTitle({ title: ' Weekly sync ', ...unnamed })).toBe('Weekly sync');
  });

  it('never says "Untitled meeting"', () => {
    expect(eventTitle({ title: '', ...unnamed })).not.toMatch(/untitled/i);
  });

  it('calls a detected call "Call in Zoom", not a privacy warning', () => {
    expect(callDetectedTitle({ bundleId: 'us.zoom.xos', name: 'Zoom' })).toBe('Call in Zoom');
  });
});

describe('overline', () => {
  it("names Roger, then how far off the start is (Home's startLabel)", () => {
    expect(overline(START, at(-MIN))).toBe('Roger \u00b7 Starting in 1 min');
    expect(overline(START, at(0))).toBe('Roger \u00b7 Starting now');
    expect(overline(START, at(3 * MIN))).toBe('Roger \u00b7 Started 3 min ago');
  });

  it('is "Roger \u00b7 Now" for a call Roger noticed, which has no start', () => {
    expect(callOverline()).toBe('Roger \u00b7 Now');
  });
});

describe('hours', () => {
  it('writes both ends with their period and "to", the form Home uses', () => {
    vi.stubEnv('TZ', 'UTC');
    expect(new Date(START).getTimezoneOffset()).toBe(0);
    expect(hours('2026-10-07T10:00:00.000Z', '2026-10-07T10:30:00.000Z')).toBe(
      '10:00 am to 10:30 am',
    );
  });

  it('keeps both periods across noon and midnight', () => {
    vi.stubEnv('TZ', 'UTC');
    expect(hours('2026-10-07T11:30:00.000Z', '2026-10-07T12:30:00.000Z')).toBe(
      '11:30 am to 12:30 pm',
    );
    expect(hours('2026-10-07T23:30:00.000Z', '2026-10-08T00:15:00.000Z')).toBe(
      '11:30 pm to 12:15 am',
    );
  });

  it('follows the Mac when its time zone changes', () => {
    vi.stubEnv('TZ', 'Asia/Kolkata');
    expect(new Date(START).getTimezoneOffset()).toBe(-330);
    expect(hours('2026-10-07T10:00:00.000Z', '2026-10-07T10:30:00.000Z')).toBe(
      '3:30 pm to 4:00 pm',
    );
  });

  it('has no dash and no narrow no-break space', () => {
    vi.stubEnv('TZ', 'UTC');
    expect(hours('2026-10-07T11:30:00.000Z', '2026-10-07T12:30:00.000Z')).toMatch(/^[\x20-\x7E]+$/);
  });
});

describe('stopsLabel', () => {
  it('names the note a start would stop', () => {
    expect(stopsLabel('Weekly sync')).toBe('Stops notes on Weekly sync');
    expect(stopsLabel(' Weekly sync ')).toBe('Stops notes on Weekly sync');
  });

  it('falls back to "your current notes" while the recording has no title', () => {
    expect(stopsLabel(null)).toBe('Stops your current notes');
    expect(stopsLabel('   ')).toBe('Stops your current notes');
  });
});
