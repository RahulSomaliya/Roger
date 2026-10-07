// Stub from M4-S1; owned by M2-T20b.
import { createElement } from 'react';
import {
  HomeKeptAudio,
  MeetingAudioNote,
  MeetingCaptureDetails,
  MeetingResumedNotice,
} from '../../components/capture/CaptureDetails';
import type { MeetingSlotProps, SlotContributions } from '../slotRegistry';

const KeptAudioCard = () => createElement(HomeKeptAudio);
const AudioNote = ({ meetingId }: MeetingSlotProps) =>
  createElement(MeetingAudioNote, { meetingId });
const CaptureDetails = ({ meetingId }: MeetingSlotProps) =>
  createElement(MeetingCaptureDetails, { meetingId });
const ResumedNote = ({ meetingId }: MeetingSlotProps) =>
  createElement(MeetingResumedNotice, { meetingId });

/**
 * What M2-T20b mounts: the kept-audio card (home), the crash-resume notice under the capture status,
 * the audio note, and the echo lines with the capture report. There is no call-detected card: M5-T10's
 * panel renders it (M5 D5). The "Stopped because the call ended" notice is main's `CaptureStatus.notice`,
 * which the shell's banner already shows (app/BannerSlot.tsx).
 * Slot names and their props: ../slotRegistry.ts.
 */
export const contributions: SlotContributions = {
  home: [{ id: 'm2-kept-audio', order: 20, component: KeptAudioCard }],
  // After M2-T20a's status (order 0), which this is part of.
  meetingCaptureStatus: [{ id: 'm2-resumed-notice', order: 10, component: ResumedNote }],
  meetingAudioNote: [{ id: 'm2-audio-note', order: 0, component: AudioNote }],
  meetingCaptureReport: [{ id: 'm2-capture-details', order: 0, component: CaptureDetails }],
};
