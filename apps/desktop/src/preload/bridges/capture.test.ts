import { describe, expect, it, vi } from 'vitest';
import type { StartCaptureRequest, TranscriptSegmentChange } from '../../shared/capture';
import { captureBridge } from './capture';

// Electron's ipcRenderer, as far as the bridge helpers (../bridge.ts) use it. Hoisted, because
// vi.mock runs before the imports.
const ipc = vi.hoisted(() => {
  type Listener = (event: { senderId: number }, payload: unknown) => void;
  const listeners = new Map<string, Listener[]>();
  const invoked: unknown[][] = [];
  const sent: unknown[][] = [];
  return {
    invoked,
    sent,
    renderer: {
      invoke: (...args: unknown[]): Promise<unknown> => {
        invoked.push(args);
        return Promise.resolve(undefined);
      },
      send: (...args: unknown[]): void => {
        sent.push(args);
      },
      on: (channel: string, listener: Listener): void => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      },
      removeListener: (channel: string, listener: Listener): void => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((each) => each !== listener),
        );
      },
    },
    emit: (channel: string, payload: unknown): void => {
      for (const listener of listeners.get(channel) ?? []) listener({ senderId: 0 }, payload);
    },
  };
});
vi.mock('electron', () => ({ ipcRenderer: ipc.renderer }));

const MEETING = '2f1d9c4e-8a3b-4c5d-9e6f-7a8b9c0d1e2f';
const SEGMENT = '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e';

describe('the capture bridge', () => {
  it('sends the capture time with each audio chunk', () => {
    const pcm = new ArrayBuffer(3200);
    captureBridge.sendAudioChunk({ source: 'mic', pcm, capturedAtMs: 1_765_000_000_000 });
    expect(ipc.sent).toEqual([
      ['audio:chunk', { source: 'mic', pcm, capturedAtMs: 1_765_000_000_000 }],
    ]);
  });

  it('asks main for a report, a re-run, a delete and an unhide on their channels', async () => {
    await captureBridge.getCaptureReport({ meetingId: MEETING });
    await captureBridge.rerunGaps({ meetingId: MEETING });
    await captureBridge.deleteMeetingAudio({ meetingId: MEETING });
    await captureBridge.unhideSegment({ meetingId: MEETING, segmentId: SEGMENT });
    expect(ipc.invoked).toEqual([
      ['capture:get-report', { meetingId: MEETING }],
      ['capture:rerun-gaps', { meetingId: MEETING }],
      ['audio:delete-meeting', { meetingId: MEETING }],
      ['transcript:unhide-segment', { meetingId: MEETING, segmentId: SEGMENT }],
    ]);
  });

  it('asks main for the meetings whose audio is kept for a re-run, with no payload', async () => {
    await captureBridge.listMeetingsKeptForRerun();
    expect(ipc.invoked.at(-1)).toEqual(['audio:list-kept-for-rerun', undefined]);
  });

  it('hands every segment change to the listener until it unsubscribes', () => {
    const change: TranscriptSegmentChange = {
      meetingId: MEETING,
      segmentId: SEGMENT,
      source: 'mic',
      change: 'hidden',
      reason: 'echo',
      echoOf: 'c0ffee00-1111-4222-8333-444455556666',
      text: 'we ship on Friday',
    };
    const seen: TranscriptSegmentChange[] = [];
    const stop = captureBridge.onTranscriptSegmentChanged((each) => seen.push(each));
    ipc.emit('transcript:segment-changed', change);
    stop();
    ipc.emit('transcript:segment-changed', { ...change, change: 'unhidden' });
    expect(seen).toEqual([change]);
  });
});

describe('the capture bridge and start requests (M5)', () => {
  it('asks main to start with the request, or with none, and takes a pending start', async () => {
    ipc.invoked.length = 0;
    const request: StartCaptureRequest = { source: 'notification', title: 'Standup' };
    await captureBridge.startCapture(request);
    await captureBridge.startCapture();
    await captureBridge.takePendingStart();
    expect(ipc.invoked).toEqual([
      ['capture:start', request],
      ['capture:start', undefined],
      ['capture:take-pending-start', undefined],
    ]);
  });

  it('tells the listener a start request waits, until it unsubscribes', () => {
    let told = 0;
    const stop = captureBridge.onStartRequested(() => {
      told += 1;
    });
    ipc.emit('capture:start-requested', undefined);
    stop();
    ipc.emit('capture:start-requested', undefined);
    expect(told).toBe(1);
  });
});
