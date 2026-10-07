import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { BackupStatus, EchoStatus } from '../../shared/capture';
import { IpcChannel } from '../../shared/ipc';
import type { TranscriptSegment } from '../../shared/transcript';
import { ApiClient } from '../api/ApiClient';
import { loadConfig } from '../config';
import type { SenderEvent } from '../ipc/trust';
import { createLogger } from '../logger';
import { InMemoryTranscriptStore } from '../store/InMemoryTranscriptStore';
import { FakeSpeechToText } from '../stt/fake/FakeSpeechToText';
import { TranscriptUploader } from '../upload/TranscriptUploader';
import {
  type CaptureFeatureHandlers,
  createCaptureRequests,
  createCaptureRuntime,
  noCaptureFeatures,
} from './createCaptureRuntime';

// ipc.ts asks Electron's desktopCapturer for the screen source; nothing here calls it. The M2-T10
// slot looks for the audio helper under `app.getAppPath()`: a folder with no helper, so call audio
// takes Electron's path and no test here runs a helper. Never the real apps/desktop: on a Mac that
// ran `make check` its dev build exists, and a Start here would build a real tap (a privacy prompt).
// The M2-T6 slot asks net.isOnline() every second while a recording runs. The M2-T18 slot listens
// to powerMonitor's suspend and resume, and holds a power save blocker while a recording runs.
const electronNet = vi.hoisted(() => ({ online: true, reads: 0 }));
const electronPower = vi.hoisted(() => {
  const listeners: { event: string; listener: () => void }[] = [];
  let nextId = 1;
  return {
    /** The blocker ids held now. */
    held: new Set<number>(),
    on: (event: string, listener: () => void) => {
      listeners.push({ event, listener });
    },
    /** Every runtime built in this file listens: the ones not recording do nothing. */
    emit: (event: string) => {
      for (const entry of listeners) if (entry.event === event) entry.listener();
    },
    nextId: () => (nextId += 1),
  };
});
vi.mock('electron', () => ({
  desktopCapturer: { getSources: vi.fn() },
  app: { isPackaged: false, getAppPath: () => '/nonexistent/roger-app', on: vi.fn() },
  net: {
    isOnline: () => {
      electronNet.reads += 1;
      return electronNet.online;
    },
  },
  // Going offline raises M2-T11's loud warning, and the Notifier posts only while Roger is not
  // focused: the harness window (webContents 7) is, so no test here posts a notification.
  BrowserWindow: { getFocusedWindow: () => ({ webContents: { id: 7 } }) },
  powerMonitor: { on: electronPower.on },
  powerSaveBlocker: {
    start: () => {
      const id = electronPower.nextId();
      electronPower.held.add(id);
      return id;
    },
    stop: (id: number) => electronPower.held.delete(id),
  },
}));

const logger = createLogger({ level: 'error', format: 'json', sink: () => undefined });

describe('the slots in capture/createCaptureRuntime.ts', () => {
  // Read as text, like index.test.ts: a marker that moved or went missing turns the next merge
  // into a conflict, or runs a feature before what it needs exists.
  const lines = readFileSync(new URL('./createCaptureRuntime.ts', import.meta.url), 'utf8').split(
    '\n',
  );
  const SLOT_MARKER = /^\s*\/\/ \[slot ([^\]]+)\]/;
  const lineOf = (text: string): number => {
    const index = lines.findIndex((line) => line.includes(text));
    if (index === -1) throw new Error(`createCaptureRuntime.ts has no line with ${text}`);
    return index;
  };

  it('keeps every marker, once, in the order features depend on each other', () => {
    const markers = lines.flatMap((line) => SLOT_MARKER.exec(line)?.slice(1, 2) ?? []);
    // T10 before T17a (the monitor runs through HelperProcess) and T18 (the helper restarts at
    // wake); T11 before T17b and T19 (Notifier); T14b before T16 (filterStored) and T17a (the
    // RouteProvider); T15 before T16 (the backup it re-runs); T6 before T18 (suspendStreams).
    expect(markers).toEqual([
      'M2-T6',
      'M2-T10',
      'M2-T11',
      'M2-T14b',
      'M2-T15',
      'M2-T16',
      'M2-T17a',
      'M2-T17b',
      'M2-T18',
      'M2-T19',
      'M3-T19b',
    ]);
  });

  it('follows every marker with a blank line, so blocks under two markers never touch', () => {
    const crowded = lines.filter(
      (line, index) => SLOT_MARKER.test(line) && lines[index + 1]?.trim() !== '',
    );
    expect(crowded).toEqual([]);
  });

  it('runs every slot after the capture service exists and before the capture IPC answers', () => {
    const slots = lines.flatMap((line, index) => (SLOT_MARKER.test(line) ? [index] : []));
    expect(lineOf('new CaptureService(')).toBeLessThan(Math.min(...slots));
    expect(lineOf('registerIpcHandlers(')).toBeGreaterThan(Math.max(...slots));
  });
});

function fakeIpcMain() {
  const handlers = new Map<string, (event: SenderEvent, payload: unknown) => unknown>();
  return {
    handlers,
    handle: (channel: string, listener: (event: SenderEvent, payload: unknown) => unknown) => {
      handlers.set(channel, listener);
    },
    on: () => undefined,
  };
}

function runtimeHarness() {
  const store = new InMemoryTranscriptStore();
  const connection = { baseUrl: 'http://127.0.0.1:9', token: 'test' };
  const api = new ApiClient(connection);
  const ipcMain = fakeIpcMain();
  const window = { webContents: { id: 7, send: vi.fn() }, isDestroyed: () => false };
  const runtime = createCaptureRuntime({
    // The fake provider: Start asks the API for no token.
    config: { ...loadConfig({}), sttProviderOverride: 'fake' },
    store,
    api,
    apiConnection: connection,
    uploader: new TranscriptUploader({ store, api, logger }),
    createSpeechToText: () => new FakeSpeechToText(),
    ensureMicrophoneAccess: () => Promise.resolve('granted'),
    startupError: null,
    userData: '/nonexistent/roger-test',
    ipcMain,
    getWindow: () => window,
    logger,
  });
  return { store, ipcMain, runtime };
}

describe('createCaptureRuntime', () => {
  it('builds the one open budget, and capture opens through it', async () => {
    const { runtime } = runtimeHarness();
    expect((await runtime.capture.start()).phase).toBe('recording');
    // The budget handed to the re-run's slot is the one Start's two opens came from.
    expect(runtime.budget.openedThisMeeting).toBe(2);
    await runtime.capture.stop();
  });

  it('answers the capture channels from the store, the report included', () => {
    const { store, ipcMain } = runtimeHarness();
    const meetingId = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
    store.createMeeting({ id: meetingId, title: 'T', startedAt: '2026-10-06T10:00:00.000Z' });
    const getReport = ipcMain.handlers.get(IpcChannel.CaptureGetReport);
    expect(getReport?.({ sender: { id: 7 } }, { meetingId })).toMatchObject({ meetingId });
    for (const channel of [
      IpcChannel.CaptureRerunGaps,
      IpcChannel.AudioDeleteMeeting,
      IpcChannel.TranscriptUnhideSegment,
    ]) {
      expect(ipcMain.handlers.has(channel)).toBe(true);
    }
  });

  it('suspends the live session while the Mac is offline, and polls only while recording (M2-T6)', async () => {
    vi.useFakeTimers();
    try {
      const { runtime } = runtimeHarness();
      const { capture } = runtime;
      const idleReads = electronNet.reads; // earlier tests here record too
      vi.advanceTimersByTime(5_000);
      expect(electronNet.reads).toBe(idleReads); // no recording, no poll

      await capture.start();
      electronNet.online = false;
      vi.advanceTimersByTime(1_000);
      expect(capture.getStatus().streams).toEqual({ mic: 'offline', system: 'offline' });
      electronNet.online = true;
      vi.advanceTimersByTime(1_000);
      expect(capture.getStatus().streams).toEqual({ mic: 'paused', system: 'paused' });

      await capture.stop({ flushUploads: false });
      const reads = electronNet.reads;
      vi.advanceTimersByTime(5_000);
      expect(electronNet.reads).toBe(reads);
    } finally {
      electronNet.online = true;
      vi.useRealTimers();
    }
  });

  it('pauses the live session while the Mac sleeps, and keeps it awake only while recording (M2-T18)', async () => {
    const { capture } = runtimeHarness().runtime;
    expect(electronPower.held.size).toBe(0);
    await capture.start();
    expect(electronPower.held.size).toBe(1);

    electronPower.emit('suspend');
    expect(capture.getStatus()).toMatchObject({
      phase: 'recording',
      paused: 'asleep',
      streams: { mic: 'paused', system: 'paused' },
    });
    electronPower.emit('resume'); // a moment later: a short sleep, so the recording goes on
    expect(capture.getStatus()).toMatchObject({ phase: 'recording', paused: null });

    await capture.stop({ flushUploads: false });
    expect(electronPower.held.size).toBe(0);
  });

  // The runtime has none of its own: each comes from a feature's slot.
  it('stops the call audio helper at quit (M2-T10)', () => {
    const names = runtimeHarness().runtime.quitHooks.map((hook) => hook.name);
    expect(names).toContain('stop the call audio helper');
  });
});

const MEETING = '6f1d2b7e-8a4c-4f0e-9b1a-2c3d4e5f6a7b';
const OTHER_MEETING = '0e9d8c7b-6a5f-4e3d-8c1b-0a9f8e7d6c5b';
const MIC_LINE = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const THEM_LINE = 'c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f';

function line(id: string, source: 'mic' | 'system', text: string): TranscriptSegment {
  return {
    id,
    meetingId: MEETING,
    source,
    speaker: source === 'mic' ? 'me' : 'them',
    startMs: 1_000,
    endMs: 3_000,
    text,
    confidence: 1,
    words: [],
    createdAt: '2026-10-06T10:00:03.000Z',
  };
}

function storeWithMeeting() {
  const store = new InMemoryTranscriptStore();
  store.createMeeting({ id: MEETING, title: 'Weekly sync', startedAt: '2026-10-06T10:00:00.000Z' });
  store.createMeeting({ id: OTHER_MEETING, title: 'Other', startedAt: '2026-10-06T11:00:00.000Z' });
  return store;
}

describe('the capture requests', () => {
  it("builds a meeting's report from the store: stop reason, gaps and events", () => {
    const store = storeWithMeeting();
    store.setMeetingStopReason(MEETING, 'no-speech');
    store.addGap({
      id: 'd4e5f6a7-b8c9-4d0e-9f1a-3b4c5d6e7f80',
      meetingId: MEETING,
      source: 'system',
      startMs: 60_000,
      endMs: 75_000,
      reason: 'offline',
      createdAt: '2026-10-06T10:01:15.000Z',
    });
    store.addCaptureEvent({
      meetingId: MEETING,
      at: '2026-10-06T10:01:00.000Z',
      offsetMs: 60_000,
      source: 'system',
      kind: 'stream-paused',
      detail: { silentForMs: 30_000 },
    });
    store.addCaptureEvent({
      meetingId: OTHER_MEETING,
      at: '2026-10-06T11:00:01.000Z',
      offsetMs: 1_000,
      source: null,
      kind: 'not-this-meeting',
    });

    expect(createCaptureRequests(store, noCaptureFeatures()).getReport(MEETING)).toEqual({
      meetingId: MEETING,
      stopReason: 'no-speech',
      gaps: [
        {
          id: 'd4e5f6a7-b8c9-4d0e-9f1a-3b4c5d6e7f80',
          source: 'system',
          startMs: 60_000,
          endMs: 75_000,
          reason: 'offline',
          recoveredAt: null,
          recoverError: null,
        },
      ],
      events: [
        {
          at: '2026-10-06T10:01:00.000Z',
          offsetMs: 60_000,
          source: 'system',
          kind: 'stream-paused',
          detail: { silentForMs: 30_000 },
        },
      ],
      // Until the echo filter (M2-T14b) and the backup (M2-T15) are wired, nothing is hidden,
      // trimmed, held or kept.
      echo: { hidden: 0, trimmed: 0, held: 0 },
      backup: { state: 'off', bytes: 0, keepUntil: null, keptForRerun: false, message: null },
    });
  });

  it('takes the echo counts and the backup from their features once they are wired', () => {
    const store = storeWithMeeting();
    const echo: EchoStatus = { hidden: 2, trimmed: 1, held: 0 };
    const backup: BackupStatus = {
      state: 'kept',
      bytes: 4_096,
      keepUntil: '2026-10-13T10:00:00.000Z',
      keptForRerun: false,
      message: null,
    };
    const features: CaptureFeatureHandlers = {
      ...noCaptureFeatures(),
      echoReport: (meetingId) =>
        meetingId === MEETING ? echo : { hidden: 0, trimmed: 0, held: 0 },
      backupReport: () => backup,
    };
    expect(createCaptureRequests(store, features).getReport(MEETING)).toMatchObject({
      echo,
      backup,
    });
  });

  it('refuses a meeting this Mac does not have', () => {
    const requests = createCaptureRequests(storeWithMeeting(), noCaptureFeatures());
    expect(() => requests.getReport('9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f')).toThrow(
      'Meeting 9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f is not on this Mac',
    );
  });

  it('re-runs gaps and deletes audio through their features, then answers the report after', async () => {
    const store = storeWithMeeting();
    const calls: string[] = [];
    const features: CaptureFeatureHandlers = {
      ...noCaptureFeatures(),
      rerunGaps: (meetingId) => {
        calls.push(`rerun ${meetingId}`);
        store.setMeetingStopReason(meetingId, 'user');
        return Promise.resolve();
      },
      deleteMeetingAudio: (meetingId) => {
        calls.push(`delete ${meetingId}`);
        return Promise.resolve();
      },
    };
    const requests = createCaptureRequests(store, features);
    // The report is read after the work, so it shows what the work changed.
    expect(await requests.rerunGaps(MEETING)).toMatchObject({
      meetingId: MEETING,
      stopReason: 'user',
    });
    expect(await requests.deleteMeetingAudio(MEETING)).toMatchObject({ meetingId: MEETING });
    expect(calls).toEqual([`rerun ${MEETING}`, `delete ${MEETING}`]);
  });

  it('refuses a re-run or a delete this build cannot do, and one for a meeting it does not have', async () => {
    const requests = createCaptureRequests(storeWithMeeting(), noCaptureFeatures());
    await expect(requests.rerunGaps(MEETING)).rejects.toThrow('not available');
    await expect(requests.deleteMeetingAudio(MEETING)).rejects.toThrow('not available');
    const rerun = vi.fn(() => Promise.resolve());
    const withRerun = createCaptureRequests(storeWithMeeting(), {
      ...noCaptureFeatures(),
      rerunGaps: rerun,
    });
    await expect(withRerun.rerunGaps('9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f')).rejects.toThrow(
      'not on this Mac',
    );
    expect(rerun).not.toHaveBeenCalled();
  });

  it('shows a hidden line again through the echo feature, and refuses any other line', () => {
    const store = storeWithMeeting();
    store.appendSegment(line(THEM_LINE, 'system', 'shall we start with the numbers'));
    store.appendSegment(line(MIC_LINE, 'mic', 'shall we start with the numbers'));
    const trimmedId = 'e5f6a7b8-c9d0-4e1f-8a2b-4c5d6e7f8091';
    store.appendSegment(line(trimmedId, 'mic', 'yes shall we start with the numbers'));
    store.trimSegment(trimmedId, { text: 'yes', words: null, echoOf: THEM_LINE });
    const unhide = vi.fn();
    const requests = createCaptureRequests(store, {
      ...noCaptureFeatures(),
      unhideSegment: unhide,
    });

    // A trimmed line already uploads: only a hidden one is shown again (the preview fake agrees).
    expect(() => {
      requests.unhideSegment({ meetingId: MEETING, segmentId: trimmedId });
    }).toThrow('is not hidden');
    expect(() => {
      requests.unhideSegment({ meetingId: MEETING, segmentId: MIC_LINE });
    }).toThrow('is not hidden');
    expect(() => {
      requests.unhideSegment({ meetingId: OTHER_MEETING, segmentId: MIC_LINE });
    }).toThrow('is not on this Mac');
    expect(unhide).not.toHaveBeenCalled();

    store.suppressSegment(MIC_LINE, 'echo', THEM_LINE);
    requests.unhideSegment({ meetingId: MEETING, segmentId: MIC_LINE });
    expect(unhide).toHaveBeenCalledTimes(1);
    expect(unhide.mock.calls[0]?.[0]).toMatchObject({ id: MIC_LINE, suppressedReason: 'echo' });

    const unwired = createCaptureRequests(store, noCaptureFeatures());
    expect(() => {
      unwired.unhideSegment({ meetingId: MEETING, segmentId: MIC_LINE });
    }).toThrow('not available');
  });
});
