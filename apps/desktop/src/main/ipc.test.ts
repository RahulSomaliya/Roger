import { describe, expect, it, vi } from 'vitest';
import type { CaptureReport, CaptureStatus, StartCaptureRequest } from '../shared/capture';
import { IpcChannel } from '../shared/ipc';
import { idleCaptureStatus } from '../shared/capture';
import type { CaptureService } from './capture/CaptureService';
import { type CaptureIpcTarget, type CaptureRequests, registerIpcHandlers } from './ipc';
import type { SenderEvent } from './ipc/trust';
import { createLogger } from './logger';

vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn(() => Promise.resolve([{ id: 'screen:1:0' }])) },
}));

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });
const MEETING = '6f1d2b7e-8a4c-4f0e-9b1a-2c3d4e5f6a7b';
const LINE = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const WINDOW_ID = 3;

function report(meetingId: string): CaptureReport {
  return {
    meetingId,
    stopReason: null,
    gaps: [],
    events: [],
    echo: { hidden: 0, trimmed: 0, held: 0 },
    backup: { state: 'off', bytes: 0, keepUntil: null, keptForRerun: false, message: null },
  };
}

function registered() {
  const handlers = new Map<string, (event: SenderEvent, payload: unknown) => unknown>();
  const listeners = new Map<string, (event: SenderEvent, payload: unknown) => void>();
  const status: CaptureStatus = idleCaptureStatus({
    state: 'idle',
    pending: 0,
    rejected: 0,
    lastError: null,
    nextAttemptAt: null,
  });
  const startRequested: ((request: StartCaptureRequest) => void)[] = [];
  const pending: { request: StartCaptureRequest | null } = { request: null };
  const capture = {
    start: vi.fn<CaptureService['start']>(() => Promise.resolve(status)),
    stop: vi.fn(() => Promise.resolve(status)),
    getStatus: vi.fn(() => status),
    pushAudio: vi.fn<CaptureService['pushAudio']>(),
    reportSourceState: vi.fn<CaptureService['reportSourceState']>(),
    takePendingStart: vi.fn<CaptureService['takePendingStart']>(() => pending.request),
    // Only the start-requested event is kept: the other events are not what these tests drive.
    // Cast because CaptureService's `on` is generic over every event, and this double takes one.
    on: ((event: string, listener: (request: StartCaptureRequest) => void) => {
      if (event === 'start-requested') startRequested.push(listener);
      return () => undefined;
    }) as CaptureService['on'],
  } satisfies CaptureIpcTarget;
  const send = vi.fn<(channel: string, payload: unknown) => void>();
  const requests = {
    getReport: vi.fn<CaptureRequests['getReport']>(report),
    rerunGaps: vi.fn<CaptureRequests['rerunGaps']>((meetingId) =>
      Promise.resolve(report(meetingId)),
    ),
    deleteMeetingAudio: vi.fn<CaptureRequests['deleteMeetingAudio']>((meetingId) =>
      Promise.resolve(report(meetingId)),
    ),
    unhideSegment: vi.fn<CaptureRequests['unhideSegment']>(),
  };
  registerIpcHandlers({
    ipcMain: {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
      on: (channel, listener) => {
        listeners.set(channel, listener);
      },
    },
    capture,
    requests,
    getWindow: () => ({ webContents: { id: WINDOW_ID, send }, isDestroyed: () => false }),
    logger,
  });
  const fromPage = { sender: { id: WINDOW_ID } };
  return {
    capture,
    requests,
    pending,
    /** What main sent the page. */
    sentToPage: send,
    /** Main's requestStart, as CaptureService emits it. */
    requestStart: (request: StartCaptureRequest) => {
      for (const listener of startRequested) listener(request);
    },
    /** Like the page's invoke: a handler that throws, or one that rejects, rejects it. */
    invoke: (channel: string, payload?: unknown): Promise<unknown> =>
      new Promise((resolve) => {
        const handler = handlers.get(channel);
        if (handler === undefined) throw new Error(`No handler registered for '${channel}'`);
        resolve(handler(fromPage, payload));
      }),
    send: (channel: string, payload: unknown) => {
      listeners.get(channel)?.(fromPage, payload);
    },
  };
}

describe('the capture IPC', () => {
  it("passes each chunk's capture time to the fan-out, or null for the arrival time", () => {
    const ipc = registered();
    const pcm = new Uint8Array(3200).buffer;
    const capturedAtMs = Date.now() - 120;
    ipc.send(IpcChannel.AudioChunk, { source: 'mic', pcm, capturedAtMs });
    ipc.send(IpcChannel.AudioChunk, { source: 'system', pcm });
    expect(ipc.capture.pushAudio.mock.calls.map(([source, , at]) => [source, at])).toEqual([
      ['mic', capturedAtMs],
      ['system', null],
    ]);
  });

  it('answers the report, a re-run and a delete for a meeting id it has checked', async () => {
    const ipc = registered();
    await expect(ipc.invoke(IpcChannel.CaptureGetReport, { meetingId: MEETING })).resolves.toEqual(
      report(MEETING),
    );
    await expect(ipc.invoke(IpcChannel.CaptureRerunGaps, { meetingId: MEETING })).resolves.toEqual(
      report(MEETING),
    );
    await expect(
      ipc.invoke(IpcChannel.AudioDeleteMeeting, { meetingId: MEETING, extra: 'ignored' }),
    ).resolves.toEqual(report(MEETING));
    expect(ipc.requests.getReport).toHaveBeenCalledWith(MEETING);
    expect(ipc.requests.rerunGaps).toHaveBeenCalledWith(MEETING);
    expect(ipc.requests.deleteMeetingAudio).toHaveBeenCalledWith(MEETING);
  });

  it('refuses a meeting id that is not a lowercase UUIDv4 before anything runs', async () => {
    const ipc = registered();
    // A meeting id names a folder on disk: `../x` would make the delete climb out of the audio root.
    for (const meetingId of ['../x', '/Users/me', MEETING.toUpperCase(), 42]) {
      for (const channel of [
        IpcChannel.CaptureGetReport,
        IpcChannel.CaptureRerunGaps,
        IpcChannel.AudioDeleteMeeting,
      ]) {
        await expect(ipc.invoke(channel, { meetingId })).rejects.toThrow('invalid meeting request');
      }
    }
    await expect(ipc.invoke(IpcChannel.AudioDeleteMeeting)).rejects.toThrow(
      'invalid meeting request',
    );
    expect(ipc.requests.deleteMeetingAudio).not.toHaveBeenCalled();
    expect(ipc.requests.rerunGaps).not.toHaveBeenCalled();
    expect(ipc.requests.getReport).not.toHaveBeenCalled();
  });

  it('shows a line again only for checked ids, and passes on why it refused', async () => {
    const ipc = registered();
    await expect(
      ipc.invoke(IpcChannel.TranscriptUnhideSegment, { meetingId: MEETING, segmentId: LINE }),
    ).resolves.toBeUndefined();
    expect(ipc.requests.unhideSegment).toHaveBeenCalledWith({
      meetingId: MEETING,
      segmentId: LINE,
    });

    await expect(
      ipc.invoke(IpcChannel.TranscriptUnhideSegment, { meetingId: MEETING, segmentId: '../x' }),
    ).rejects.toThrow('invalid segment request');
    ipc.requests.unhideSegment.mockImplementationOnce(() => {
      throw new Error(`Line ${LINE} is not hidden`);
    });
    await expect(
      ipc.invoke(IpcChannel.TranscriptUnhideSegment, { meetingId: MEETING, segmentId: LINE }),
    ).rejects.toThrow('is not hidden');
    expect(ipc.requests.unhideSegment).toHaveBeenCalledTimes(2);
  });
});

describe('the capture IPC and start requests (M5)', () => {
  const request: StartCaptureRequest = {
    source: 'notification',
    title: 'Standup',
    calendarEvent: {
      provider: 'fake',
      eventId: 'fake-standup_20261007T093000Z',
      icalUid: null,
      recurringEventId: null,
      scheduledStart: '2026-10-07T09:30:00.000Z',
      scheduledEnd: '2026-10-07T09:45:00.000Z',
      attendees: [],
    },
  };

  it('starts with the request it has checked, or a plain start with none', async () => {
    const ipc = registered();
    await ipc.invoke(IpcChannel.CaptureStart, request);
    await ipc.invoke(IpcChannel.CaptureStart);
    expect(ipc.capture.start.mock.calls).toEqual([[request], [{}]]);
  });

  // Only main resumes a meeting (M2-T23): a page that could name one would record into any meeting.
  it('passes on none of what else a page sends, a resume included', async () => {
    const ipc = registered();
    await ipc.invoke(IpcChannel.CaptureStart, {
      source: 'home',
      resume: { meetingId: MEETING },
      extra: 'x',
    });
    expect(ipc.capture.start.mock.calls).toEqual([[{ source: 'home' }]]);
  });

  it('refuses a start request that does not check, naming the field, before anything runs', async () => {
    const ipc = registered();
    await expect(ipc.invoke(IpcChannel.CaptureStart, { source: 'calendar' })).rejects.toThrow(
      'invalid start request: source is not a start source',
    );
    await expect(ipc.invoke(IpcChannel.CaptureStart, { title: 'x'.repeat(501) })).rejects.toThrow(
      'invalid start request: title is over 500 characters',
    );
    expect(ipc.capture.start).not.toHaveBeenCalled();
  });

  it('tells the page a start request waits, and hands it over when the page takes it', async () => {
    const ipc = registered();
    ipc.pending.request = request;
    ipc.requestStart(request);
    // A nudge with no payload: the page takes the request, so it runs once however many ask.
    expect(ipc.sentToPage).toHaveBeenCalledWith(IpcChannel.CaptureStartRequested, undefined);
    await expect(ipc.invoke(IpcChannel.CaptureTakePendingStart)).resolves.toEqual(request);
    ipc.pending.request = null;
    await expect(ipc.invoke(IpcChannel.CaptureTakePendingStart)).resolves.toBeNull();
  });
});
