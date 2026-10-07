import type { ComponentType } from 'react';

/**
 * Slots are the places other milestones mount UI into the shell, so no mount task edits a shell
 * file. Each mount task owns one file under ./slots/ that names what it mounts where; ./slots.ts
 * joins those files with mergeSlots, and <SlotOutlet> renders one slot. Which task mounts what:
 * docs/plans/M4-notes-and-ai.md, "The app shell".
 */

/** Props of a component in a slot that takes none. */
export type NoProps = Record<string, never>;

/** Props of every meeting-page region: the meeting shown. Regions read the rest themselves. */
export interface MeetingSlotProps {
  meetingId: string;
}

/**
 * Every slot, with its components' props. Only M4-S1 adds a slot, and every slot exists from the
 * start, so the meeting page (M4-S4) and the mount tasks never edit this file.
 */
export interface SlotPropsByName {
  /** Above every page, the setup route included: M2's capture warnings. */
  banner: NoProps;
  /** Home's sections and cards: M2's kept-audio card, M5's Today. */
  home: NoProps;
  /** Settings sections, each with its own heading: M3's jargon list, M4's notes, M5's calendar. */
  settings: NoProps;
  /** The full-window setup route: M2's permission setup. */
  setup: NoProps;
  /** Meeting page: a notice above the meeting (M5's calendar notice). */
  meetingBanner: MeetingSlotProps;
  /** Meeting page: capture status (M2-T20a). */
  meetingCaptureStatus: MeetingSlotProps;
  /** Meeting page: the note about this meeting's kept audio (M2-T20b). */
  meetingAudioNote: MeetingSlotProps;
  /** Meeting page: the capture report after Stop (M2-T20b). */
  meetingCaptureReport: MeetingSlotProps;
  /** Meeting page: the transcript (M3-T9's live transcript panel). */
  meetingTranscript: MeetingSlotProps;
  /** Meeting page: the "My notes" tab (M4-T20). */
  meetingMyNotes: MeetingSlotProps;
  /** Meeting page: the "AI notes" tab (M4-T20). */
  meetingAiNotes: MeetingSlotProps;
  /** Meeting page: chat with the meeting (M4-T20). */
  meetingChat: MeetingSlotProps;
}

export type SlotName = keyof SlotPropsByName;

export interface SlotEntry<Props> {
  /** Unique within its slot; React's key, and named when the component fails. */
  id: string;
  /** Lower comes first; equal orders go by id. */
  order: number;
  component: ComponentType<Props>;
}

/** What one task file mounts: entries for any of the slots. */
export type SlotContributions = {
  readonly [Name in SlotName]?: readonly SlotEntry<SlotPropsByName[Name]>[];
};

/** Every slot's entries, in render order. */
export type Slots = { readonly [Name in SlotName]: readonly SlotEntry<SlotPropsByName[Name]>[] };

/**
 * Joins the task files (by file name, for the error). Throws when one slot gets two entries with
 * one id: React would mix their state up. slotRegistry.test.ts runs this on the real files.
 */
export function mergeSlots(files: Readonly<Record<string, SlotContributions>>): Slots {
  const merge = <Name extends SlotName>(name: Name): SlotEntry<SlotPropsByName[Name]>[] => {
    const owners = new Map<string, string>();
    const entries: SlotEntry<SlotPropsByName[Name]>[] = [];
    for (const [file, contributions] of Object.entries(files)) {
      for (const entry of contributions[name] ?? []) {
        const owner = owners.get(entry.id);
        if (owner !== undefined) {
          throw new Error(
            `slot "${name}" has two entries with id "${entry.id}": ${owner} and ${file}`,
          );
        }
        owners.set(entry.id, file);
        entries.push(entry);
      }
    }
    return entries.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  };
  return {
    banner: merge('banner'),
    home: merge('home'),
    settings: merge('settings'),
    setup: merge('setup'),
    meetingBanner: merge('meetingBanner'),
    meetingCaptureStatus: merge('meetingCaptureStatus'),
    meetingAudioNote: merge('meetingAudioNote'),
    meetingCaptureReport: merge('meetingCaptureReport'),
    meetingTranscript: merge('meetingTranscript'),
    meetingMyNotes: merge('meetingMyNotes'),
    meetingAiNotes: merge('meetingAiNotes'),
    meetingChat: merge('meetingChat'),
  };
}
