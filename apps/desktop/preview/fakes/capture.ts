import {
  type CaptureReport,
  type CaptureStatus,
  idleCaptureStatus,
  type StartCaptureRequest,
  storedMeetingText,
  type TranscriptSegmentChange,
} from '../../src/shared/capture';
import { captureChannels, type CaptureApi } from '../../src/shared/ipc/capture';
import type { FakeHub } from './hub';

/**
 * Capture's part of the preview's `window.roger`. Every status it answers or sends starts from
 * idleCaptureStatus(), so it carries every field main's does, the cost guards' `streams`
 * (`paused`, `retrying`), `streamMessages`, `meter` and `notice` included, and any field added
 * there later. A status a scenario sends on CaptureStatusChanged becomes the one
 * getCaptureStatus answers, as it would be in main.
 *
 * Capture reports have no event of their own, so a scenario describes a meeting's report by
 * emitting it on the CaptureGetReport channel (`hub.emit(IpcChannel.CaptureGetReport, report)`):
 * it becomes that meeting's answer, and a re-run or a delete changes it as main would. A meeting
 * no scenario described has an empty report. A line a scenario hides (a `hidden` event on
 * TranscriptSegmentChanged) can be unhidden, which sends the `unhidden` event main sends; a line
 * it only trims cannot, as in main.
 *
 * A scenario asks the page to start, as main's requestStart does, by emitting the request on
 * CaptureStartRequested: the fake keeps it for takePendingStart, which answers it once, and the
 * page's listeners hear the nudge. Main's own event carries no payload; only the fake reads one.
 */
export function createCaptureFake(hub: FakeHub): CaptureApi {
  let status = idleCaptureStatus({
    state: 'idle',
    pending: 0,
    rejected: 0,
    lastError: null,
    nextAttemptAt: null,
  });
  hub.on(captureChannels.CaptureStatusChanged, (next: CaptureStatus) => {
    status = next;
  });
  const publish = (next: CaptureStatus): CaptureStatus => {
    hub.emit(captureChannels.CaptureStatusChanged, next);
    return next;
  };

  const reports = new Map<string, CaptureReport>();
  hub.on(captureChannels.CaptureGetReport, (report: CaptureReport) => {
    reports.set(report.meetingId, report);
  });
  const reportOf = (meetingId: string): CaptureReport =>
    reports.get(meetingId) ?? emptyReport(meetingId);
  const saveReport = (report: CaptureReport): CaptureReport => {
    reports.set(report.meetingId, report);
    return report;
  };

  let pendingStart: StartCaptureRequest | null = null;
  hub.on(captureChannels.CaptureStartRequested, (request: StartCaptureRequest) => {
    pendingStart = request;
  });

  /**
   * Lines hidden and not unhidden since, by segment id, as they now read. Only `hidden` adds one:
   * main's store unhides a line only while `suppressed_reason` is set, and a trim never sets it
   * (TranscriptStore.unhideSegment), so a merely trimmed line here would get a working Unhide in
   * the preview that does nothing in the app. A trim of a hidden line keeps it hidden, as in main.
   */
  const hidden = new Map<string, TranscriptSegmentChange>();
  hub.on(captureChannels.TranscriptSegmentChanged, (change: TranscriptSegmentChange) => {
    const line = hidden.get(change.segmentId);
    if (change.change === 'hidden') hidden.set(change.segmentId, change);
    else if (change.change === 'unhidden') hidden.delete(change.segmentId);
    else if (line !== undefined) hidden.set(change.segmentId, { ...line, text: change.text });
  });

  return {
    startCapture: (request) =>
      hub.request(captureChannels.CaptureStart, () => {
        const title = storedMeetingText(request?.title ?? '');
        return publish({
          ...idleCaptureStatus(status.upload),
          phase: 'recording',
          meetingId: crypto.randomUUID(),
          // Main names an untitled meeting after its start (defaultMeetingTitle); the preview's
          // shots need no clock in it.
          title: title === '' ? 'New meeting' : title,
          startedAt: new Date().toISOString(),
          sttProvider: 'fake',
          streams: { mic: 'open', system: 'open' },
        });
      }),
    onStartRequested: (listener) => hub.on(captureChannels.CaptureStartRequested, listener),
    takePendingStart: () =>
      hub.request(captureChannels.CaptureTakePendingStart, () => {
        const request = pendingStart;
        pendingStart = null;
        return request;
      }),
    // Main keeps the last meeting's meter after Stop (CaptureService.getStatus).
    stopCapture: () =>
      hub.request(captureChannels.CaptureStop, () =>
        publish({ ...idleCaptureStatus(status.upload), meter: status.meter }),
      ),
    getCaptureStatus: () => hub.request(captureChannels.CaptureGetStatus, () => status),
    // No screen source: the preview runs in a plain browser tab.
    getSystemAudioSourceId: () => hub.request(captureChannels.AudioGetSystemSource, () => null),
    // The preview has no main process to stream audio to; chunks and track states end here.
    sendAudioChunk: () => undefined,
    reportAudioSourceState: () => undefined,
    onCaptureStatus: (listener) => hub.on(captureChannels.CaptureStatusChanged, listener),
    onTranscriptSegment: (listener) => hub.on(captureChannels.TranscriptSegment, listener),
    onTranscriptInterim: (listener) => hub.on(captureChannels.TranscriptInterim, listener),
    onTranscriptSegmentChanged: (listener) =>
      hub.on(captureChannels.TranscriptSegmentChanged, listener),
    getCaptureReport: ({ meetingId }) =>
      hub.request(captureChannels.CaptureGetReport, () => reportOf(meetingId)),
    // Every open gap comes back, as if its audio was kept and the vendor heard it.
    rerunGaps: ({ meetingId }) =>
      hub.request(captureChannels.CaptureRerunGaps, () => {
        const report = reportOf(meetingId);
        const now = new Date().toISOString();
        return saveReport({
          ...report,
          gaps: report.gaps.map((gap) => ({
            ...gap,
            recoveredAt: gap.recoveredAt ?? now,
            recoverError: null,
          })),
          backup: { ...report.backup, keptForRerun: false },
        });
      }),
    deleteMeetingAudio: ({ meetingId }) =>
      hub.request(captureChannels.AudioDeleteMeeting, () =>
        saveReport({
          ...reportOf(meetingId),
          backup: {
            state: 'deleted',
            bytes: 0,
            keepUntil: null,
            keptForRerun: false,
            message: null,
          },
        }),
      ),
    unhideSegment: ({ segmentId }) =>
      hub.request(captureChannels.TranscriptUnhideSegment, () => {
        const line = hidden.get(segmentId);
        if (line === undefined) throw new Error(`no hidden line ${segmentId}`);
        hub.emit(captureChannels.TranscriptSegmentChanged, {
          ...line,
          change: 'unhidden',
          echoOf: null,
        } satisfies TranscriptSegmentChange);
      }),
  };
}

function emptyReport(meetingId: string): CaptureReport {
  return {
    meetingId,
    stopReason: null,
    gaps: [],
    events: [],
    echo: { hidden: 0, trimmed: 0, held: 0 },
    backup: { state: 'off', bytes: 0, keepUntil: null, keptForRerun: false, message: null },
  };
}
