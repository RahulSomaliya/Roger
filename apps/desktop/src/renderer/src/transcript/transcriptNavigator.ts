import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';

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
  /** Stop following live lines and show "Jump to live", so new lines do not pull the view away. */
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

/**
 * Finding the lines, pausing follow, scrolling the first to the centre and marking them
 * `data-cited` is M4-T21b, built once M3-T7's `LiveTranscript` registers. Until it lands a
 * registered transcript reveals nothing, so every chip says "Line removed".
 */
function revealInTranscript(
  _transcript: TranscriptHandle,
  _segmentIds: readonly string[],
  _showTranscript: () => void,
): RevealResult {
  return 'not_loaded';
}

function createCitationNavigator(
  transcripts: Pick<TranscriptRegistry, 'current'>,
  showTranscript: () => void,
): CitationNavigator {
  return {
    reveal(segmentIds) {
      const transcript = transcripts.current();
      if (transcript === null) return 'not_loaded';
      return revealInTranscript(transcript, segmentIds, showTranscript);
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
