import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CITED_HIGHLIGHT_MS,
  CitationNavigatorProvider,
  createCitationNavigator,
  createTranscriptRegistry,
  planReveal,
  useCitationNavigator,
  useRegisterTranscript,
  type CitationNavigator,
  type RevealContainer,
  type RevealLine,
  type RevealTranscript,
  type TranscriptHandle,
} from './transcriptNavigator';

// Node has no DOM. The registry only keeps the handle and never touches its container, so an
// empty object stands in for the element.
const fakeTranscript = (): TranscriptHandle => ({
  container: {} as HTMLElement,
  pauseFollow: vi.fn(),
});

function NavigatorProbe({ onNavigator }: { onNavigator: (navigator: CitationNavigator) => void }) {
  onNavigator(useCitationNavigator());
  return null;
}

function RegisterProbe() {
  useRegisterTranscript(null);
  return null;
}

/** Server rendering runs no effects, so nothing inside `tree` registers a transcript. */
function render(tree: ReactNode): void {
  renderToString(tree);
}

describe('CitationNavigatorProvider', () => {
  it('returns not_loaded with no transcript registered', () => {
    const seen: CitationNavigator[] = [];
    render(
      createElement(CitationNavigatorProvider, {
        children: createElement(NavigatorProbe, { onNavigator: (n) => seen.push(n) }),
      }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]!.reveal(['segment-1', 'segment-2'])).toBe('not_loaded');
  });

  it('both hooks fail loudly outside the provider, naming it', () => {
    expect(() => {
      render(createElement(NavigatorProbe, { onNavigator: () => undefined }));
    }).toThrow(/useCitationNavigator .*CitationNavigatorProvider/);
    expect(() => {
      render(createElement(RegisterProbe));
    }).toThrow(/useRegisterTranscript .*CitationNavigatorProvider/);
  });
});

describe('createTranscriptRegistry', () => {
  it('holds a transcript until it unregisters', () => {
    const transcripts = createTranscriptRegistry();
    expect(transcripts.current()).toBeNull();

    const transcript = fakeTranscript();
    const unregister = transcripts.register(transcript);
    expect(transcripts.current()).toBe(transcript);

    unregister();
    expect(transcripts.current()).toBeNull();
  });

  it('the newest transcript wins and a late unregister keeps the other one', () => {
    const transcripts = createTranscriptRegistry();
    const previous = fakeTranscript();
    const next = fakeTranscript();
    const unregisterPrevious = transcripts.register(previous);
    const unregisterNext = transcripts.register(next);
    expect(transcripts.current()).toBe(next);

    // The old transcript's cleanup runs after the new one registered.
    unregisterPrevious();
    unregisterPrevious();
    expect(transcripts.current()).toBe(next);

    unregisterNext();
    expect(transcripts.current()).toBeNull();
  });

  it('falls back to the earlier transcript when the newer one unregisters', () => {
    const transcripts = createTranscriptRegistry();
    const earlier = fakeTranscript();
    transcripts.register(earlier);
    const unregisterLater = transcripts.register(fakeTranscript());

    unregisterLater();
    expect(transcripts.current()).toBe(earlier);
  });
});

describe('planReveal', () => {
  it('picks the first wanted line in transcript order', () => {
    // Asked for out of order, and with a line the transcript no longer shows.
    expect(planReveal(['s1', 's2', 's3', 's4'], ['s4', 'removed', 's2'])).toEqual({
      first: 1,
      cited: [1, 3],
    });
  });

  it('plans nothing when none of the wanted lines is rendered', () => {
    expect(planReveal(['s1', 's2'], ['removed'])).toBeNull();
    expect(planReveal([], ['s1'])).toBeNull();
    expect(planReveal(['s1'], [])).toBeNull();
  });
});

/** Each fake line's height, the fake log's view height, and where that view starts on the page. */
const LINE_PX = 20;
const VIEW_PX = 100;
const VIEW_TOP = 50;

/** A transcript line under Node, which has no DOM: its attributes, and its box on the page. */
class FakeLine implements RevealLine {
  private readonly attributes: Map<string, string>;

  constructor(
    readonly id: string,
    private readonly topOnPage: () => number,
    private readonly steps: string[],
  ) {
    this.attributes = new Map([['data-segment-id', id]]);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getBoundingClientRect(): { top: number; height: number } {
    return { top: this.topOnPage(), height: LINE_PX };
  }

  scrollIntoView(options: ScrollIntoViewOptions): void {
    this.steps.push(`bring ${this.id} into the window (${String(options.block)})`);
  }
}

interface FakeLog {
  transcript: RevealTranscript;
  container: RevealContainer;
  /** What the reveal did to the transcript and the page, in order. */
  steps: string[];
  /** The ids of the lines marked `data-cited`, in transcript order. */
  cited(): string[];
}

/**
 * A transcript log of `count` lines, `s1` to `s<count>`, LINE_PX each in a view of VIEW_PX, that
 * scrolls the way a browser does (clamped to its content). Starts scrolled to `scrollTop`.
 */
function fakeLog(count: number, scrollTop = 0): FakeLog {
  const steps: string[] = [];
  const maxTop = Math.max(0, count * LINE_PX - VIEW_PX);
  let top = scrollTop;
  const lines = Array.from(
    { length: count },
    (_, index) =>
      new FakeLine(`s${String(index + 1)}`, () => VIEW_TOP + index * LINE_PX - top, steps),
  );
  const container: RevealContainer = {
    querySelectorAll: () => lines,
    getBoundingClientRect: () => ({ top: VIEW_TOP }),
    clientTop: 0,
    clientHeight: VIEW_PX,
    get scrollTop() {
      return top;
    },
    set scrollTop(value: number) {
      steps.push(`scroll to ${String(value)}`);
      top = Math.min(maxTop, Math.max(0, value));
    },
  };
  return {
    transcript: {
      container,
      pauseFollow: () => {
        steps.push('pause follow');
      },
    },
    container,
    steps,
    cited: () =>
      lines.filter((line) => line.getAttribute('data-cited') !== null).map((line) => line.id),
  };
}

/** The navigator over one transcript, with a page that records when it shows the transcript. */
function navigatorOver(log: FakeLog): CitationNavigator {
  return createCitationNavigator({ current: () => log.transcript }, () => {
    log.steps.push('show transcript');
  });
}

describe('reveal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns not_loaded when no wanted line is rendered', () => {
    const log = fakeLog(20);

    expect(navigatorOver(log).reveal(['removed-1', 'removed-2'])).toBe('not_loaded');
    // Nothing moved: following goes on, a narrow page keeps showing the notes, nothing is marked.
    expect(log.steps).toEqual([]);
    expect(log.cited()).toEqual([]);
  });

  it('pauses follow before it scrolls', () => {
    // Following live: the view is at the bottom of 20 lines (400 px of lines in a 100 px view).
    const log = fakeLog(20, 300);

    expect(navigatorOver(log).reveal(['s6'])).toBe('shown');
    // s6 spans 100-120 px of the log, so its middle (110) sits mid-view at scrollTop 60.
    expect(log.steps).toEqual([
      'pause follow',
      'show transcript',
      'scroll to 60',
      'bring s6 into the window (nearest)',
    ]);
  });

  it('centres the first wanted line in transcript order and marks every wanted line', () => {
    const log = fakeLog(20);

    expect(navigatorOver(log).reveal(['s12', 'removed', 's9'])).toBe('shown');
    // s9 spans 160-180 px: its middle (170) sits mid-view at scrollTop 120.
    expect(log.container.scrollTop).toBe(120);
    expect(log.cited()).toEqual(['s9', 's12']);
  });

  it('a second reveal clears the first highlight', () => {
    vi.useFakeTimers();
    const log = fakeLog(20);
    const navigator = navigatorOver(log);

    navigator.reveal(['s3']);
    expect(log.cited()).toEqual(['s3']);
    vi.advanceTimersByTime(1500);

    navigator.reveal(['s11', 's10']);
    expect(log.cited()).toEqual(['s10', 's11']);
    // The first reveal's time is up, and its timer must not take the second reveal's marks.
    vi.advanceTimersByTime(CITED_HIGHLIGHT_MS - 1);
    expect(log.cited()).toEqual(['s10', 's11']);
    vi.advanceTimersByTime(1);
    expect(log.cited()).toEqual([]);
  });

  it('marks the lines for 2 s', () => {
    vi.useFakeTimers();
    const log = fakeLog(20);

    navigatorOver(log).reveal(['s4']);
    vi.advanceTimersByTime(1999);
    expect(log.cited()).toEqual(['s4']);
    vi.advanceTimersByTime(1);
    expect(log.cited()).toEqual([]);
  });

  it('a reveal that finds no line leaves the last highlight and the view as they were', () => {
    vi.useFakeTimers();
    const log = fakeLog(20);
    const navigator = navigatorOver(log);
    navigator.reveal(['s7']);
    const steps = log.steps.length;

    expect(navigator.reveal(['removed'])).toBe('not_loaded');
    expect(log.steps).toHaveLength(steps);
    expect(log.cited()).toEqual(['s7']);
  });
});
