import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type MeetingSummary,
  RECENT_MEETINGS_LIMIT,
  type StoredMeeting,
} from '../../../shared/meetings';
import type { TranscriptSegment } from '../../../shared/transcript';
import { describeError } from '../app/describeError';
import { type AiNotesApi, AiNotesSession, type AiNotesState } from '../notes/aiNotesActions';
import { LatestRead, type ReadState } from './latestRead';

/** A read from main the page shows, and how to ask for it again (a Try again button). */
export type Read<T> = ReadState<T> & { readonly refresh: () => void };

/**
 * Shows `reader`'s answer, and reads again now and whenever `refreshKey` changes, keeping the last
 * answer on screen meanwhile (LatestRead). The key is what tells the page main's answer may have
 * changed. A string on purpose: an object key changes with every new object, and the capture
 * status is a new object every 2 s (recentMeetingsKey).
 */
function useLatestRead<T>(reader: LatestRead<T>, refreshKey: string): Read<T> {
  // The server snapshot is the empty state: renderToString (the shell tests) never reads.
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
  // readFor decides whether to read (latestRead.test.ts covers it): renderToString, which the page
  // tests use, runs no effects.
  useEffect(() => {
    reader.readFor(refreshKey);
  }, [reader, refreshKey]);
  return useMemo(() => ({ ...state, refresh: reader.refresh }), [state, reader]);
}

/** A failed read's text for the page: what Roger tried, then why it failed. */
function failure(attempt: string): (error: unknown) => string {
  return (error) => `${attempt}: ${describeError(error)}`;
}

/**
 * One meeting as main's store holds it (`meetings:get`): `value` is undefined until main answers
 * and null when this Mac has no such meeting. Pass this meeting's recording phase as `refreshKey`:
 * main stores every line before it sends it, so a read after Stop holds every line the page saw
 * live, and the page keeps them once the capture view moves on to the next meeting.
 */
export function useMeeting(meetingId: string, refreshKey: string): Read<StoredMeeting | null> {
  const reader = useMemo(
    () =>
      new LatestRead(
        () => window.roger.getMeeting({ meetingId }),
        failure('Roger could not read this meeting on this Mac'),
      ),
    [meetingId],
  );
  return useLatestRead(reader, refreshKey);
}

/**
 * `window.roger`'s notes channels, looked up at each call. The session is made while the page
 * renders, and `window.roger` does not exist under Node, where the page tests render it: only
 * `start()` (an effect, never run there) and the buttons reach the channels.
 */
const rogerNotes: AiNotesApi = {
  getNotes: (...args) => window.roger.getNotes(...args),
  saveNote: (...args) => window.roger.saveNote(...args),
  listNoteTemplates: (...args) => window.roger.listNoteTemplates(...args),
  generateNotes: (...args) => window.roger.generateNotes(...args),
  cancelNotesGenerate: (...args) => window.roger.cancelNotesGenerate(...args),
  getPendingGenerate: (...args) => window.roger.getPendingGenerate(...args),
  getNotesRun: (...args) => window.roger.getNotesRun(...args),
  onNoteChanged: (...args) => window.roger.onNoteChanged(...args),
  onNotesEvent: (...args) => window.roger.onNotesEvent(...args),
  onPendingGenerateChanged: (...args) => window.roger.onPendingGenerateChanged(...args),
};

/**
 * The meeting's AI notes as main holds them, for the header: Write notes, "Writing notes…" with
 * Cancel, the ⋯ menu and the AI notes tab (whether it exists at all) all read this state. It is the
 * page's own session, apart from the AI notes panel's: both follow main's events and act through
 * main, so neither misses the other's change, but a confirmation or an action error one of them
 * raises is the one that shows it (the header shows its own).
 */
export function useMeetingNotes(meetingId: string): {
  session: AiNotesSession;
  state: AiNotesState;
} {
  const session = useMemo(() => new AiNotesSession(rogerNotes, meetingId), [meetingId]);
  // The server snapshot is the session's initial state: renderToString (the page tests) never
  // reads main.
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  useEffect(() => session.start(), [session]);
  return { session, state };
}

/**
 * The newest meetings on this Mac (`meetings:list`). Pass recentMeetingsKey as `refreshKey`: it
 * changes when a recording starts or stops, and never on the status main sends every 2 s.
 */
export function useRecentMeetings(refreshKey: string): Read<MeetingSummary[]> {
  const [reader] = useState(
    () =>
      new LatestRead(
        () => window.roger.listMeetings({ limit: RECENT_MEETINGS_LIMIT }),
        failure('Roger could not list the meetings on this Mac'),
      ),
  );
  return useLatestRead(reader, refreshKey);
}

/**
 * What the meeting page hands its regions besides the meeting id (slot props are only
 * `{ meetingId }`, app/slotRegistry.ts): read it in a region with useMeetingView().
 */
export interface MeetingView {
  readonly meetingId: string;
  /**
   * The meeting as main's store last answered; null until main answers, when this Mac has no
   * such meeting, or when the first read failed (the page shows why).
   */
  readonly meeting: StoredMeeting | null;
  /**
   * The meeting's stored lines in transcript order (shared/meetings.ts), without the ones the echo
   * filter hid. The transcript starts from these and adds the live lines it receives itself,
   * deduplicating by id (`addStoredLines`, transcript/liveTranscriptModel.ts). Read again when this
   * meeting's recording starts or stops.
   */
  readonly storedLines: readonly TranscriptSegment[];
  /**
   * Whether the transcript shows the lines the echo filter hid. M2-T20b's control sets it and
   * M3-T7's LiveTranscript reads it; the page holds it so the two regions agree.
   */
  readonly showHidden: boolean;
  readonly setShowHidden: (show: boolean) => void;
}

export const MeetingViewContext = createContext<MeetingView | null>(null);

/** The meeting page's view, for a component mounted in one of its regions. */
export function useMeetingView(): MeetingView {
  const view = useContext(MeetingViewContext);
  if (view === null) throw new Error('useMeetingView needs the meeting page above it');
  return view;
}
