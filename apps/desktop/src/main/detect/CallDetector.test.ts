import { describe, expect, it } from 'vitest';
import {
  CALL_BROWSER_OFFER_DELAY_MS,
  CALL_BROWSER_RELEASE_MS,
  CALL_NATIVE_OFFER_DELAY_MS,
  CALL_NATIVE_RELEASE_MS,
  CALL_WAKE_GRACE_MS,
  CallDetector,
} from './CallDetector';
import type { DetectedCallApp } from './callApps';

const zoom: DetectedCallApp = { bundleId: 'us.zoom.xos', name: 'Zoom', kind: 'native' };
const chrome: DetectedCallApp = {
  bundleId: 'com.google.Chrome',
  name: 'Google Chrome',
  kind: 'browser',
};
const facetime: DetectedCallApp = {
  bundleId: 'com.apple.FaceTime',
  name: 'FaceTime or phone call',
  kind: 'native',
};

describe('CallDetector offers', () => {
  it('offers a native app after 5 s of mic use, and not before', () => {
    const detector = new CallDetector();
    detector.setApps([zoom], 1_000);
    expect(detector.dueOffers(1_000 + CALL_NATIVE_OFFER_DELAY_MS - 1)).toEqual([]);
    expect(detector.dueOffers(1_000 + CALL_NATIVE_OFFER_DELAY_MS)).toEqual([zoom]);
  });

  it('offers a browser after 15 s', () => {
    const detector = new CallDetector();
    detector.setApps([chrome], 0);
    expect(detector.dueOffers(CALL_NATIVE_OFFER_DELAY_MS)).toEqual([]);
    expect(detector.dueOffers(CALL_BROWSER_OFFER_DELAY_MS - 1)).toEqual([]);
    expect(detector.dueOffers(CALL_BROWSER_OFFER_DELAY_MS)).toEqual([chrome]);
  });

  it('offers an app once per spell of mic use', () => {
    const detector = new CallDetector();
    detector.setApps([zoom], 0);
    expect(detector.dueOffers(6_000)).toEqual([zoom]);
    expect(detector.dueOffers(60_000)).toEqual([]);
    // The same list again (a new app joined) does not restart the spell of the one already there.
    detector.setApps([zoom, chrome], 70_000);
    expect(detector.dueOffers(75_000)).toEqual([]);
  });

  it('offers again when the mic comes back to the app after it let go', () => {
    const detector = new CallDetector();
    detector.setApps([zoom], 0);
    detector.dueOffers(6_000);
    detector.setApps([], 7_000);
    detector.setApps([zoom], 9_000);
    expect(detector.dueOffers(9_000 + CALL_NATIVE_OFFER_DELAY_MS - 1)).toEqual([]);
    expect(detector.dueOffers(9_000 + CALL_NATIVE_OFFER_DELAY_MS)).toEqual([zoom]);
  });

  it('never offers an app that let go before its delay', () => {
    const detector = new CallDetector();
    detector.setApps([zoom], 0);
    detector.setApps([], 3_000);
    expect(detector.dueOffers(60_000)).toEqual([]);
  });

  it('offers nothing while a recording runs, and does not re-offer the call it was started in', () => {
    const detector = new CallDetector();
    detector.setApps([zoom], 0);
    detector.startRecording();
    expect(detector.dueOffers(10_000)).toEqual([]);
    detector.setApps([zoom, chrome], 11_000);
    expect(detector.dueOffers(60_000)).toEqual([]);
    detector.endRecording();
    // Stopped by hand mid-call: Zoom has been on the mic all along, so no card five seconds later.
    expect(detector.dueOffers(70_000)).toEqual([]);
  });

  it('does not offer, once a recording is over, a call that began during it', () => {
    const detector = new CallDetector();
    detector.startRecording();
    detector.setApps([zoom], 1_000);
    detector.endRecording();
    expect(detector.dueOffers(60_000)).toEqual([]);
  });

  it('names when the next offer is due', () => {
    const detector = new CallDetector();
    expect(detector.nextDeadlineMs()).toBeNull();
    detector.setApps([chrome], 1_000);
    expect(detector.nextDeadlineMs()).toBe(1_000 + CALL_BROWSER_OFFER_DELAY_MS);
    detector.setApps([chrome, zoom], 2_000);
    expect(detector.nextDeadlineMs()).toBe(2_000 + CALL_NATIVE_OFFER_DELAY_MS);
    detector.dueOffers(2_000 + CALL_NATIVE_OFFER_DELAY_MS);
    expect(detector.nextDeadlineMs()).toBe(1_000 + CALL_BROWSER_OFFER_DELAY_MS);
  });
});

describe('CallDetector auto-stop', () => {
  it('stops 15 s after a native app lets go of the mic', () => {
    const detector = new CallDetector();
    detector.setApps([zoom], 0);
    detector.startRecording();
    detector.setApps([], 100_000);
    expect(detector.stopDue(100_000 + CALL_NATIVE_RELEASE_MS - 1)).toBeNull();
    expect(detector.stopDue(100_000 + CALL_NATIVE_RELEASE_MS)).toEqual({
      bundleId: 'us.zoom.xos',
      name: 'Zoom',
    });
  });

  it('waits 30 s for a browser', () => {
    const detector = new CallDetector();
    detector.setApps([chrome], 0);
    detector.startRecording();
    detector.setApps([], 100_000);
    expect(detector.stopDue(100_000 + CALL_NATIVE_RELEASE_MS)).toBeNull();
    expect(detector.stopDue(100_000 + CALL_BROWSER_RELEASE_MS - 1)).toBeNull();
    expect(detector.stopDue(100_000 + CALL_BROWSER_RELEASE_MS)?.name).toBe('Google Chrome');
  });

  it('does not stop for a 2 s release (AirPods connecting move the mic between devices)', () => {
    const detector = new CallDetector();
    detector.setApps([zoom], 0);
    detector.startRecording();
    detector.setApps([], 50_000);
    detector.setApps([zoom], 52_000);
    expect(detector.stopDue(200_000)).toBeNull();
    expect(detector.nextDeadlineMs()).toBeNull();
  });

  it('keeps the whole debounce of the app that let go last', () => {
    const detector = new CallDetector();
    detector.setApps([zoom, chrome], 0);
    detector.startRecording();
    // Zoom leaves, Chrome stays: still a call.
    detector.setApps([chrome], 10_000);
    detector.setApps([], 20_000);
    expect(detector.stopDue(20_000 + CALL_NATIVE_RELEASE_MS)).toBeNull();
    expect(detector.stopDue(20_000 + CALL_BROWSER_RELEASE_MS)?.name).toBe('Google Chrome');
  });

  it('follows a call app that arrives after Start', () => {
    const detector = new CallDetector();
    detector.startRecording();
    expect(detector.trigger).toBeNull();
    detector.setApps([facetime], 4_000);
    expect(detector.trigger).toEqual({
      bundleId: 'com.apple.FaceTime',
      name: 'FaceTime or phone call',
    });
    detector.setApps([], 9_000);
    expect(detector.trigger?.name).toBe('FaceTime or phone call');
    expect(detector.stopDue(9_000 + CALL_NATIVE_RELEASE_MS)).not.toBeNull();
  });

  it('never stops a manual start in which no call app was seen', () => {
    const detector = new CallDetector();
    detector.startRecording();
    expect(detector.stopDue(10 * 60 * 60_000)).toBeNull();
    expect(detector.nextDeadlineMs()).toBeNull();
    expect(detector.trigger).toBeNull();
  });

  it('never stops when no recording runs, and forgets the trigger at the end of one', () => {
    const detector = new CallDetector();
    detector.setApps([zoom], 0);
    detector.setApps([], 1_000);
    expect(detector.stopDue(100_000)).toBeNull();
    detector.setApps([zoom], 200_000);
    detector.startRecording();
    expect(detector.trigger?.name).toBe('Zoom');
    detector.endRecording();
    expect(detector.trigger).toBeNull();
  });

  it('starts the release clock at 60 s after a wake', () => {
    const detector = new CallDetector();
    detector.setApps([zoom], 0);
    detector.startRecording();
    detector.suspend();
    // Zoom let go while the Mac slept (its call dropped, or the helper saw nothing yet).
    detector.setApps([], 500_000);
    detector.resume(1_000_000);
    expect(detector.stopDue(1_000_000 + CALL_NATIVE_RELEASE_MS)).toBeNull();
    expect(detector.stopDue(1_000_000 + CALL_WAKE_GRACE_MS - 1)).toBeNull();
    expect(detector.stopDue(1_000_000 + CALL_WAKE_GRACE_MS)?.name).toBe('Zoom');
    expect(detector.nextDeadlineMs()).toBe(1_000_000 + CALL_WAKE_GRACE_MS);
  });

  it('applies the wake grace to a release that comes after the wake too', () => {
    const detector = new CallDetector();
    detector.setApps([zoom], 0);
    detector.startRecording();
    detector.suspend();
    detector.resume(1_000_000);
    detector.setApps([], 1_005_000);
    // 15 s after the release is 1_020_000, before the grace ends at 1_060_000.
    expect(detector.stopDue(1_005_000 + CALL_NATIVE_RELEASE_MS)).toBeNull();
    expect(detector.stopDue(1_000_000 + CALL_WAKE_GRACE_MS)?.name).toBe('Zoom');
  });

  it('decides nothing while asleep: a timer that fires first at wake never stops the recording', () => {
    const detector = new CallDetector();
    detector.setApps([zoom], 0);
    detector.startRecording();
    detector.setApps([], 10_000);
    detector.suspend();
    expect(detector.stopDue(1_000_000)).toBeNull();
    expect(detector.nextDeadlineMs()).toBeNull();
  });

  it('ignores a wake outside a recording', () => {
    const detector = new CallDetector();
    detector.resume(5_000);
    detector.setApps([zoom], 6_000);
    detector.startRecording();
    detector.setApps([], 7_000);
    expect(detector.stopDue(7_000 + CALL_NATIVE_RELEASE_MS)?.name).toBe('Zoom');
  });

  it('does not read a lost monitor as the call ending', () => {
    const detector = new CallDetector();
    detector.setApps([zoom], 0);
    detector.startRecording();
    // MeetingAppMonitor reports an empty list when its helper is out of restarts: Zoom is still up.
    detector.lose();
    expect(detector.stopDue(10 * 60_000)).toBeNull();
    expect(detector.nextDeadlineMs()).toBeNull();
    expect(detector.trigger?.name).toBe('Zoom');
  });

  it('asks for one stop per recording: a stop under way leaves nothing due', () => {
    const detector = new CallDetector();
    detector.setApps([zoom], 0);
    detector.startRecording();
    detector.setApps([], 1_000);
    expect(detector.stopDue(1_000 + CALL_NATIVE_RELEASE_MS)?.name).toBe('Zoom');
    detector.stopRequested();
    expect(detector.stopDue(1_000 + CALL_NATIVE_RELEASE_MS)).toBeNull();
    // Or its caller's timer would fire again at once, for a deadline already past, until Stop ends.
    expect(detector.nextDeadlineMs()).toBeNull();
    expect(detector.trigger?.name).toBe('Zoom');
  });
});
