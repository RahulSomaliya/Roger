import type { CaptureStatus, TranscriptSegmentChange } from '../../../shared/capture';
import {
  AUDIO_SOURCES,
  type AudioSource,
  type InterimTranscript,
  SPEAKER_FOR_SOURCE,
  type SpeakerLabel,
  type TranscriptSegment,
} from '../../../shared/transcript';

/**
 * The live transcript panel's model (M3 design, "Live transcript model"): pure, so every rule is
 * tested under Node, and shared by a live meeting and a past one. useLiveTranscript.ts feeds it
 * main's events, batched to one update per animation frame; LiveTranscript.tsx draws it.
 *
 * - Final lines stay sorted by start, then mic before system, then id: the API's order. A new
 *   line is inserted where it belongs (a binary search), never by sorting the whole list again, so
 *   a 2-hour call stays cheap.
 * - Each source has at most one interim, replaced whole by the next. It shows only while it holds
 *   audio past that source's last final: a same-source final that reaches into it clears it, and
 *   an interim that arrives no newer than the last final is dropped (it was already finalised).
 * - An interim also ends with its vendor session. Main sends no blank interim and nothing to the
 *   panel when a stream fails, pauses or stops; only its capture status says so (`captureStatus`),
 *   and the words of a session that is gone never come final, so they would stay on screen.
 * - M2's echo filter changes lines after they were shown (`transcript:segment-changed`): `hidden`
 *   hides one but keeps it, `trimmed` replaces its text, `unhidden` shows it again. A change can
 *   come before its line (main holds mic lines for the echo check), so it waits for the line.
 * - Every event names its meeting, and an event for another meeting is ignored: the panel of a
 *   past meeting must never show the lines of the one recording now.
 *
 * Not named `liveTranscript.ts` (the plan's first name): the Mac's disk ignores case, so beside
 * LiveTranscript.tsx an import of './LiveTranscript' loads that `.ts` file instead of the
 * component (TS1261), and `LiveTranscript.test.ts` overwrites `liveTranscript.test.ts`. Keep every
 * file name in this folder distinct ignoring case.
 */

export interface FinalLine {
  readonly kind: 'final';
  readonly id: string;
  readonly source: AudioSource;
  readonly speaker: SpeakerLabel;
  /** Offsets from the meeting start. */
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  /** Hidden by the echo filter: kept, and shown only with `showHidden`, marked as echo. */
  readonly hidden: boolean;
}

/** Words that may still change: grey until their final comes or their session ends. No id. */
export interface InterimLine {
  readonly kind: 'interim';
  readonly source: AudioSource;
  readonly speaker: SpeakerLabel;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export type TranscriptItem = FinalLine | InterimLine;

export interface LiveTranscriptState {
  readonly meetingId: string;
  /** In the API's order: start, then mic before system, then id. */
  readonly finals: readonly FinalLine[];
  readonly byId: ReadonlyMap<string, FinalLine>;
  readonly interims: Readonly<Record<AudioSource, InterimLine | null>>;
  /** The latest end of each source's final lines; -Infinity before the first. */
  readonly lastFinalEndMs: Readonly<Record<AudioSource, number>>;
  /** The latest change for each line not seen yet, applied when it comes. */
  readonly heldChanges: ReadonlyMap<string, TranscriptSegmentChange>;
}

/** The part of main's capture status that says which of a meeting's sessions are open. */
export type CaptureSessions = Pick<CaptureStatus, 'phase' | 'meetingId' | 'streams'>;

/** One event from main, or the meeting's stored lines read from main's store. */
export type TranscriptAction =
  | { type: 'final'; segment: TranscriptSegment }
  | { type: 'interim'; interim: InterimTranscript }
  | { type: 'segmentChanged'; change: TranscriptSegmentChange }
  | { type: 'stored'; lines: readonly TranscriptSegment[] }
  | { type: 'captureStatus'; status: CaptureSessions };

/** A meeting's panel before any event: its stored lines (none for a meeting just started). */
export function openMeeting(
  meetingId: string,
  storedLines: readonly TranscriptSegment[] = [],
): LiveTranscriptState {
  const empty: LiveTranscriptState = {
    meetingId,
    finals: [],
    byId: new Map(),
    interims: { mic: null, system: null },
    lastFinalEndMs: { mic: -Infinity, system: -Infinity },
    heldChanges: new Map(),
  };
  return addStoredLines(empty, storedLines);
}

/**
 * Applies events in arrival order and returns the new state, or `state` itself when nothing it
 * shows changed (React then skips the render). One batch copies each list at most once.
 */
export function applyTranscriptActions(
  state: LiveTranscriptState,
  actions: readonly TranscriptAction[],
): LiveTranscriptState {
  const draft = new TranscriptDraft(state);
  for (const action of actions) draft.apply(action);
  return draft.result();
}

export function addFinal(state: LiveTranscriptState, segment: TranscriptSegment) {
  return applyTranscriptActions(state, [{ type: 'final', segment }]);
}

export function setInterim(state: LiveTranscriptState, interim: InterimTranscript) {
  return applyTranscriptActions(state, [{ type: 'interim', interim }]);
}

export function segmentChanged(state: LiveTranscriptState, change: TranscriptSegmentChange) {
  return applyTranscriptActions(state, [{ type: 'segmentChanged', change }]);
}

/** Adds the stored lines the panel has not seen; a line it already has is left as it is. */
export function addStoredLines(state: LiveTranscriptState, lines: readonly TranscriptSegment[]) {
  return applyTranscriptActions(state, [{ type: 'stored', lines }]);
}

/**
 * What the panel draws, top to bottom: the final lines (hidden ones only with `showHidden`,
 * marked by `hidden`) with each interim in time order among them. Line objects are the state's
 * own, so a row whose line did not change can skip its render.
 */
export function transcriptItems(
  state: LiveTranscriptState,
  showHidden: boolean,
): readonly TranscriptItem[] {
  const lines = showHidden ? state.finals : state.finals.filter((line) => !line.hidden);
  const interims = AUDIO_SOURCES.flatMap((source) => {
    const interim = state.interims[source];
    return interim === null ? [] : [interim];
  }).sort((a, b) => a.startMs - b.startMs || SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
  if (interims.length === 0) return lines;
  const items: TranscriptItem[] = [...lines];
  // From the last interim back, so an insertion never moves the place of one still to come.
  for (const interim of interims.reverse()) {
    const index = upperBound(
      lines,
      (line) =>
        line.startMs - interim.startMs || SOURCE_RANK[line.source] - SOURCE_RANK[interim.source],
    );
    items.splice(index, 0, interim);
  }
  return items;
}

/** Mic before system when two lines start together, as the API orders them. */
const SOURCE_RANK: Readonly<Record<AudioSource, number>> = { mic: 0, system: 1 };

/** The API's order of final lines. Ids compare as plain strings, never by locale. */
function compareLines(a: FinalLine, b: FinalLine): number {
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  if (a.source !== b.source) return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** The first index whose element `compare` puts after the probe (> 0): where it goes last. */
function upperBound<T>(sorted: readonly T[], compare: (element: T) => number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    // In range by the loop's bounds.
    if (compare(sorted[middle] as T) > 0) high = middle;
    else low = middle + 1;
  }
  return low;
}

function toLine(segment: TranscriptSegment): FinalLine {
  return {
    kind: 'final',
    id: segment.id,
    source: segment.source,
    speaker: segment.speaker,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    hidden: false,
  };
}

/**
 * Whether an interim holds only audio after `endMs`, a final's end: the next turn's words, which
 * that final must leave. Any overlap is the final's own turn, even where the final ends first
 * (AssemblyAI's last partial can end on a trailing guess, or on the audio sent so far).
 */
function liesAfter(interim: InterimLine, endMs: number): boolean {
  return interim.startMs >= endMs && interim.endMs > endMs;
}

/**
 * The sources of `meetingId` whose interim a capture status ends: those with no open session.
 * Main sends a status at every stream state change (CaptureService's onStreamState) and its idle
 * status after the lines Stop flushed, so a stale interim goes with the next status. It only
 * clears, never blocks: a reopened session's first interim comes after the status that says it
 * opened, and shows at once.
 */
function sourcesWithoutSession(meetingId: string, status: CaptureSessions): readonly AudioSource[] {
  // Nothing records: Stop, or a failed Start, ended every session.
  if (status.phase === 'idle') return AUDIO_SOURCES;
  // Another meeting, or one still starting (main names it once both streams opened).
  if (status.meetingId !== meetingId) return [];
  if (status.phase === 'stopping') return AUDIO_SOURCES;
  return AUDIO_SOURCES.filter((source) => status.streams[source] !== 'open');
}

/** The line as the change says it now reads; the same object when nothing differs. */
function withChange(line: FinalLine, change: TranscriptSegmentChange): FinalLine {
  const hidden = change.change === 'hidden';
  if (line.hidden === hidden && line.text === change.text) return line;
  return { ...line, hidden, text: change.text };
}

/**
 * One batch of events over a state: each list is copied the first time the batch writes to it,
 * so a frame with only an interim copies no line list, and a frame with many lines copies once.
 */
class TranscriptDraft {
  private finals: FinalLine[] | null = null;
  private byId: Map<string, FinalLine> | null = null;
  private heldChanges: Map<string, TranscriptSegmentChange> | null = null;
  private readonly interims: Record<AudioSource, InterimLine | null>;
  private readonly lastFinalEndMs: Record<AudioSource, number>;
  private changed = false;

  constructor(private readonly base: LiveTranscriptState) {
    this.interims = { ...base.interims };
    this.lastFinalEndMs = { ...base.lastFinalEndMs };
  }

  apply(action: TranscriptAction): void {
    switch (action.type) {
      case 'final':
        this.addFinal(action.segment);
        return;
      case 'interim':
        this.setInterim(action.interim);
        return;
      case 'segmentChanged':
        this.applyChange(action.change);
        return;
      case 'stored':
        for (const segment of action.lines) this.addFinal(segment);
        return;
      case 'captureStatus':
        for (const source of sourcesWithoutSession(this.base.meetingId, action.status)) {
          this.clearInterim(source);
        }
        return;
    }
  }

  result(): LiveTranscriptState {
    if (!this.changed) return this.base;
    return {
      meetingId: this.base.meetingId,
      finals: this.finals ?? this.base.finals,
      byId: this.byId ?? this.base.byId,
      interims: this.interims,
      lastFinalEndMs: this.lastFinalEndMs,
      heldChanges: this.heldChanges ?? this.base.heldChanges,
    };
  }

  private addFinal(segment: TranscriptSegment): void {
    if (segment.meetingId !== this.base.meetingId) return;
    // A final sent again (a resend, or a stored line the panel already has) is ignored.
    if ((this.byId ?? this.base.byId).has(segment.id)) return;
    let line = toLine(segment);
    const held = (this.heldChanges ?? this.base.heldChanges).get(segment.id);
    if (held !== undefined) {
      line = withChange(line, held);
      this.writableHeldChanges().delete(segment.id);
    }
    const finals = this.writableFinals();
    finals.splice(
      upperBound(finals, (existing) => compareLines(existing, line)),
      0,
      line,
    );
    this.writableById().set(line.id, line);

    const source = line.source;
    this.lastFinalEndMs[source] = Math.max(this.lastFinalEndMs[source], line.endMs);
    const interim = this.interims[source];
    if (interim !== null && !liesAfter(interim, line.endMs)) this.interims[source] = null;
    this.changed = true;
  }

  private clearInterim(source: AudioSource): void {
    if (this.interims[source] === null) return;
    this.interims[source] = null;
    this.changed = true;
  }

  private setInterim(next: InterimTranscript): void {
    if (next.meetingId !== this.base.meetingId) return;
    const source = next.source;
    // Only a guard, so no row is drawn with no words: main's adapters drop empty partials, and a
    // session that ends says so through the capture status instead (`captureStatus`).
    if (next.text.trim() === '') {
      this.clearInterim(source);
      return;
    }
    // Already finalised: showing it would print those words twice.
    if (next.endMs <= this.lastFinalEndMs[source]) return;
    this.interims[source] = {
      kind: 'interim',
      source,
      speaker: SPEAKER_FOR_SOURCE[source],
      startMs: next.startMs,
      endMs: next.endMs,
      text: next.text,
    };
    this.changed = true;
  }

  private applyChange(change: TranscriptSegmentChange): void {
    if (change.meetingId !== this.base.meetingId) return;
    const line = (this.byId ?? this.base.byId).get(change.segmentId);
    if (line === undefined) {
      // A held line: main decided before the line reached the panel. The latest change wins,
      // as each one says the whole state of the line.
      this.writableHeldChanges().set(change.segmentId, change);
      this.changed = true;
      return;
    }
    const next = withChange(line, change);
    if (next === line) return;
    const finals = this.writableFinals();
    // The line's place: the last index not after it, which is the line itself.
    finals[upperBound(finals, (existing) => compareLines(existing, line)) - 1] = next;
    this.writableById().set(next.id, next);
    this.changed = true;
  }

  private writableFinals(): FinalLine[] {
    this.finals ??= [...this.base.finals];
    return this.finals;
  }

  private writableById(): Map<string, FinalLine> {
    this.byId ??= new Map(this.base.byId);
    return this.byId;
  }

  private writableHeldChanges(): Map<string, TranscriptSegmentChange> {
    this.heldChanges ??= new Map(this.base.heldChanges);
    return this.heldChanges;
  }
}

/*
 * Following live (M3 design, "Scrolling"): while the reader is at the bottom, new lines scroll
 * into view; scrolling up pauses that and shows "Jump to live". Pure, on scroll positions, so
 * LiveTranscript.tsx only reads the scroll container and the rules are tested under Node.
 */

/**
 * - `live`: new lines scroll into view.
 * - `reading`: the reader scrolled up (or opened a past meeting); reaching the bottom follows again.
 * - `held`: a citation chip paused it (M4-T21's reveal, through `pauseFollow`). Its own scroll can
 *   land at the bottom, which must not follow again, or the next line pulls the cited one away.
 *   Only "Jump to live", or the reader scrolling up first, ends it.
 */
export type FollowMode = 'live' | 'reading' | 'held';

export interface FollowState {
  readonly mode: FollowMode;
  /** The scroll position last seen, to tell a scroll up from a scroll down. */
  readonly scrollTop: number;
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * How near the bottom still counts as the bottom, in CSS pixels: about a line, so fractional
 * pixels, a nudge of the trackpad or a line hidden by the echo filter never pause following.
 */
export const BOTTOM_SLACK_PX = 24;

/** A live meeting starts following; a past one starts at its first line. */
export function startFollow(live: boolean): FollowState {
  return { mode: live ? 'live' : 'reading', scrollTop: 0 };
}

export function isFollowing(state: FollowState): boolean {
  return state.mode === 'live';
}

/**
 * The state after a scroll event. Only a scroll up pauses: content growing at the bottom, a
 * window that shrinks, or the panel's own scroll to a new line all leave following on.
 */
export function followScroll(state: FollowState, metrics: ScrollMetrics): FollowState {
  const atBottom =
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= BOTTOM_SLACK_PX;
  const movedUp = metrics.scrollTop < state.scrollTop;
  let mode = state.mode;
  if (mode === 'held') {
    if (movedUp && !atBottom) mode = 'reading';
  } else if (atBottom) {
    mode = 'live';
  } else if (movedUp) {
    mode = 'reading';
  }
  if (mode === state.mode && metrics.scrollTop === state.scrollTop) return state;
  return { mode, scrollTop: metrics.scrollTop };
}

/** What a citation's reveal calls first (TranscriptHandle.pauseFollow). */
export function pauseFollow(state: FollowState): FollowState {
  return state.mode === 'held' ? state : { ...state, mode: 'held' };
}

/** "Jump to live": follow again; the panel then scrolls to the newest line. */
export function jumpToLive(state: FollowState): FollowState {
  return state.mode === 'live' ? state : { ...state, mode: 'live' };
}
