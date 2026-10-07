import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import './transcriptNavigator.css';

/**
 * The one way a citation chip (AI notes, chat) takes the user to the transcript lines behind it.
 * The transcript panel (M3-T7's `LiveTranscript`) only registers its scroll container and its
 * follow control; it never reveals lines itself, so there is one reveal, and it pauses live follow
 * before it scrolls (otherwise following live scrolls straight back to the newest line).
 * Design: "Transcript navigator" in `docs/plans/M4-notes-and-ai.md`.
 */

/** `not_loaded`: none of the lines is in the transcript on screen, so the chip says "Line removed". */
export type RevealResult = 'shown' | 'not_loaded';

export interface CitationNavigator {
  reveal(segmentIds: readonly string[]): RevealResult;
}

/** What the transcript panel registers with `useRegisterTranscript`. */
export interface TranscriptHandle {
  /** The element that scrolls. Every final line inside it carries `data-segment-id`. */
  container: HTMLElement;
  /**
   * Stop following live lines and show "Jump to live", so new lines do not pull the view away.
   * The navigator calls it inside `flushSync`: the paused panel is on the page when it returns.
   */
  pauseFollow(): void;
}

export interface TranscriptRegistry {
  /** Returns the function that unregisters this registration, and only this one. */
  register(handle: TranscriptHandle): () => void;
  /** The newest registered transcript, or null when none is mounted. */
  current(): TranscriptHandle | null;
}

/**
 * Every registration is its own entry and the newest wins. A single slot would break when one
 * transcript replaces another: the old one's cleanup can run after the new one registered (they
 * need not commit together), and would leave reveal with no transcript while one is on screen.
 */
export function createTranscriptRegistry(): TranscriptRegistry {
  const registrations: { readonly handle: TranscriptHandle }[] = [];
  return {
    register(handle) {
      const registration = { handle };
      registrations.push(registration);
      return () => {
        const index = registrations.indexOf(registration);
        if (index !== -1) registrations.splice(index, 1);
      };
    },
    current: () => registrations.at(-1)?.handle ?? null,
  };
}

/** How long a reveal marks its lines `data-cited` (transcriptNavigator.css draws the mark). */
export const CITED_HIGHLIGHT_MS = 2000;

/**
 * Final lines only: an interim carries no id, and a line the echo filter hid is not rendered
 * unless the reader shows hidden lines, so a reveal of a hidden line is `not_loaded`.
 */
const LINE_SELECTOR = '[data-segment-id]';
const SEGMENT_ID = 'data-segment-id';
const CITED = 'data-cited';

/** Which rendered lines a reveal shows, as indexes into the rendered ids it was planned from. */
export interface RevealPlan {
  /** The line scrolled to the middle of the view: the first wanted one in transcript order. */
  readonly first: number;
  /** Every wanted line that is rendered, in transcript order, `first` among them. */
  readonly cited: readonly number[];
}

/**
 * The pure part of a reveal: of the lines on screen, in transcript order, the ones a chip wants.
 * A chip's ids come in whatever order its citation lists them; the transcript's order decides
 * which line the view goes to. Null when none of them is rendered (the reveal is `not_loaded`).
 */
export function planReveal(
  renderedIdsInOrder: readonly string[],
  wanted: readonly string[],
): RevealPlan | null {
  const wantedIds = new Set(wanted);
  const cited: number[] = [];
  renderedIdsInOrder.forEach((id, index) => {
    if (wantedIds.has(id)) cited.push(index);
  });
  const first = cited[0];
  return first === undefined ? null : { first, cited };
}

/** The part of a transcript line a reveal reads and marks: every Element has it. */
export interface RevealLine {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getBoundingClientRect(): { readonly top: number; readonly height: number };
  scrollIntoView(options: ScrollIntoViewOptions): void;
}

/** The element with keyboard focus, as a reveal reads it: an Element has no box while hidden. */
export interface RevealFocused {
  getClientRects(): { readonly length: number };
}

/** The part of the transcript's scroll container a reveal reads and scrolls: an HTMLElement's. */
export interface RevealContainer {
  querySelectorAll(selectors: string): Iterable<RevealLine>;
  getBoundingClientRect(): { readonly top: number };
  readonly clientTop: number;
  readonly clientHeight: number;
  scrollTop: number;
  readonly ownerDocument: { readonly activeElement: RevealFocused | null };
  focus(options: FocusOptions): void;
}

/** A registered transcript as a reveal uses it: a TranscriptHandle, narrowed so Node can test it. */
export interface RevealTranscript {
  container: RevealContainer;
  pauseFollow(): void;
}

interface RenderedLine {
  id: string;
  line: RevealLine;
}

/** The lines on screen with their ids, in transcript order (the panel draws them in that order). */
function renderedLines(container: RevealContainer): RenderedLine[] {
  return Array.from(container.querySelectorAll(LINE_SELECTOR)).flatMap((line) => {
    const id = line.getAttribute(SEGMENT_ID);
    return id === null ? [] : [{ id, line }];
  });
}

/**
 * Scrolls the log so the line's middle sits at the middle of its view, as near as its scroll goes
 * (the newest line rises only as far as the room below it, transcriptNavigator.css). Only the log
 * scrolls here: `scrollIntoView` with `block: 'center'` would also centre the line in the window,
 * moving the whole page.
 */
function centreInView(container: RevealContainer, line: RevealLine): void {
  const view = container.getBoundingClientRect();
  const box = line.getBoundingClientRect();
  const viewMiddle = view.top + container.clientTop + container.clientHeight / 2;
  container.scrollTop += box.top + box.height / 2 - viewMiddle;
}

/**
 * The navigator over the newest registered transcript. A reveal finds the lines first and does
 * nothing more when none is rendered: following goes on, a narrow page keeps showing the notes,
 * and the chip says "Line removed". Otherwise, in this order:
 *
 * 1. Pause following, before anything scrolls: while following, the panel puts the newest line in
 *    view on every new line, which would pull the view straight back from the cited one. Paused
 *    (`held`), its own scroll to the bottom does not follow again (liveTranscriptModel.ts). The
 *    pause renders at once (`flushSync`): paused, the panel shows "Jump to live" over the log's
 *    bottom, and transcriptNavigator.css gives the log room below its newest line, which the
 *    scroll in step 3 needs to lift that line clear of the pill. A pause rendered after that
 *    scroll would bring the room too late and leave the line under the pill.
 * 2. Show the transcript (the page's `showTranscript`, synchronous), so the lines have a layout.
 *    A narrow page hides the notes or chat pane for it, and with it the chip a keyboard user just
 *    pressed: Chromium then drops focus to <body>, the next Tab starts over at the top of the page
 *    and a screen reader says nothing. So when the element that had focus lost its box, focus
 *    moves to the log, as the panel's own "Jump to live" does. A chip still in view keeps it.
 * 3. Scroll the first line in transcript order to the middle of the log, then bring it into the
 *    window if the page itself scrolls (meeting.css lets a short window scroll the page under a
 *    region's minimum height). `nearest` leaves the page alone while the line is in the window.
 * 4. Mark every found line `data-cited` for CITED_HIGHLIGHT_MS. The last reveal's marks and its
 *    timer go first, so an old timer never takes the new marks off early.
 *
 * The mark is an attribute written here, never a prop of the panel's rows: React writes only the
 * attributes it renders, so the panel's renders leave it alone. A row the echo filter removes
 * takes its mark with it, and taking the mark off a removed row is harmless.
 */
export function createCitationNavigator(
  transcripts: { current(): RevealTranscript | null },
  showTranscript: () => void,
): CitationNavigator {
  const highlight: { lines: readonly RevealLine[]; timer: ReturnType<typeof setTimeout> | null } = {
    lines: [],
    timer: null,
  };
  const clearHighlight = (): void => {
    if (highlight.timer !== null) clearTimeout(highlight.timer);
    for (const line of highlight.lines) line.removeAttribute(CITED);
    highlight.lines = [];
    highlight.timer = null;
  };

  return {
    reveal(segmentIds) {
      const transcript = transcripts.current();
      if (transcript === null) return 'not_loaded';
      const lines = renderedLines(transcript.container);
      const plan = planReveal(
        lines.map(({ id }) => id),
        segmentIds,
      );
      if (plan === null) return 'not_loaded';
      const lineAt = (index: number): RevealLine => {
        const rendered = lines[index];
        // Never: the plan's indexes point into `lines`, the list it was planned from.
        if (rendered === undefined) {
          throw new Error(`The reveal plan names line ${index} of ${lines.length} rendered`);
        }
        return rendered.line;
      };
      const first = lineAt(plan.first);
      const focused = transcript.container.ownerDocument.activeElement;

      flushSync(() => {
        transcript.pauseFollow();
      });
      showTranscript();
      if (focused !== null && focused.getClientRects().length === 0) {
        // The scroll below places the line; focus must not scroll the log to its own idea.
        transcript.container.focus({ preventScroll: true });
      }
      centreInView(transcript.container, first);
      first.scrollIntoView({ block: 'nearest', inline: 'nearest' });

      clearHighlight();
      highlight.lines = plan.cited.map(lineAt);
      for (const line of highlight.lines) line.setAttribute(CITED, 'true');
      highlight.timer = setTimeout(clearHighlight, CITED_HIGHLIGHT_MS);
      return 'shown';
    },
  };
}

interface NavigatorContextValue {
  navigator: CitationNavigator;
  register: TranscriptRegistry['register'];
}

const NavigatorContext = createContext<NavigatorContextValue | null>(null);

/** One provider's navigator, plus the slot that holds the page's latest `showTranscript`. */
function createNavigation(): {
  context: NavigatorContextValue;
  setShowTranscript: (showTranscript: (() => void) | undefined) => void;
} {
  const transcripts = createTranscriptRegistry();
  let showTranscript: (() => void) | undefined;
  return {
    context: {
      navigator: createCitationNavigator(transcripts, () => {
        showTranscript?.();
      }),
      register: (handle) => transcripts.register(handle),
    },
    setShowTranscript: (next) => {
      showTranscript = next;
    },
  };
}

export interface CitationNavigatorProviderProps {
  children: ReactNode;
  /**
   * Called by reveal after it has found the lines and before it scrolls. A page that hides the
   * transcript region (a narrow window) shows it here, synchronously (`flushSync`), because the
   * scroll runs as soon as this returns. Keep the transcript mounted while it is hidden: reveal
   * looks the lines up in it first, so a chip for a removed line does not switch the view away.
   */
  showTranscript?: () => void;
}

/** Wraps the meeting page, so its chips and its transcript share one navigator. */
export function CitationNavigatorProvider({
  children,
  showTranscript,
}: CitationNavigatorProviderProps) {
  // Made once: a new navigator on every render would re-render every chip and drop the transcript
  // registered with the old one. The page may still pass a new `showTranscript` on every render;
  // a layout effect stores it, so a click right after that render already gets the new one.
  const [navigation] = useState(createNavigation);
  useLayoutEffect(() => {
    navigation.setShowTranscript(showTranscript);
  }, [navigation, showTranscript]);
  return createElement(NavigatorContext, { value: navigation.context }, children);
}

function useNavigatorContext(hook: string): NavigatorContextValue {
  const value = useContext(NavigatorContext);
  if (value === null) {
    throw new Error(`${hook} needs a CitationNavigatorProvider above it (the meeting page)`);
  }
  return value;
}

export function useCitationNavigator(): CitationNavigator {
  return useNavigatorContext('useCitationNavigator').navigator;
}

/**
 * Registers the transcript panel while it is mounted. Pass null until the container element
 * exists. Keep the handle stable (`useMemo` over the element and `pauseFollow`): a new object on
 * every render re-registers on every render.
 */
export function useRegisterTranscript(handle: TranscriptHandle | null): void {
  const { register } = useNavigatorContext('useRegisterTranscript');
  useEffect(() => {
    if (handle === null) return undefined;
    return register(handle);
  }, [register, handle]);
}
