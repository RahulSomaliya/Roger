import { describe, expect, it } from 'vitest';
import { mergeSlots, type SlotContributions } from './slotRegistry';
import { slots } from './slots';

const Banner = () => null;
const Section = () => null;
const Region = ({ meetingId }: { meetingId: string }) => (meetingId === '' ? null : null);

describe('mergeSlots', () => {
  it("joins every task file's entries per slot, by order and then id", () => {
    const m2: SlotContributions = {
      banner: [{ id: 'warnings', order: 10, component: Banner }],
      home: [{ id: 'audio-kept', order: 20, component: Section }],
    };
    const m5: SlotContributions = {
      home: [
        { id: 'today', order: 10, component: Section },
        { id: 'coming-up', order: 20, component: Section },
      ],
      meetingBanner: [{ id: 'calendar', order: 0, component: Region }],
    };

    const merged = mergeSlots({ 'm2-capture-status': m2, 'm5-calendar': m5 });
    expect(merged.banner.map((entry) => entry.id)).toEqual(['warnings']);
    expect(merged.home.map((entry) => entry.id)).toEqual(['today', 'audio-kept', 'coming-up']);
    expect(merged.meetingBanner.map((entry) => entry.component)).toEqual([Region]);
  });

  it('gives every slot a list, empty when no file mounts into it', () => {
    const merged = mergeSlots({ empty: {} });
    expect(Object.keys(merged).sort()).toEqual(
      [
        'banner',
        'home',
        'settings',
        'setup',
        'meetingBanner',
        'meetingCaptureStatus',
        'meetingAudioNote',
        'meetingCaptureReport',
        'meetingTranscript',
        'meetingMyNotes',
        'meetingAiNotes',
        'meetingChat',
      ].sort(),
    );
    for (const entries of Object.values(merged)) expect(entries).toEqual([]);
  });

  it('refuses two entries with one id in one slot, naming both files', () => {
    expect(() =>
      mergeSlots({
        'm3-transcript': { settings: [{ id: 'jargon', order: 0, component: Section }] },
        'm4-notes': { settings: [{ id: 'jargon', order: 1, component: Section }] },
      }),
    ).toThrow('slot "settings" has two entries with id "jargon": m3-transcript and m4-notes');
  });

  it('lets two slots use the same id', () => {
    const merged = mergeSlots({
      'm5-calendar': {
        home: [{ id: 'calendar', order: 0, component: Section }],
        settings: [{ id: 'calendar', order: 0, component: Section }],
      },
    });
    expect(merged.home).toHaveLength(1);
    expect(merged.settings).toHaveLength(1);
  });
});

describe('slots', () => {
  // A clash would throw when the page loads and leave the window blank mid-call; here it fails
  // make check instead.
  it("merges every mount task's file without a clash", () => {
    expect(Object.keys(slots)).toHaveLength(12);
  });
});
