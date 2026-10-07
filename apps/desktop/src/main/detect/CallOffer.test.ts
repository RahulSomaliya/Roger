import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallApp, PromptOffer } from '../../shared/calendar';
import type { CapturePhase } from '../../shared/capture';
import type { StatusContributor, StopOptions } from '../capture/CaptureService';
import { createLogger, type Logger } from '../logger';
import { CALL_NATIVE_RELEASE_MS, CALL_WAKE_GRACE_MS } from './CallDetector';
import { CALL_DISMISS_COOLDOWN_MS, CallOffer, type CallPromptPort } from './CallOffer';
import type { DetectedCallApp } from './callApps';

const zoom: DetectedCallApp = { bundleId: 'us.zoom.xos', name: 'Zoom', kind: 'native' };
const chrome: DetectedCallApp = {
  bundleId: 'com.google.Chrome',
  name: 'Google Chrome',
  kind: 'browser',
};

function recordingLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    logger: createLogger({
      level: 'info',
      format: 'json',
      sink: (line) => {
        const entry = JSON.parse(line) as Record<string, unknown>;
        delete entry.time;
        lines.push(entry);
      },
    }),
  };
}

function logged(lines: Record<string, unknown>[], level: string, fragment: string): boolean {
  return lines.some((line) => line.level === level && String(line.message).includes(fragment));
}

/** The monitor, CaptureService, PromptService, Notifier and powerMonitor, as far as CallOffer goes. */
function setup(options: { enabled?: boolean; bindPrompts?: boolean } = {}) {
  const { logger, lines } = recordingLogger();
  let apps: readonly DetectedCallApp[] = [];
  let running = true;
  const appListeners = new Set<(apps: readonly DetectedCallApp[]) => void>();
  const monitor = {
    get callApps() {
      return apps;
    },
    get running() {
      return running;
    },
    onCallApps: (listener: (apps: readonly DetectedCallApp[]) => void) => {
      appListeners.add(listener);
      return () => appListeners.delete(listener);
    },
  };
  const recordingListeners: {
    started?: (recording: { resumed: boolean }) => void;
    ended?: () => void;
  }[] = [];
  const contributors = new Map<string, StatusContributor>();
  const stops: StopOptions[] = [];
  const capture = {
    phase: 'idle' as CapturePhase,
    stopError: null as Error | null,
    refreshed: 0,
    onRecording: (listener: (typeof recordingListeners)[number]) => {
      recordingListeners.push(listener);
      return () => undefined;
    },
    stop(stopOptions: StopOptions): Promise<unknown> {
      stops.push(stopOptions);
      return capture.stopError === null
        ? Promise.resolve(undefined)
        : Promise.reject(capture.stopError);
    },
    addStatusContributor: (name: string, read: StatusContributor) => {
      contributors.set(name, read);
      return () => contributors.delete(name);
    },
    refreshStatus: () => {
      capture.refreshed += 1;
    },
  };
  const offers: PromptOffer[] = [];
  const dismissListeners = new Set<(app: CallApp) => void>();
  const prompts: CallPromptPort = {
    offer: (offer) => {
      offers.push(offer);
    },
    onCallCardDismissed: (listener) => {
      dismissListeners.add(listener);
      return () => dismissListeners.delete(listener);
    },
  };
  const notices: { title: string; body: string }[] = [];
  const powerListeners: { event: string; listener: () => void }[] = [];
  const callOffer = new CallOffer({
    enabled: options.enabled ?? true,
    monitor,
    capture,
    notifier: {
      notify: (content) => {
        notices.push(content);
      },
    },
    powerMonitor: {
      on: (event, listener) => {
        powerListeners.push({ event, listener });
      },
    },
    logger,
  });
  callOffer.attach();
  if (options.bindPrompts !== false) callOffer.bindPrompts(prompts);
  return {
    callOffer,
    capture,
    offers,
    notices,
    stops,
    lines,
    /** The apps on the mic change, as the monitor reports it. */
    setApps(next: readonly DetectedCallApp[]) {
      apps = next;
      for (const listener of [...appListeners]) listener(next);
    },
    loseMonitor() {
      running = false;
      apps = [];
      for (const listener of [...appListeners]) listener([]);
    },
    start(resumed = false) {
      capture.phase = 'recording';
      for (const listener of recordingListeners) listener.started?.({ resumed });
    },
    end() {
      capture.phase = 'idle';
      for (const listener of recordingListeners) listener.ended?.();
    },
    dismiss(app: CallApp) {
      for (const listener of dismissListeners) listener(app);
    },
    power(event: 'suspend' | 'resume') {
      for (const entry of powerListeners) if (entry.event === event) entry.listener();
    },
    /** The status's `trigger`; undefined when no contributor is registered. */
    trigger(): CallApp | null | undefined {
      const read = contributors.get('call');
      if (read === undefined) return undefined;
      return read({ phase: capture.phase, meetingId: null }).trigger;
    },
  };
}

describe('CallOffer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-10-07T10:00:00.000Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('offers', () => {
    it('offers a native call 5 s after the app takes the mic, as a call_detected prompt', () => {
      const t = setup();
      t.setApps([zoom]);
      vi.advanceTimersByTime(4_999);
      expect(t.offers).toEqual([]);
      vi.advanceTimersByTime(1);
      // Only the CallApp, never the detector's `kind`: the card and its row carry what they show.
      expect(t.offers).toEqual([
        { source: 'call_detected', app: { bundleId: 'us.zoom.xos', name: 'Zoom' } },
      ]);
    });

    it('offers a browser after 15 s', () => {
      const t = setup();
      t.setApps([chrome]);
      vi.advanceTimersByTime(14_999);
      expect(t.offers).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(t.offers.map((offer) => offer.source)).toEqual(['call_detected']);
    });

    it('never starts a recording itself: no stop and no start from an offer', () => {
      const t = setup();
      t.setApps([zoom]);
      vi.advanceTimersByTime(60_000);
      expect(t.stops).toEqual([]);
      expect(t.capture.phase).toBe('idle');
    });

    it('offers again when the mic comes back to the app, and not for the same spell', () => {
      const t = setup();
      t.setApps([zoom]);
      vi.advanceTimersByTime(60_000);
      expect(t.offers).toHaveLength(1);
      t.setApps([]);
      t.setApps([zoom]);
      vi.advanceTimersByTime(5_000);
      expect(t.offers).toHaveLength(2);
    });

    it('stays quiet for an app for 10 minutes after its card was dismissed', () => {
      const t = setup();
      t.setApps([zoom]);
      vi.advanceTimersByTime(5_000);
      expect(t.offers).toHaveLength(1);
      t.dismiss({ bundleId: 'us.zoom.xos', name: 'Zoom' });
      t.setApps([]);
      vi.advanceTimersByTime(1_000);
      t.setApps([zoom]);
      vi.advanceTimersByTime(5_000);
      expect(t.offers).toHaveLength(1);
      t.setApps([]);
      vi.advanceTimersByTime(CALL_DISMISS_COOLDOWN_MS);
      t.setApps([zoom]);
      vi.advanceTimersByTime(5_000);
      expect(t.offers).toHaveLength(2);
    });

    it('keeps the cooldown to the dismissed app', () => {
      const t = setup();
      t.dismiss({ bundleId: 'us.zoom.xos', name: 'Zoom' });
      t.setApps([chrome]);
      vi.advanceTimersByTime(15_000);
      expect(t.offers).toHaveLength(1);
    });

    it('offers nothing while a recording runs, and not for the call it runs in once it stops', () => {
      const t = setup();
      t.setApps([zoom]);
      t.start();
      vi.advanceTimersByTime(60_000);
      t.end();
      vi.advanceTimersByTime(60_000);
      expect(t.offers).toEqual([]);
    });

    it('offers nothing with call detection off, and adds no status', () => {
      const t = setup({ enabled: false });
      t.setApps([zoom]);
      vi.advanceTimersByTime(60_000);
      expect(t.offers).toEqual([]);
      expect(t.trigger()).toBeUndefined();
    });

    it('logs and drops an offer when the prompt service is not wired yet', () => {
      const t = setup({ bindPrompts: false });
      t.setApps([zoom]);
      vi.advanceTimersByTime(5_000);
      expect(logged(t.lines, 'warn', 'no prompt service')).toBe(true);
    });

    it('refuses a second prompt service', () => {
      const t = setup();
      expect(() => {
        t.callOffer.bindPrompts({
          offer: () => undefined,
          onCallCardDismissed: () => () => undefined,
        });
      }).toThrow(/already/);
    });
  });

  describe('auto-stop', () => {
    it('stops through the normal stop 15 s after the call app lets go, and says so', async () => {
      const t = setup();
      t.setApps([zoom]);
      t.start();
      vi.advanceTimersByTime(30_000);
      t.setApps([]);
      vi.advanceTimersByTime(CALL_NATIVE_RELEASE_MS - 1);
      expect(t.stops).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.stops).toEqual([{ reason: 'call-ended', detail: 'Zoom' }]);
      expect(t.notices.map((notice) => notice.title)).toEqual(['Stopped: the call in Zoom ended']);
    });

    it('does not stop when the mic returns within the debounce (AirPods connecting)', async () => {
      const t = setup();
      t.setApps([zoom]);
      t.start();
      t.setApps([]);
      await vi.advanceTimersByTimeAsync(2_000);
      t.setApps([zoom]);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(t.stops).toEqual([]);
    });

    it('never stops a manual start in which no call app was seen', async () => {
      const t = setup();
      t.start();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(t.stops).toEqual([]);
    });

    it('follows a call app that arrives after Start', async () => {
      const t = setup();
      t.start();
      t.setApps([zoom]);
      expect(t.trigger()).toEqual({ bundleId: 'us.zoom.xos', name: 'Zoom' });
      t.setApps([]);
      await vi.advanceTimersByTimeAsync(CALL_NATIVE_RELEASE_MS);
      expect(t.stops).toEqual([{ reason: 'call-ended', detail: 'Zoom' }]);
    });

    it('posts no notice when the stop failed, and does not retry it', async () => {
      const t = setup();
      t.capture.stopError = new Error('disk full');
      t.setApps([zoom]);
      t.start();
      t.setApps([]);
      await vi.advanceTimersByTimeAsync(10 * CALL_NATIVE_RELEASE_MS);
      expect(t.stops).toHaveLength(1);
      expect(t.notices).toEqual([]);
      expect(logged(t.lines, 'error', 'call-ended')).toBe(true);
    });

    it('leaves a recording that someone is already stopping alone', async () => {
      const t = setup();
      t.setApps([zoom]);
      t.start();
      t.setApps([]);
      t.capture.phase = 'stopping';
      await vi.advanceTimersByTimeAsync(CALL_NATIVE_RELEASE_MS);
      expect(t.stops).toEqual([]);
      expect(t.notices).toEqual([]);
    });

    it('waits 60 s after a wake, and decides nothing while asleep', async () => {
      const t = setup();
      t.setApps([zoom]);
      t.start();
      t.power('suspend');
      t.setApps([]);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(t.stops).toEqual([]);
      t.power('resume');
      await vi.advanceTimersByTimeAsync(CALL_WAKE_GRACE_MS - 1);
      expect(t.stops).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.stops).toEqual([{ reason: 'call-ended', detail: 'Zoom' }]);
    });

    it('does not take a lost monitor for the end of the call', async () => {
      const t = setup();
      t.setApps([zoom]);
      t.start();
      t.loseMonitor();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(t.stops).toEqual([]);
    });
  });

  describe('status', () => {
    it('shows the call app the recording follows, and nothing when idle', () => {
      const t = setup();
      expect(t.trigger()).toBeNull();
      t.setApps([zoom]);
      expect(t.trigger()).toBeNull();
      t.start();
      expect(t.trigger()).toEqual({ bundleId: 'us.zoom.xos', name: 'Zoom' });
      t.end();
      expect(t.trigger()).toBeNull();
    });

    it('refreshes the status when the followed app changes', () => {
      const t = setup();
      t.start();
      const before = t.capture.refreshed;
      t.setApps([zoom]);
      expect(t.capture.refreshed).toBeGreaterThan(before);
    });
  });

  it('stops its timer at quit', async () => {
    const t = setup();
    t.setApps([zoom]);
    await t.callOffer.quitHook.run();
    vi.advanceTimersByTime(60_000);
    expect(t.offers).toEqual([]);
  });
});
