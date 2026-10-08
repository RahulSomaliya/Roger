import { CITATION_NODE_TYPE, type NoteDoc, type NoteNode } from '../../../shared/notes';

/**
 * A notes doc as plain text, for "Copy notes" (docs/plans/redesign-sweep.md, D5): headings and
 * paragraphs as lines, lists as "- " and "1. " lines (nested ones indented), no markdown marks.
 * Citation chips are left out with their times: "03:12" is a pointer into a transcript the reader
 * of a pasted note does not have, and selecting the editor by hand carried them along (W13).
 *
 * Pure and recursive over a doc the page already checked (`isNoteDoc` bounds its depth).
 */
export function noteDocText(doc: NoteDoc): string {
  return blocks(doc.content ?? [], '')
    .join('\n\n')
    .trim();
}

/** Block nodes as paragraphs of text, each a string of one or more lines. */
function blocks(nodes: readonly NoteNode[], indent: string): string[] {
  return nodes.map((node) => block(node, indent)).filter((chunk) => chunk.trim() !== '');
}

function block(node: NoteNode, indent: string): string {
  switch (node.type) {
    case 'bulletList':
    case 'orderedList':
      return list(node, indent);
    case 'blockquote':
    case 'listItem':
      return blocks(node.content ?? [], indent).join('\n');
    case 'horizontalRule':
      return '';
    default:
      return inline(node.content ?? [])
        .split('\n')
        .map((line) => `${indent}${line.trimEnd()}`)
        .join('\n');
  }
}

function list(node: NoteNode, indent: string): string {
  const ordered = node.type === 'orderedList';
  return (node.content ?? [])
    .map((item, index) => {
      const marker = ordered ? `${index + 1}. ` : '- ';
      const [first, ...rest] = item.content ?? [];
      // The item's own text sits after the marker; its later lines line up under the text.
      const head = first === undefined ? [''] : block(first, '').split('\n');
      const lines = [
        `${indent}${marker}${head[0] ?? ''}`,
        ...head.slice(1).map((line) => `${indent}${' '.repeat(marker.length)}${line}`),
        ...rest.map((child) => block(child, `${indent}  `)).filter((chunk) => chunk !== ''),
      ];
      return lines.join('\n');
    })
    .join('\n');
}

/**
 * The words of an inline run: text, hard breaks, code; a chip is nothing. The space typed before
 * a chip goes with it when punctuation follows ("40k [03:12]." reads "40k.", not "40k .").
 */
function inline(nodes: readonly NoteNode[]): string {
  let out = '';
  let afterChip = false;
  for (const node of nodes) {
    if (node.type === CITATION_NODE_TYPE) {
      afterChip = true;
      continue;
    }
    const piece =
      node.type === 'hardBreak'
        ? '\n'
        : node.type === 'text'
          ? (node.text ?? '')
          : inline(node.content ?? []);
    if (afterChip && /^[.,;:!?]/.test(piece)) out = out.trimEnd();
    out += piece;
    afterChip = false;
  }
  return out;
}
