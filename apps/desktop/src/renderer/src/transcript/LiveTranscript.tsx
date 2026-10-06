import { memo, type UIEvent, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatOffset } from '../format';
import {
  followScroll,
  isFollowing,
  jumpToLive,
  pauseFollow,
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
  /** True while this meeting records: the panel follows new lines and offers "Jump to live". */
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
  const [follow, setFollow] = useState(() => startFollow(live));
  // A page learns that its meeting records after its first render (main's capture status comes
  // later), and a resumed meeting records again: either way the panel follows from then on.
  // State that follows a prop, set while rendering, so the first live frame already follows.
  const [wasLive, setWasLive] = useState(live);
  if (wasLive !== live) {
    setWasLive(live);
    if (live) setFollow(jumpToLive);
  }
  const following = isFollowing(follow);

  // Citation chips find lines through the navigator (M4-T21), which pauses following before it
  // scrolls; this panel never reveals lines itself. A stable handle registers once per element.
  const pause = useCallback(() => {
    setFollow(pauseFollow);
  }, []);
  const handle = useMemo(
    () => (container === null ? null : { container, pauseFollow: pause }),
    [container, pause],
  );
  useRegisterTranscript(handle);

  // While following, the newest line is in view before the browser paints the new lines.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (following && element !== null) element.scrollTop = element.scrollHeight;
  }, [following, container, items]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    setFollow((previous) => followScroll(previous, { scrollTop, scrollHeight, clientHeight }));
  }, []);

  const jump = (): void => {
    setFollow(jumpToLive);
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
