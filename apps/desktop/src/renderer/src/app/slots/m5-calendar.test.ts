import { describe, expect, it } from 'vitest';
import { CalendarSettings } from '../../calendar/CalendarSettings';
import { NoticeBanner } from '../../calendar/NoticeBanner';
import { TodaySection } from '../../calendar/TodaySection';
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
  it('mounts Today in Home and the calendar section in Settings', () => {
    expect(only(contributions.home, 'home').component).toBe(TodaySection);
    expect(only(contributions.settings, 'settings').component).toBe(CalendarSettings);
    // The calendar's health is a line in Today (R1), not a banner above every page.
    expect(contributions.banner ?? []).toEqual([]);
  });

  it("mounts the consent notice in the meeting page's banner slot", () => {
    expect(only(contributions.meetingBanner, 'meetingBanner').component).toBe(NoticeBanner);
  });

  // Settings runs by order: M3's jargon list is 10; the calendar follows it.
  it('keeps its ids unique to M5 and Settings after the jargon list', () => {
    const ids = [
      only(contributions.home, 'home').id,
      only(contributions.settings, 'settings').id,
      only(contributions.meetingBanner, 'meetingBanner').id,
    ];
    for (const id of ids) expect(id.startsWith('m5-')).toBe(true);
    expect(only(contributions.settings, 'settings').order).toBeGreaterThan(10);
  });

  it("shows in the merged shell, after M3's Settings section", () => {
    expect(slots.home.map((entry) => entry.id)).toContain('m5-today');
    expect(slots.settings.map((entry) => entry.id)).toEqual(['m3-vocabulary', 'm5-calendar']);
    // M2's lines under the header (refused lines, the crash resume) share the slot (R3).
    expect(slots.meetingBanner.map((entry) => entry.id)).toContain('m5-calendar-notice');
    expect(slots.banner.map((entry) => entry.id)).not.toContain('m5-calendar-status');
  });
});
