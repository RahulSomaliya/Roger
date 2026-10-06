import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TranscriptSegmentChange } from '../../../shared/capture';
import type { InterimTranscript, TranscriptSegment } from '../../../shared/transcript';
import { openMeeting, type TranscriptAction, type TranscriptItem } from './liveTranscriptModel';
import {
  FrameBatcher,
  type FrameScheduler,
  followProps,
  subscribeToTranscript,
  type TranscriptEvents,
  useLiveTranscript,
} from './useLiveTranscript';

const MEETING = '9b2e6f10-7c4d-4a5b-8e3f-61a0c2d9e874';
const NEXT_MEETING = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';

function line(id: string, startMs: number, text: string, meetingId = MEETING): TranscriptSegment {
  return {
    id,
    meetingId,
    source: 'system',
    speaker: 'them',
    startMs,
    endMs: startMs + 900,
    text,
    confidence: null,
    words: null,
    createdAt: '2026-10-06T10:00:00.000Z',
  };
}

/** Frames that run only when the test says, as a hidden window gets none until it shows. */
function manualFrames() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const frames: FrameScheduler = {
    request: (callback) => {
      const handle = next;
      next += 1;
      pending.set(handle, callback);
      return handle;
    },
    cancel: (handle) => {
      pending.delete(handle);
    },
  };
  return {
    frames,
    pending,
    runFrame: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
}

describe('FrameBatcher', () => {
  it('applies every event of a frame in one batch, in arrival order', () => {
    const { frames, pending, runFrame } = manualFrames();
    const flush = vi.fn<(batch: readonly string[]) => void>();
    const batcher = new FrameBatcher(flush, frames);

    batcher.push('final 1');
    batcher.push('interim 2');
    batcher.push('final 2');
    expect(pending.size).toBe(1);
    expect(flush).not.toHaveBeenCalled();

    runFrame();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(['final 1', 'interim 2', 'final 2']);

    batcher.push('final 3');
    runFrame();
    expect(flush).toHaveBeenLastCalledWith(['final 3']);
  });

  it('asks for no frame while nothing waits', () => {
    const { frames, pending, runFrame } = manualFrames();
    const flush = vi.fn<(batch: readonly string[]) => void>();
    const batcher = new FrameBatcher(flush, frames);
    batcher.push('one');
    runFrame();
    expect(pending.size).toBe(0);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('after close, drops what waits and everything later', () => {
    const { frames, pending, runFrame } = manualFrames();
    const flush = vi.fn<(batch: readonly string[]) => void>();
    const batcher = new FrameBatcher(flush, frames);
    batcher.push('queued');
    batcher.close();
    expect(pending.size).toBe(0);

    batcher.push('late');
    runFrame();
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('subscribeToTranscript', () => {
  function fakeEvents() {
    const listeners = {
      segment: new Set<(segment: TranscriptSegment) => void>(),
      interim: new Set<(interim: InterimTranscript) => void>(),
      changed: new Set<(change: TranscriptSegmentChange) => void>(),
    };
    const subscribe =
      <T>(set: Set<(value: T) => void>) =>
      (listener: (value: T) => void) => {
        set.add(listener);
        return () => {
          set.delete(listener);
        };
      };
    const events: TranscriptEvents = {
      onTranscriptSegment: subscribe(listeners.segment),
      onTranscriptInterim: subscribe(listeners.interim),
      onTranscriptSegmentChanged: subscribe(listeners.changed),
    };
    return { events, listeners };
  }

  it('turns main events into model actions, and stops on unsubscribe', () => {
    const { events, listeners } = fakeEvents();
    const actions: TranscriptAction[] = [];
    const unsubscribe = subscribeToTranscript(events, (action) => actions.push(action));

    const segment = line('a', 1000, 'Thanks for making the time.');
    const interim: InterimTranscript = {
      meetingId: MEETING,
      source: 'mic',
      text: 'of course',
      startMs: 2000,
      endMs: 2600,
    };
    const change: TranscriptSegmentChange = {
      meetingId: MEETING,
      segmentId: 'a',
      source: 'system',
      change: 'trimmed',
      reason: 'echo',
      echoOf: 'b',
      text: 'Thanks.',
    };
    for (const listener of listeners.segment) listener(segment);
    for (const listener of listeners.interim) listener(interim);
    for (const listener of listeners.changed) listener(change);
    expect(actions).toEqual([
      { type: 'final', segment },
      { type: 'interim', interim },
      { type: 'segmentChanged', change },
    ]);

    unsubscribe();
    expect(listeners.segment.size + listeners.interim.size + listeners.changed.size).toBe(0);
  });
});

describe('followProps', () => {
  const stored = [line('a', 1000, 'one'), line('b', 2000, 'two')];

  it('keeps the panel while the same meeting and lines come again', () => {
    const panel = { transcript: openMeeting(MEETING, stored), storedLines: stored };
    expect(followProps(panel, MEETING, stored)).toBe(panel);
    // A page that builds a new array of the same lines on every render must not re-render
    // forever: the panel stays the same object.
    expect(followProps(panel, MEETING, [...stored])).toBe(panel);
    expect(followProps(panel, MEETING, [])).toBe(panel);
  });

  it('merges stored lines that arrive later, without doubles', () => {
    const panel = { transcript: openMeeting(MEETING, []), storedLines: [] };
    const next = followProps(panel, MEETING, stored);
    expect(next.transcript.finals.map((final) => final.id)).toEqual(['a', 'b']);
    expect(
      followProps(next, MEETING, [...stored, line('c', 3000, 'three')]).transcript.finals,
    ).toHaveLength(3);
  });

  it('a new meeting starts over from its own stored lines', () => {
    const panel = { transcript: openMeeting(MEETING, stored), storedLines: stored };
    const nextLines = [line('x', 500, 'other meeting', NEXT_MEETING)];
    const next = followProps(panel, NEXT_MEETING, nextLines);
    expect(next.transcript.meetingId).toBe(NEXT_MEETING);
    expect(next.transcript.finals.map((final) => final.id)).toEqual(['x']);
  });
});

describe('useLiveTranscript', () => {
  function Probe(props: {
    storedLines: readonly TranscriptSegment[];
    showHidden: boolean;
    onItems: (items: readonly TranscriptItem[]) => void;
  }) {
    props.onItems(
      useLiveTranscript({
        meetingId: MEETING,
        storedLines: props.storedLines,
        showHidden: props.showHidden,
      }),
    );
    return null;
  }

  // Server rendering runs no effects, so this checks the first render only: the stored lines,
  // in order, and no subscription to a window.roger that Node does not have.
  it('draws the stored lines on the first render, before any event', () => {
    const seen: (readonly TranscriptItem[])[] = [];
    renderToString(
      createElement(Probe, {
        storedLines: [line('b', 2000, 'second'), line('a', 1000, 'first')],
        showHidden: false,
        onItems: (items) => seen.push(items),
      }),
    );
    expect(seen.at(-1)?.map((item) => item.text)).toEqual(['first', 'second']);
  });
});
