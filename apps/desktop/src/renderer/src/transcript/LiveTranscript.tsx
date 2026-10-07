import {
  memo,
  type RefObject,
  type UIEvent,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { formatOffset } from '../format';
import {
  type FollowMode,
  followScroll,
  scrolledAway,
  type ScrollMetrics,
  startFollow,
  type TranscriptItem,
} from './liveTranscriptModel';
import { useRegisterTranscript } from './transcriptNavigator';
import { type LiveTranscriptOptions, useLiveTranscript } from './useLiveTranscript';
import './transcript.css';

/*
 * The transcript panel (M3-T7), for the meeting recording now and for a past one: M3-T9 mounts it
 * in the meeting page's transcript region, inside the page's CitationNavigatorProvider. The model
 * is liveTranscriptModel.ts; keep every file name in this folder distinct ignoring case (that
 * file's header says why).
 */

export interface LiveTranscriptProps extends LiveTranscriptOptions {
  /**
   * True while this meeting records: the panel follows new lines and offers "Jump to live".
   * Interims do not end on it: main's capture status ends them (useLiveTranscript.ts), as it also
   * says when one source's stream fails mid-call, which this flag never shows.
   */
  live: boolean;
}

const SPEAKER_NAME = { me: 'Me', them: 'Them' } as const;

const EMPTY_LIVE = 'Listening. Lines appear here as people speak.';
const EMPTY_PAST = 'Nothing was transcribed in this meeting.';

export function LiveTranscript(props: LiveTranscriptProps) {
  // Another meeting is another panel: its lines, scroll position, following and registration
  // all start over, so nothing of the last meeting shows under the new one.
  return <TranscriptPanel key={props.meetingId} {...props} />;
}

function TranscriptPanel({ meetingId, storedLines, showHidden, live }: LiveTranscriptProps) {
  const items = useLiveTranscript({ meetingId, storedLines, showHidden });
  // The scroll container twice: as state, so the navigator's handle is built once it exists, and
  // as a ref, which the layout effect may scroll (React refuses writes to a state value).
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const attach = useCallback((element: HTMLDivElement | null) => {
    scroller.current = element;
    setContainer(element);
  }, []);
  const [mode, setMode] = useState<FollowMode>(() => startFollow(live));
  // Where the view was last seen: the last scroll event's position, or where the layout effect
  // last put it, whichever came later (the model's "Following live" says why both). A ref, as the
  // layout effect must set it without a render; read and written only in effects and handlers.
  const lastTop = useRef(0);
  // A page learns that its meeting records after its first render (main's capture status comes
  // later), and a resumed meeting records again: either way the panel follows from then on.
  // State that follows a prop, set while rendering, so the first live frame already follows.
  const [wasLive, setWasLive] = useState(live);
  if (wasLive !== live) {
    setWasLive(live);
    if (live) setMode('live');
  }
  const following = mode === 'live';

  // Citation chips find lines through the navigator (M4-T21), which pauses following before it
  // scrolls; this panel never reveals lines itself. A stable handle registers once per element.
  const pause = useCallback(() => {
    setMode('held');
  }, []);
  const handle = useMemo(
    () => (container === null ? null : { container, pauseFollow: pause }),
    [container, pause],
  );
  useRegisterTranscript(handle);

  // While following, the newest line is in view before the browser paints the new lines.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!following || element === null) return;
    showNewest(element, lastTop);
  }, [following, container, items]);

  // And when the region changes size with no new line: the browser keeps scrollTop when the box
  // gets shorter, so the stop notice appearing above the page after the last line, or the capture
  // status growing, would hide that line under the box's bottom edge, with nothing left to bring
  // it back. Only while following: a reader who scrolled up keeps their place.
  useLayoutEffect(() => {
    if (!following || container === null) return;
    return followSizeChanges(container, lastTop, observeSize);
  }, [following, container]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    const seenAt = lastTop.current;
    lastTop.current = scrollTop;
    setMode((previous) =>
      followScroll(previous, seenAt, { scrollTop, scrollHeight, clientHeight }),
    );
  }, []);

  const jump = (): void => {
    setMode('live');
    // The button goes away once following; keep keyboard focus in the transcript, not on <body>.
    container?.focus({ preventScroll: true });
  };

  return (
    <div className="live-transcript" data-following={following}>
      <div
        ref={attach}
        className="live-transcript-lines"
        role="log"
        aria-label="Transcript"
        tabIndex={0}
        onScroll={onScroll}
      >
        {items.length === 0 ? (
          <p className="live-transcript-empty">{live ? EMPTY_LIVE : EMPTY_PAST}</p>
        ) : (
          items.map((item) => (
            <TranscriptRow
              key={item.kind === 'final' ? item.id : `interim-${item.source}`}
              item={item}
            />
          ))
        )}
      </div>
      {live && !following ? (
        <button type="button" className="jump-to-live" onClick={jump}>
          Jump to live
        </button>
      ) : null}
    </div>
  );
}

/**
 * Puts the newest line in view, at the bottom of `box`. Not when the reader scrolled up since the
 * view was last seen at `lastTop`: their scroll event has not come yet, and scrolling to the
 * bottom first would undo the scroll and make that event read the bottom. Leaving the view, that
 * event pauses following instead. Records where it put the view in `lastTop`: the next scroll
 * event compares with it, so a scroll up in the same frame still reads as up.
 */
export function showNewest(box: ScrollMetrics, lastTop: RefObject<number>): void {
  if (scrolledAway(lastTop.current, box)) return;
  box.scrollTop = box.scrollHeight;
  lastTop.current = box.scrollTop;
}

/** Calls `onResize` whenever `box` changes size, until the returned function is called. */
export type WatchSize<Box> = (box: Box, onResize: () => void) => () => void;

/** WatchSize in the browser. A ResizeObserver also reports the size it first sees. */
const observeSize: WatchSize<Element> = (box, onResize) => {
  const observer = new ResizeObserver(onResize);
  observer.observe(box);
  return () => {
    observer.disconnect();
  };
};

/**
 * Keeps the newest line in view each time `box` changes size (showNewest), until the returned
 * function is called. Scrolling never changes the box's size, so this never feeds itself a
 * ResizeObserver loop (which the browser reports as an error).
 */
export function followSizeChanges<Box extends ScrollMetrics>(
  box: Box,
  lastTop: RefObject<number>,
  watch: WatchSize<Box>,
): () => void {
  return watch(box, () => {
    showNewest(box, lastTop);
  });
}

/**
 * One row. Memoised on the model's line object, which the model replaces only when that line
 * changes, so a new line in a 2-hour call renders one row, not all of them.
 */
export const TranscriptRow = memo(function TranscriptRow({ item }: { item: TranscriptItem }) {
  const time = <span className="transcript-line-time">{formatOffset(item.startMs)}</span>;
  const speaker = <span className="transcript-line-speaker">{SPEAKER_NAME[item.speaker]}</span>;
  if (item.kind === 'interim') {
    // Hidden from screen readers: the log would read out every guess, not just the final line.
    return (
      <p className="transcript-line" data-speaker={item.speaker} data-interim="true" aria-hidden>
        {time}
        {speaker}
        <span className="transcript-line-text">{item.text}</span>
      </p>
    );
  }
  // Every final line carries its id: citation chips (M4-T21) find their lines by it.
  return (
    <p
      className="transcript-line"
      data-speaker={item.speaker}
      data-segment-id={item.id}
      data-echo={item.hidden ? 'hidden' : undefined}
    >
      {time}
      {speaker}
      <span className="transcript-line-text">
        {item.text}
        {item.hidden ? (
          <span className="transcript-line-echo" title="Hidden: it repeats the call audio">
            echo
          </span>
        ) : null}
      </span>
    </p>
  );
});
