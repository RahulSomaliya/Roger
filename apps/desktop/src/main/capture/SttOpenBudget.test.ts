import { describe, expect, it } from 'vitest';
import { SttOpenBudget } from './SttOpenBudget';

function budget(perMinute = 4, perMeeting = 30) {
  let now = 1_000_000;
  const b = new SttOpenBudget({ perMinute, perMeeting }, () => now);
  b.beginMeeting();
  return {
    b,
    at: (ms: number) => {
      now = 1_000_000 + ms;
    },
  };
}

describe('SttOpenBudget', () => {
  it('allows the per-minute opens in a rolling minute, then says when the next may open', () => {
    const { b, at } = budget();
    expect(b.acquire(2)).toEqual({ ok: true }); // Start: mic and system
    at(10_000);
    expect(b.acquire()).toEqual({ ok: true });
    at(20_000);
    expect(b.acquire()).toEqual({ ok: true });

    at(30_000);
    const refused = b.acquire();
    expect(refused).toEqual({
      ok: false,
      kind: 'per-minute',
      // The two Start opens at 0 s leave the window at 60 s.
      retryAtMs: 1_060_000,
      message:
        "4 speech-to-text sessions opened in the last minute (Roger's limit is 4, " +
        'sttOpensPerMinute); the next may open in 30 s',
    });

    at(59_999);
    expect(b.check().ok).toBe(false);
    at(60_000);
    expect(b.acquire()).toEqual({ ok: true });
  });

  it('grants several opens all or none', () => {
    const { b, at } = budget();
    b.acquire();
    at(1_000);
    b.acquire();
    at(2_000);
    b.acquire();
    const refused = b.acquire(2);
    // Two free slots need the oldest open gone: it leaves the window at 60 s.
    expect(refused).toMatchObject({ ok: false, kind: 'per-minute', retryAtMs: 1_060_000 });
    expect(b.acquire(1)).toEqual({ ok: true }); // nothing was taken by the refused pair
    expect(b.openedThisMeeting).toBe(4);
  });

  it('check() never takes an open', () => {
    const { b } = budget(2);
    expect(b.check(2)).toEqual({ ok: true });
    expect(b.check(2)).toEqual({ ok: true });
    expect(b.openedThisMeeting).toBe(0);
  });

  it('stops for good at the per-meeting cap, whatever the minute window says', () => {
    const { b, at } = budget(4, 5);
    for (let i = 0; i < 5; i += 1) {
      at(i * 60_000);
      expect(b.acquire().ok).toBe(true);
    }
    at(3_600_000);
    expect(b.acquire()).toEqual({
      ok: false,
      kind: 'per-meeting',
      message:
        "5 speech-to-text sessions opened in this meeting (Roger's limit is 5, sttOpensPerMeeting)",
    });
  });

  it('starts each meeting with a fresh count but keeps the minute window, which the vendor counts per account', () => {
    const { b, at } = budget(4, 2);
    b.acquire(2);
    expect(b.acquire().ok).toBe(false); // meeting cap of 2
    b.beginMeeting();
    expect(b.openedThisMeeting).toBe(0);
    expect(b.acquire(2)).toEqual({ ok: true });
    at(5_000);
    b.beginMeeting();
    // Two Starts in five seconds: 4 opens in the minute, so a third Start must wait.
    expect(b.acquire(2)).toMatchObject({ ok: false, kind: 'per-minute', retryAtMs: 1_060_000 });
  });
});

// The gap re-run (M2-T16) and the silence gate's reopens (M3-T20) open in the minute only.
describe('SttOpenBudget, minute-only opens', () => {
  it('takes a slot in the minute window, which every other open then waits behind', () => {
    const { b, at } = budget();
    expect(b.acquire(1, 'minute')).toEqual({ ok: true });
    at(10_000);
    expect(b.acquire(3, 'minute')).toEqual({ ok: true });

    at(20_000);
    // The vendor counts per account: a meeting's Start waits behind a re-run's opens.
    expect(b.acquire(2)).toMatchObject({ ok: false, kind: 'per-minute', retryAtMs: 1_070_000 });
    expect(b.acquire(1, 'minute')).toEqual({
      ok: false,
      kind: 'per-minute',
      retryAtMs: 1_060_000,
      message:
        "4 speech-to-text sessions opened in the last minute (Roger's limit is 4, " +
        'sttOpensPerMinute); the next may open in 40 s',
    });
    expect(b.check(1, 'minute').ok).toBe(false);

    at(60_000);
    expect(b.acquire(1, 'minute')).toEqual({ ok: true });
  });

  it("never spends the meeting's opens", () => {
    const { b, at } = budget(4, 3);
    for (let i = 0; i < 10; i += 1) {
      at(i * 60_000);
      expect(b.acquire(1, 'minute').ok).toBe(true);
    }
    expect(b.openedThisMeeting).toBe(0);
    at(3_600_000);
    expect(b.acquire(3)).toEqual({ ok: true }); // the meeting's whole allowance is still there
  });

  it("goes ahead when the meeting's opens are spent: a re-run after Stop still runs", () => {
    const { b, at } = budget(4, 2);
    b.acquire(2);
    expect(b.check()).toMatchObject({ ok: false, kind: 'per-meeting' });
    at(60_000);
    expect(b.check(1, 'minute')).toEqual({ ok: true });
    expect(b.acquire(1, 'minute')).toEqual({ ok: true });
    expect(b.openedThisMeeting).toBe(2);
  });

  it('takes nothing when refused, and grants several all or none', () => {
    const { b } = budget(4);
    b.acquire(3, 'minute');
    expect(b.acquire(2, 'minute')).toMatchObject({ ok: false, kind: 'per-minute' });
    expect(b.acquire(1)).toEqual({ ok: true }); // the refused pair took no slot
  });
});
