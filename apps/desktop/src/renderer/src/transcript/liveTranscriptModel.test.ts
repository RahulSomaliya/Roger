import { describe, expect, it } from 'vitest';
import type { TranscriptSegmentChange } from '../../../shared/capture';
import type { AudioSource, InterimTranscript, TranscriptSegment } from '../../../shared/transcript';
import { SPEAKER_FOR_SOURCE } from '../../../shared/transcript';
import {
  addFinal,
  addStoredLines,
  applyTranscriptActions,
  followScroll,
  isFollowing,
  jumpToLive,
  openMeeting,
  pauseFollow,
  segmentChanged,
  setInterim,
  startFollow,
  transcriptItems,
  type FollowState,
  type LiveTranscriptState,
  type ScrollMetrics,
} from './liveTranscriptModel';

const MEETING = '9b2e6f10-7c4d-4a5b-8e3f-61a0c2d9e874';
const OTHER_MEETING = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';

function final(
  id: string,
  source: AudioSource,
  startMs: number,
  endMs: number,
  text = `line ${id}`,
  meetingId = MEETING,
): TranscriptSegment {
  return {
    id,
    meetingId,
    source,
    speaker: SPEAKER_FOR_SOURCE[source],
    startMs,
    endMs,
    text,
    confidence: 0.9,
    words: null,
    createdAt: '2026-10-06T10:00:00.000Z',
  };
}

function interim(
  source: AudioSource,
  startMs: number,
  endMs: number,
  text: string,
  meetingId = MEETING,
): InterimTranscript {
  return { meetingId, source, startMs, endMs, text };
}

function changed(
  segmentId: string,
  change: TranscriptSegmentChange['change'],
  text: string,
  meetingId = MEETING,
): TranscriptSegmentChange {
  return {
    meetingId,
    segmentId,
    source: 'mic',
    change,
    reason: 'echo',
    echoOf: change === 'unhidden' ? null : 'twin',
    text,
  };
}

/** What the panel shows, one string per row: `<kind> <source> <text>`, hidden lines marked. */
function rows(state: LiveTranscriptState, showHidden = false): string[] {
  return transcriptItems(state, showHidden).map((item) =>
    item.kind === 'interim'
      ? `interim ${item.source} ${item.text}`
      : `${item.hidden ? 'echo' : 'final'} ${item.source} ${item.text}`,
  );
}

const ids = (state: LiveTranscriptState): string[] =>
  transcriptItems(state, true).flatMap((item) => (item.kind === 'final' ? [item.id] : []));

describe('the live transcript model', () => {
  it('starts with the meeting stored lines, in order, and nothing else', () => {
    const state = openMeeting(MEETING, [
      final('b', 'system', 2000, 3000, 'second'),
      final('a', 'mic', 1000, 1800, 'first'),
    ]);
    expect(rows(state)).toEqual(['final mic first', 'final system second']);
  });

  it('a final replaces its own source interim', () => {
    let state = setInterim(openMeeting(MEETING), interim('mic', 1000, 2400, 'so the main'));
    expect(rows(state)).toEqual(['interim mic so the main']);

    state = addFinal(state, final('a', 'mic', 1000, 3100, 'So the main thing is the renewal.'));
    expect(rows(state)).toEqual(['final mic So the main thing is the renewal.']);
  });

  it('the other source interim survives a final', () => {
    let state = openMeeting(MEETING);
    state = setInterim(state, interim('system', 1500, 2600, 'legal wants'));
    state = setInterim(state, interim('mic', 1000, 2400, 'so the'));
    state = addFinal(state, final('a', 'mic', 1000, 3100, 'So the price moved.'));
    expect(rows(state)).toEqual(['final mic So the price moved.', 'interim system legal wants']);
  });

  it('the next turn interim survives a late final of the turn before', () => {
    // AssemblyAI holds a raw turn for its formatted copy while the next turn's partials arrive.
    let state = setInterim(openMeeting(MEETING), interim('system', 5200, 6000, 'is there'));
    state = addFinal(state, final('a', 'system', 1000, 5000, 'Right, that is what I expected.'));
    expect(rows(state)).toEqual([
      'final system Right, that is what I expected.',
      'interim system is there',
    ]);
  });

  it('an interim no newer than that source last final is dropped', () => {
    let state = addFinal(openMeeting(MEETING), final('a', 'mic', 1000, 3100, 'Of course.'));
    state = setInterim(state, interim('mic', 1000, 2400, 'of'));
    state = setInterim(state, interim('mic', 1000, 3100, 'of course'));
    expect(rows(state)).toEqual(['final mic Of course.']);

    // The other source has no final yet, so its interim is not stale.
    state = setInterim(state, interim('system', 1000, 2000, 'thanks'));
    expect(rows(state)).toEqual(['final mic Of course.', 'interim system thanks']);
  });

  it('a newer interim replaces the source interim whole, and a blank one clears it', () => {
    let state = setInterim(openMeeting(MEETING), interim('mic', 1000, 1500, 'so'));
    state = setInterim(state, interim('mic', 1000, 2200, 'so the main'));
    expect(rows(state)).toEqual(['interim mic so the main']);

    state = setInterim(state, interim('mic', 1000, 2300, '  '));
    expect(rows(state)).toEqual([]);
  });

  it('sorts lines by start, then mic before system, then id', () => {
    let state = openMeeting(MEETING);
    for (const segment of [
      final('d', 'system', 3000, 3500),
      final('c', 'system', 1000, 1500),
      final('b', 'mic', 1000, 1400),
      final('a2', 'mic', 500, 900),
      final('a1', 'mic', 500, 900),
      final('e', 'mic', 4000, 4500),
    ]) {
      state = addFinal(state, segment);
    }
    expect(ids(state)).toEqual(['a1', 'a2', 'b', 'c', 'd', 'e']);
  });

  it('puts interims in time order among the other lines', () => {
    let state = openMeeting(MEETING, [
      final('a', 'system', 0, 900, 'one'),
      final('b', 'mic', 1000, 1900, 'two'),
      final('c', 'system', 4000, 4900, 'four'),
    ]);
    state = setInterim(state, interim('mic', 3000, 3600, 'three'));
    state = setInterim(state, interim('system', 5000, 5400, 'five'));
    expect(rows(state)).toEqual([
      'final system one',
      'final mic two',
      'interim mic three',
      'final system four',
      'interim system five',
    ]);
  });

  it('ignores a final sent again, whatever it says the second time', () => {
    let state = addFinal(openMeeting(MEETING), final('a', 'mic', 1000, 2000, 'Of course.'));
    const before = state;
    state = addFinal(state, final('a', 'mic', 1000, 2000, 'Of course, again.'));
    expect(state).toBe(before);
    expect(rows(state)).toEqual(['final mic Of course.']);
  });

  it('merges stored lines that arrive after live ones, without doubles', () => {
    let state = addFinal(openMeeting(MEETING), final('c', 'mic', 5000, 6000, 'live'));
    state = addStoredLines(state, [
      final('a', 'system', 1000, 2000, 'stored one'),
      final('c', 'mic', 5000, 6000, 'live'),
      final('b', 'mic', 3000, 4000, 'stored two'),
    ]);
    expect(rows(state)).toEqual([
      'final system stored one',
      'final mic stored two',
      'final mic live',
    ]);
  });

  it('ignores every event for another meeting', () => {
    const start = addFinal(openMeeting(MEETING), final('a', 'mic', 1000, 2000, 'ours'));
    let state = addFinal(start, final('x', 'system', 1500, 2500, 'theirs', OTHER_MEETING));
    state = setInterim(state, interim('system', 3000, 3500, 'theirs too', OTHER_MEETING));
    state = segmentChanged(state, changed('a', 'hidden', 'ours', OTHER_MEETING));
    state = addStoredLines(state, [final('y', 'mic', 100, 200, 'stored', OTHER_MEETING)]);
    expect(state).toBe(start);
  });

  it('a new meeting clears all, hidden ids and held changes too', () => {
    let state = addFinal(openMeeting(MEETING), final('a', 'mic', 1000, 2000, 'hidden one'));
    state = segmentChanged(state, changed('a', 'hidden', 'hidden one'));
    state = segmentChanged(state, changed('held', 'hidden', 'held one'));
    state = setInterim(state, interim('system', 2500, 3000, 'interim'));
    expect(rows(state, true)).toEqual(['echo mic hidden one', 'interim system interim']);
    expect([...state.heldChanges.keys()]).toEqual(['held']);

    let next = openMeeting(OTHER_MEETING);
    expect(rows(next, true)).toEqual([]);
    // The old meeting's hide and its held change do not reach lines of the new one.
    next = addFinal(next, final('a', 'mic', 1000, 2000, 'shown', OTHER_MEETING));
    next = addFinal(next, final('held', 'mic', 3000, 4000, 'also shown', OTHER_MEETING));
    expect(rows(next)).toEqual(['final mic shown', 'final mic also shown']);
  });

  it('never changes the state it is given', () => {
    // React may run an update twice (StrictMode) and keeps the old state for the last render.
    const before = setInterim(
      openMeeting(MEETING, [final('a', 'mic', 1000, 2000, 'stored')]),
      interim('system', 1500, 2500, 'so'),
    );
    const snapshot = JSON.stringify({
      rows: rows(before, true),
      held: [...before.heldChanges.keys()],
      ids: [...before.byId.keys()],
      lastFinalEndMs: before.lastFinalEndMs,
    });
    applyTranscriptActions(before, [
      { type: 'final', segment: final('b', 'system', 1500, 3000, 'new') },
      { type: 'segmentChanged', change: changed('a', 'hidden', 'stored') },
      { type: 'segmentChanged', change: changed('later', 'hidden', 'held') },
    ]);
    expect(
      JSON.stringify({
        rows: rows(before, true),
        held: [...before.heldChanges.keys()],
        ids: [...before.byId.keys()],
        lastFinalEndMs: before.lastFinalEndMs,
      }),
    ).toBe(snapshot);
  });

  it('applies a batch of events in arrival order', () => {
    const state = applyTranscriptActions(openMeeting(MEETING), [
      { type: 'interim', interim: interim('mic', 1000, 1500, 'so') },
      { type: 'final', segment: final('a', 'mic', 1000, 2000, 'So.') },
      { type: 'interim', interim: interim('mic', 2500, 3000, 'next') },
      { type: 'segmentChanged', change: changed('a', 'trimmed', 'So') },
      { type: 'stored', lines: [final('z', 'system', 0, 500, 'stored')] },
    ]);
    expect(rows(state)).toEqual(['final system stored', 'final mic So', 'interim mic next']);
  });

  it('keeps a long call in order as lines arrive out of order', () => {
    // Two hours of lines, about one every 3.6 s per source, each source a little late.
    let state = openMeeting(MEETING);
    const expected: string[] = [];
    for (let index = 0; index < 2000; index += 1) {
      const startMs = index * 3600;
      expected.push(`m${String(index).padStart(4, '0')}`, `s${String(index).padStart(4, '0')}`);
      state = addFinal(
        state,
        final(`s${String(index).padStart(4, '0')}`, 'system', startMs, startMs + 3000),
      );
      state = addFinal(
        state,
        final(`m${String(index).padStart(4, '0')}`, 'mic', startMs, startMs + 3000),
      );
    }
    expect(ids(state)).toEqual(expected);
  });
});

describe('segment changes (the echo filter, M2-T14b)', () => {
  const shown = (): LiveTranscriptState =>
    openMeeting(MEETING, [
      final('them', 'system', 1000, 3000, 'Legal wants the addendum signed.'),
      final('me', 'mic', 1100, 3100, 'Legal wants the addendum signed.'),
    ]);

  it('hidden after display hides the line and keeps it', () => {
    const state = segmentChanged(
      shown(),
      changed('me', 'hidden', 'Legal wants the addendum signed.'),
    );
    expect(rows(state)).toEqual(['final system Legal wants the addendum signed.']);
    expect(ids(state)).toEqual(['them', 'me']);
  });

  it('hidden before display (a held line) hides the line when it arrives', () => {
    let state = openMeeting(MEETING, [final('them', 'system', 1000, 3000, 'Thanks for the time.')]);
    state = segmentChanged(state, changed('me', 'hidden', 'Thanks for the time.'));
    expect(rows(state)).toEqual(['final system Thanks for the time.']);

    state = addFinal(state, final('me', 'mic', 1100, 3100, 'Thanks for the time.'));
    expect(rows(state)).toEqual(['final system Thanks for the time.']);
    expect(rows(state, true)).toEqual([
      'final system Thanks for the time.',
      'echo mic Thanks for the time.',
    ]);
  });

  it('a held change reaches a line that comes with the stored lines', () => {
    let state = segmentChanged(openMeeting(MEETING), changed('me', 'trimmed', 'Of course.'));
    state = addStoredLines(state, [final('me', 'mic', 1000, 2000, 'Of course. Happy to be here.')]);
    expect(rows(state)).toEqual(['final mic Of course.']);
  });

  it('the latest held change for a line wins', () => {
    let state = segmentChanged(openMeeting(MEETING), changed('me', 'hidden', 'Right.'));
    state = segmentChanged(state, changed('me', 'unhidden', 'Right.'));
    state = addFinal(state, final('me', 'mic', 1000, 2000, 'Right.'));
    expect(rows(state)).toEqual(['final mic Right.']);
  });

  it('trimmed replaces the text', () => {
    const state = segmentChanged(shown(), changed('me', 'trimmed', 'Signed.'));
    expect(rows(state)).toEqual([
      'final system Legal wants the addendum signed.',
      'final mic Signed.',
    ]);
  });

  it('unhidden shows the line again', () => {
    let state = segmentChanged(
      shown(),
      changed('me', 'hidden', 'Legal wants the addendum signed.'),
    );
    state = segmentChanged(state, changed('me', 'unhidden', 'Legal wants the addendum signed.'));
    expect(rows(state)).toEqual([
      'final system Legal wants the addendum signed.',
      'final mic Legal wants the addendum signed.',
    ]);
  });

  it('showHidden on shows hidden lines marked as echo, off hides them again', () => {
    const state = segmentChanged(
      shown(),
      changed('me', 'hidden', 'Legal wants the addendum signed.'),
    );
    expect(rows(state, true)).toEqual([
      'final system Legal wants the addendum signed.',
      'echo mic Legal wants the addendum signed.',
    ]);
    expect(rows(state, false)).toEqual(['final system Legal wants the addendum signed.']);
  });

  it('keeps every line object it did not change, so unchanged rows need no render', () => {
    const before = shown();
    const after = segmentChanged(before, changed('me', 'trimmed', 'Signed.'));
    const [themBefore] = transcriptItems(before, false);
    const [themAfter] = transcriptItems(after, false);
    expect(themAfter).toBe(themBefore);
  });
});

describe('following live', () => {
  // A 400 px tall view over 2000 px of lines: the bottom is at scrollTop 1600.
  const at = (scrollTop: number, scrollHeight = 2000): ScrollMetrics => ({
    scrollTop,
    scrollHeight,
    clientHeight: 400,
  });

  const scrolled = (state: FollowState, ...tops: number[]): FollowState =>
    tops.reduce((current, top) => followScroll(current, at(top)), state);

  it('a live meeting follows from the start, a past one does not', () => {
    expect(isFollowing(startFollow(true))).toBe(true);
    expect(isFollowing(startFollow(false))).toBe(false);
  });

  it('keeps following while the view stays at the bottom', () => {
    expect(isFollowing(scrolled(startFollow(true), 1600, 1590))).toBe(true);
  });

  it('pauses when the reader scrolls up, and follows again back at the bottom', () => {
    const paused = scrolled(startFollow(true), 1600, 1200);
    expect(isFollowing(paused)).toBe(false);
    expect(isFollowing(scrolled(paused, 1400))).toBe(false);
    expect(isFollowing(scrolled(paused, 1400, 1600))).toBe(true);
  });

  it('never pauses on a scroll down, such as following to new lines', () => {
    expect(isFollowing(scrolled(startFollow(true), 1000, 1500))).toBe(true);
  });

  it('a pause from a citation holds, even where its scroll lands at the bottom', () => {
    const held = pauseFollow(startFollow(true));
    expect(isFollowing(held)).toBe(false);
    expect(isFollowing(scrolled(held, 1600))).toBe(false);
    // The reader takes over by scrolling up; the bottom then follows again.
    expect(isFollowing(scrolled(held, 1600, 1000, 1600))).toBe(true);
  });

  it('Jump to live follows again from anywhere', () => {
    expect(isFollowing(jumpToLive(scrolled(startFollow(true), 1600, 200)))).toBe(true);
    expect(isFollowing(jumpToLive(pauseFollow(startFollow(true))))).toBe(true);
  });

  it('returns the same state when a scroll changes nothing, so React skips the render', () => {
    const following = scrolled(startFollow(true), 1600);
    expect(followScroll(following, at(1600))).toBe(following);
  });
});
