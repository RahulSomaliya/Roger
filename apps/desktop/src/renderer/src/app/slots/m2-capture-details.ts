// Stub from M4-S1; owned by M2-T20b.
import { createElement } from 'react';
import {
  MeetingCaptureDetails,
  MeetingGapLine,
  MeetingResumedNotice,
} from '../../components/capture/CaptureDetails';
import type { MeetingSlotProps, SlotContributions } from '../slotRegistry';

const GapNote = ({ meetingId }: MeetingSlotProps) => createElement(MeetingGapLine, { meetingId });
const Details = ({ meetingId }: MeetingSlotProps) =>
  createElement(MeetingCaptureDetails, { meetingId });
const ResumedNote = ({ meetingId }: MeetingSlotProps) =>
  createElement(MeetingResumedNotice, { meetingId });

/**
 * What M2-T20b mounts: the gap line under the meeting header, the crash-resume line after it, and
 * the content of the Details dialog (sources, counts, recoveries, echo lines, the capture report,
 * the kept audio). Nothing on Home: transcribing again starts on its own, and a meeting with a
 * gap says so on its own page. There is no call-detected card: M5-T10's panel renders it (M5 D5).
 * The "Stopped because the call ended" notice is main's `CaptureStatus.notice`, which the shell's
 * banner already shows (app/BannerSlot.tsx).
 * Slot names and their props: ../slotRegistry.ts.
 */
export const contributions: SlotContributions = {
  // Equal orders go by id: M2's refused-lines line (order 0) and M5's consent line come first.
  meetingBanner: [{ id: 'm2-resumed-notice', order: 10, component: ResumedNote }],
  meetingAudioNote: [{ id: 'm2-gap-line', order: 0, component: GapNote }],
  meetingCaptureReport: [{ id: 'm2-capture-details', order: 0, component: Details }],
};
