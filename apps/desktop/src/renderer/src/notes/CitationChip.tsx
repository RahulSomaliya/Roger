import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useState } from 'react';
import type { CitationAttrs } from '../../../shared/notes';
import { useCitationNavigator } from '../transcript/transcriptNavigator';
import { citationAttrsOf } from './citationNode';

/**
 * A citation chip in the notes: the time of the transcript lines behind an AI line. A click asks
 * the meeting page's one navigator (transcript/transcriptNavigator.ts) to show those lines; the
 * chip never scrolls the transcript itself. When none of them is in the transcript any more (echo
 * removal, a re-run), the navigator says `not_loaded` and the chip says "Line removed".
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
  const className = [
    'citation-chip',
    weak ? 'citation-chip-weak' : null,
    removed ? 'citation-chip-removed' : null,
  ]
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
        <span className="citation-chip-flag">Line removed</span>
      ) : weak ? (
        <span className="citation-chip-flag">check this</span>
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
