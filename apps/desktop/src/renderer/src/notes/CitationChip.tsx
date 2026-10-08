import {
  type NodeViewRenderer,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from '@tiptap/react';
import { useState } from 'react';
import type { CitationAttrs } from '../../../shared/notes';
import { useCitationNavigator } from '../transcript/transcriptNavigator';
import { citationAttrsOf } from './citationNode';

/**
 * A citation chip in the notes: the time of the transcript lines behind an AI line. A click asks
 * the meeting page's one navigator (transcript/transcriptNavigator.ts) to show those lines; the
 * chip never scrolls the transcript itself. When none of them is in the transcript any more (echo
 * removal, a re-run), the navigator says `not_loaded` and the chip says "Line removed".
 *
 * The chip is the shared `.chip` (styles.css: `fill`, `ink-muted`, 12 px tabular time). A line the
 * model flagged adds the word "check": the word says it, never a colour. `citation-chip` stays
 * beside it as the hook for the editor's `stopEvent` and for QA.
 */

export interface CitationChipButtonProps {
  attrs: CitationAttrs;
  /** The last reveal found none of the lines. */
  removed: boolean;
  onReveal: () => void;
}

/** The chip as drawn: a button, so it works with the keyboard and in read-only notes. */
export function CitationChipButton({ attrs, removed, onReveal }: CitationChipButtonProps) {
  const weak = attrs.support === 'weak';
  const className = ['chip', 'citation-chip', removed ? 'citation-chip-removed' : null]
    .filter(Boolean)
    .join(' ');
  const where = `Show the transcript at ${attrs.label}`;
  const label = removed
    ? `The transcript line at ${attrs.label} is no longer there`
    : weak
      ? `${where}. Check this line: what was said there may not back it.`
      : where;
  return (
    <button type="button" className={className} aria-label={label} title={label} onClick={onReveal}>
      <span className="citation-chip-time">{attrs.label}</span>
      {removed ? (
        <span className="chip-flag">Line removed</span>
      ) : weak ? (
        <span className="chip-flag">check</span>
      ) : null}
    </button>
  );
}

/**
 * The editor's view of a `citation` node (citationNode.ts). Needs the meeting page's
 * CitationNavigatorProvider above the editor: TipTap renders node views inside EditorContent's
 * React tree, so they see its context.
 */
export function CitationChip({ node }: ReactNodeViewProps) {
  const navigator = useCitationNavigator();
  const [removed, setRemoved] = useState(false);
  const attrs = citationAttrsOf(node);
  return (
    <NodeViewWrapper as="span" className="citation-chip-node">
      {attrs === null ? null : (
        <CitationChipButton
          attrs={attrs}
          removed={removed}
          onReveal={() => {
            setRemoved(navigator.reveal(attrs.segmentIds) === 'not_loaded');
          }}
        />
      )}
    </NodeViewWrapper>
  );
}

/**
 * The chip's node view for the editor (noteExtensions' `citationView`). Every event inside the chip
 * stays with the chip: TipTap leaves an event to ProseMirror unless its target is the button
 * itself, and a click lands on the time inside it, so ProseMirror would also node-select the chip.
 * That selection is resolved before ProseMirror focuses the editor, and the focus transaction can
 * change the doc (StarterKit's trailing paragraph), so the click threw "Selection passed to
 * setSelection must point at the current document" (M4-T17 browser QA). A click reveals; it never
 * selects. NoteEditor also lets the trailing paragraph land at load, for every other atom.
 */
export function citationChipView(): NodeViewRenderer {
  return ReactNodeViewRenderer(CitationChip, {
    stopEvent: ({ event }) =>
      event.target instanceof Element && event.target.closest('.citation-chip') !== null,
  });
}
