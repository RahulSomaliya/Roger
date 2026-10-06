import { useEffect, useMemo, useState } from 'react';
import type { CaptureApi } from '../../../shared/ipc/capture';
import type { Unsubscribe } from '../../../shared/ipc/unsubscribe';
import type { TranscriptSegment } from '../../../shared/transcript';
import {
  addStoredLines,
  applyTranscriptActions,
  type LiveTranscriptState,
  openMeeting,
  type TranscriptAction,
  type TranscriptItem,
  transcriptItems,
} from './liveTranscript';

/** The part of `window.roger` the panel listens to. */
export type TranscriptEvents = Pick<
  CaptureApi,
  'onTranscriptSegment' | 'onTranscriptInterim' | 'onTranscriptSegmentChanged'
>;

/**
 * Listens to main's three transcript events (a final line, an interim, a line the echo filter
 * changed) and hands each on as a model action. Every event goes on: the model ignores those of
 * another meeting. Returns the function that stops all three.
 */
export function subscribeToTranscript(
  events: TranscriptEvents,
  push: (action: TranscriptAction) => void,
): Unsubscribe {
  const unsubscribes = [
    events.onTranscriptSegment((segment) => {
      push({ type: 'final', segment });
    }),
    events.onTranscriptInterim((interim) => {
      push({ type: 'interim', interim });
    }),
    events.onTranscriptSegmentChanged((change) => {
      push({ type: 'segmentChanged', change });
    }),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

/**
 * Collects events and hands them over once per frame, in arrival order: a burst of interims
 * (several a second per source) or a backlog of lines costs one render, not one each.
 */
export class FrameBatcher<T> {
  private queue: T[] = [];
  private frame: number | null = null;
  private closed = false;

  constructor(
    private readonly flush: (batch: readonly T[]) => void,
    private readonly frames: FrameScheduler,
  ) {}

  push(item: T): void {
    if (this.closed) return;
    this.queue.push(item);
    this.frame ??= this.frames.request(() => {
      this.run();
    });
  }

  /** Drops what still waits: the panel that would draw it is gone. */
  close(): void {
    this.closed = true;
    if (this.frame !== null) this.frames.cancel(this.frame);
    this.frame = null;
    this.queue = [];
  }

  private run(): void {
    this.frame = null;
    // Never empty: a frame is asked for only by a push, and close() cancels it.
    const batch = this.queue;
    this.queue = [];
    this.flush(batch);
  }
}

/**
 * Animation frames. A hidden window gets none (Chromium's background throttling; M5-T11 hides the
 * window on close while a recording goes on), so events wait and draw in one batch once it shows,
 * and a panel nobody sees does no layout meanwhile. Nothing is lost: the queue keeps every event.
 */
const animationFrames: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => {
    window.cancelAnimationFrame(handle);
  },
};

/** The model, and the stored lines it last merged, to skip merging the same array again. */
export interface TranscriptPanelState {
  transcript: LiveTranscriptState;
  storedLines: readonly TranscriptSegment[];
}

/**
 * The panel's state for the meeting and stored lines it is given now: a new meeting starts over
 * from its own stored lines, and stored lines the page reads again are merged. Returns `panel`
 * itself when nothing changes, which the hook relies on: it sets this state while rendering, so a
 * page that passes a fresh but equal array every render must not get a new object back, or React
 * renders again forever.
 */
export function followProps(
  panel: TranscriptPanelState,
  meetingId: string,
  storedLines: readonly TranscriptSegment[],
): TranscriptPanelState {
  if (panel.transcript.meetingId !== meetingId) {
    return { transcript: openMeeting(meetingId, storedLines), storedLines };
  }
  if (panel.storedLines === storedLines) return panel;
  const transcript = addStoredLines(panel.transcript, storedLines);
  return transcript === panel.transcript ? panel : { transcript, storedLines };
}

export interface LiveTranscriptOptions {
  meetingId: string;
  /**
   * The meeting's lines as main's store holds them: all of them for a past meeting, those so far
   * for the one recording. A new array is merged; the panel keeps the lines it already has.
   */
  storedLines: readonly TranscriptSegment[];
  /** Show the lines the echo filter hid, marked as echo (M2-T20's control). */
  showHidden: boolean;
}

/**
 * One meeting's transcript, live: its stored lines, then main's events for it, drawn once per
 * animation frame. A past meeting uses it too; no event comes for it, so it shows what is stored.
 */
export function useLiveTranscript({
  meetingId,
  storedLines,
  showHidden,
}: LiveTranscriptOptions): readonly TranscriptItem[] {
  const [panel, setPanel] = useState<TranscriptPanelState>(() => ({
    transcript: openMeeting(meetingId, storedLines),
    storedLines,
  }));
  // State that follows a prop, set while rendering (React's documented pattern): React renders
  // again at once, so the previous meeting's lines never reach the screen under the new id.
  const current = followProps(panel, meetingId, storedLines);
  if (current !== panel) setPanel(current);

  useEffect(() => {
    const batcher = new FrameBatcher<TranscriptAction>((actions) => {
      setPanel((previous) => {
        const transcript = applyTranscriptActions(previous.transcript, actions);
        return transcript === previous.transcript ? previous : { ...previous, transcript };
      });
    }, animationFrames);
    // Read here, not while rendering: window.roger is the preload's (or the preview's fake), and
    // a render under Node (the tests) has no window.
    const unsubscribe = subscribeToTranscript(window.roger, (action) => {
      batcher.push(action);
    });
    return () => {
      unsubscribe();
      batcher.close();
    };
  }, []);

  return useMemo(
    () => transcriptItems(current.transcript, showHidden),
    [current.transcript, showHidden],
  );
}
