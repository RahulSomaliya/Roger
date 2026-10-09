import { describe, expect, it } from 'vitest';
import { CalendarSettings } from '../../calendar/CalendarSettings';
import type { SlotEntry } from '../slotRegistry';
import { slots } from '../slots';
import { contributions } from './m5-calendar';

function only<Props>(entries: readonly SlotEntry<Props>[] | undefined, slot: string) {
  const [entry] = entries ?? [];
  if (entries?.length !== 1 || entry === undefined) {
    throw new Error(`M5-T13 mounts exactly one entry in ${slot}`);
  }
  return entry;
}

describe("M5-T13's mounts", () => {
  it('mounts the calendar section in Settings (HomePage mounts Today itself)', () => {
    expect(only(contributions.settings, 'settings').component).toBe(CalendarSettings);
    // The calendar's health is a line in Today (R1), not a banner above every page.
    expect(contributions.banner ?? []).toEqual([]);
  });

  // 2026-10-08: the call notice is gone; M5 mounts nothing on the meeting page.
  it('mounts nothing in the meeting page banner slot', () => {
    expect(contributions.meetingBanner ?? []).toEqual([]);
  });

  // Settings runs by order: the calendar (5) comes before M3's jargon list (10), as a person
  // comes for them (sweep section 4).
  it('keeps its ids unique to M5 and Settings before the jargon list', () => {
    expect(only(contributions.settings, 'settings').id.startsWith('m5-')).toBe(true);
    expect(only(contributions.settings, 'settings').order).toBeLessThan(10);
  });

  it("shows in the merged shell, before M3's Settings section", () => {
    expect(slots.settings.map((entry) => entry.id)).toEqual(['m5-calendar', 'm3-vocabulary']);
    // M2's lines under the header (refused lines, the crash resume) share the slot (R3).
    expect(slots.meetingBanner.map((entry) => entry.id)).not.toContain('m5-calendar-notice');
    expect(slots.banner.map((entry) => entry.id)).not.toContain('m5-calendar-status');
  });
});
