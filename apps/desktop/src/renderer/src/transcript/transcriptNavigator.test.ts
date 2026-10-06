import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CitationNavigatorProvider,
  createTranscriptRegistry,
  useCitationNavigator,
  useRegisterTranscript,
  type CitationNavigator,
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
