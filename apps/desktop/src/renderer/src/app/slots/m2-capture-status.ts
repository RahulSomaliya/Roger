// Stub from M4-S1; owned by M2-T20a.
import { createElement, Fragment } from 'react';
import { refusedLinesProblem } from '../../components/capture/captureProblems';
import { ProblemLine } from '../../components/capture/ProblemLine';
import { StatusLine } from '../../components/capture/StatusLine';
import { WarningBanner } from '../../components/capture/WarningBanner';
import { useNow } from '../../calendar/useCalendar';
import { captureStatusFor } from '../../meeting/liveMeeting';
import { useShell } from '../ShellContext';
import type { MeetingSlotProps, SlotContributions } from '../slotRegistry';

/**
 * Main's loud capture warnings and the lines the server refused for good, as problem lines above
 * every page: a cut or a loss must reach the user wherever they are, so these read main's status as
 * it is, never one meeting's. Main ends every spell at Stop. Refused lines stay until someone deals
 * with them (they are counted across the whole Mac), so they show here after Stop, on Home and in
 * Settings too: house rule 1, the user always sees when a call is not being saved.
 *
 * Not on the page of the meeting that main describes: its header says the same in its status line
 * (MeetingCaptureStatus, below, for warnings) and under it (RefusedLines, for refused lines). Both
 * would say it twice, and a banner above the page would push the editor down under the person's
 * cursor mid-call. They must agree on `captureStatusFor`: a page the header does not describe
 * (another meeting's, the next one starting) has no line, so the banner says it there. Change this
 * test and those two in one commit, or a line shows twice or not at all.
 */
function CaptureWarnings() {
  const { capture, captureMeeting, route } = useShell();
  const headerSaysIt =
    route.name === 'meeting' &&
    captureStatusFor(route.meetingId, captureMeeting, capture.status) !== null;
  if (headerSaysIt) return null;
  const refused = capture.status === null ? null : refusedLinesProblem(capture.status.upload);
  return createElement(
    Fragment,
    null,
    createElement(WarningBanner, { warnings: capture.status?.warnings ?? [] }),
    refused === null ? null : createElement(ProblemLine, { loud: true, children: refused }),
  );
}

/**
 * The meeting header's status line for the meeting this page shows: "Recording · 12m", or a loud
 * problem in its place. captureStatusFor picks the status: main's while it records this meeting,
 * the idle one after its Stop, and nothing while main describes another meeting (the next one
 * starting from this page). Every 15 s, not every second: the line counts whole minutes, and a
 * seconds counter is motion that never stops (docs/design.md, Recording chip).
 */
function MeetingCaptureStatus({ meetingId }: MeetingSlotProps) {
  const { capture, captureMeeting } = useShell();
  const nowMs = useNow(15_000);
  const status = captureStatusFor(meetingId, captureMeeting, capture.status);
  if (status === null) return null;
  return createElement(StatusLine, {
    phase: status.phase,
    startedAt: status.startedAt,
    nowMs,
    warnings: status.warnings ?? [],
  });
}

/**
 * Lines the server refused for good (house rule 1), under the header of the meeting main describes.
 * Every other page says it in the banner (CaptureWarnings, above): decide both through
 * `captureStatusFor`, or the line shows twice or not at all.
 */
function RefusedLines({ meetingId }: MeetingSlotProps) {
  const { capture, captureMeeting } = useShell();
  const status = captureStatusFor(meetingId, captureMeeting, capture.status);
  const problem = status === null ? null : refusedLinesProblem(status.upload);
  return problem === null ? null : createElement(ProblemLine, { loud: true, children: problem });
}

/**
 * What M2-T20a mounts: the loud capture warnings and refused lines (banner), the meeting's status
 * line and the line for refused lines under its header. A banner entry makes the shell draw its banner box on every page, even with nothing
 * in it.
 * Slot names and their props: ../slotRegistry.ts.
 */
export const contributions: SlotContributions = {
  banner: [{ id: 'm2-capture-warnings', order: 0, component: CaptureWarnings }],
  meetingCaptureStatus: [{ id: 'm2-capture-status', order: 0, component: MeetingCaptureStatus }],
  // Equal orders go by id, and `m2-` sorts before M5's consent line: a loss comes first.
  meetingBanner: [{ id: 'm2-upload-refused', order: 0, component: RefusedLines }],
};
