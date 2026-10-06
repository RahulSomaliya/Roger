import {
  Extension,
  type Extensions,
  getSchema,
  mergeAttributes,
  Node,
  type NodeViewRenderer,
} from '@tiptap/core';
import { Placeholder } from '@tiptap/extensions';
import { Node as DocNode, type Schema } from '@tiptap/pm/model';
import { sinkListItem } from '@tiptap/pm/schema-list';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { StarterKit } from '@tiptap/starter-kit';
import {
  CITATION_NODE_TYPE,
  type CitationAttrs,
  isCitationAttrs,
  MAX_NOTE_DOC_DEPTH,
  type NoteDoc,
} from '../../../shared/notes';

/**
 * The notes editor's schema: StarterKit as both notes editors configure it, plus the inline
 * `citation` node an AI notes chip is. The API's doc builder (`notes_generation.py`, M4-T8) writes
 * the same node, and both sides pin its shape with one fixture, apps/api/tests/fixtures/
 * ai_notes_doc.json (citationNode.test.ts). Change the node and the builder together.
 *
 * TipTap's `setContent` drops what this schema refuses without an error (and turns JSON it cannot
 * read into an empty doc), so a doc from main is checked here with `Node.fromJSON` and `check()`,
 * which throw, before the editor shows it (`noteDocSchemaProblem`).
 */

/** The `data-*` attributes a chip carries in HTML, so copy and paste between notes keeps it. */
const CHIP_HTML = {
  marker: 'data-citation',
  segmentIds: 'data-segment-ids',
  startMs: 'data-start-ms',
  label: 'data-label',
  support: 'data-support',
} as const;

/** A chip's attrs as an HTML element carries them, unchecked: `isCitationAttrs` decides. */
function citationAttrsFromElement(element: HTMLElement): Record<keyof CitationAttrs, unknown> {
  const startMs = element.getAttribute(CHIP_HTML.startMs) ?? '';
  return {
    segmentIds: (element.getAttribute(CHIP_HTML.segmentIds) ?? '').split(' ').filter(Boolean),
    startMs: /^\d+$/.test(startMs) ? Number(startMs) : Number.NaN,
    label: element.getAttribute(CHIP_HTML.label),
    support: element.getAttribute(CHIP_HTML.support),
  };
}

/** A citation node's attrs, or null when they are not a chip's (never from a checked doc). */
export function citationAttrsOf(node: DocNode): CitationAttrs | null {
  const attrs: unknown = node.attrs;
  return isCitationAttrs(attrs) ? attrs : null;
}

/** Attrs `isCitationAttrs` accepts, so one attr at a time can be checked against that rule. */
const VALID_CITATION: CitationAttrs = {
  segmentIds: ['00000000-0000-4000-8000-000000000000'],
  startMs: 0,
  label: '00:00',
  support: 'ok',
};

/**
 * Throws unless `value` may be this attr of a chip, by shared/notes.ts's rule (the one main and
 * the API apply). Required attrs alone are not enough: ProseMirror fills every attr with null when
 * a node's `attrs` is missing altogether (`null && ...` in its computeAttrs), and only `validate`
 * sees that null, in `Node.fromJSON` and again in `check()`.
 */
function validateCitationAttr(key: keyof CitationAttrs): (value: unknown) => void {
  return (value) => {
    if (!isCitationAttrs({ ...VALID_CITATION, [key]: value })) {
      throw new RangeError(`A citation's ${key} is not a chip's: ${JSON.stringify(value)}`);
    }
  };
}

/**
 * One chip: an inline atom (the cursor steps over it, Backspace deletes it whole). Every attr is
 * required and checked, so a chip that lost one fails `Node.fromJSON` instead of becoming a chip
 * that points nowhere. Its view (CitationChip.tsx) is added by the editor, never here, so the
 * schema stays usable under Node.
 */
export const CitationNode = Node.create({
  name: CITATION_NODE_TYPE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    // Each attr reads and writes its own data-* attribute; parseHTML below checks them together.
    const attribute = <Key extends keyof CitationAttrs>(
      key: Key,
      render: (value: unknown) => string,
    ) => ({
      isRequired: true,
      validate: validateCitationAttr(key),
      parseHTML: (element: HTMLElement) => citationAttrsFromElement(element)[key],
      renderHTML: (attributes: Record<string, unknown>) => ({
        [CHIP_HTML[key]]: render(attributes[key]),
      }),
    });
    return {
      segmentIds: attribute('segmentIds', (value) =>
        Array.isArray(value) ? value.filter((id) => typeof id === 'string').join(' ') : '',
      ),
      startMs: attribute('startMs', (value) => (typeof value === 'number' ? String(value) : '')),
      label: attribute('label', (value) => (typeof value === 'string' ? value : '')),
      support: attribute('support', (value) => (typeof value === 'string' ? value : '')),
    };
  },

  parseHTML() {
    return [
      {
        tag: `span[${CHIP_HTML.marker}]`,
        // A pasted chip whose attrs are not a chip's stays text: as a node it would make every
        // later save of these notes fail main's check (isCitationAttrs, shared/notes.ts).
        getAttrs: (element: HTMLElement) =>
          isCitationAttrs(citationAttrsFromElement(element)) ? null : false,
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes({ [CHIP_HTML.marker]: '' }, HTMLAttributes),
      citationAttrsOf(node)?.label ?? '',
    ];
  },

  // Plain-text copy: the chip's time in brackets, as MCP's `get_notes` writes sources.
  renderText({ node }) {
    const attrs = citationAttrsOf(node);
    return attrs === null ? '' : `[${attrs.label}]`;
  },
});

// List depth ------------------------------------------------------------------------------------

/**
 * How many lists deep Tab may sink an item. `noteDocProblem` (shared/notes.ts) counts levels by
 * node: an item d lists deep puts its text at level 2d + 3 and a link mark's attrs, the deepest
 * thing an item holds, at 2d + 6. So at 13 an item holds anything within MAX_NOTE_DOC_DEPTH (32);
 * at 14 a bold word, a link or a chip makes main refuse every later save of the note. StarterKit
 * sinks on Tab with no cap. Blockquotes inside items still cost levels: a refused save shows on
 * the note's status line (NoteEditor), it is never silent.
 */
export const MAX_LIST_DEPTH = Math.floor((MAX_NOTE_DOC_DEPTH - 6) / 2);

/** The most list items any text in `doc` sits inside; 0 with no list. */
export function maxListDepth(doc: DocNode): number {
  let deepest = 0;
  const visit = (node: DocNode, depth: number): void => {
    const here = node.type.name === 'listItem' ? depth + 1 : depth;
    deepest = Math.max(deepest, here);
    node.forEach((child) => {
      visit(child, here);
    });
  };
  visit(doc, 0);
  return deepest;
}

/**
 * Whether Tab here would sink list items past MAX_LIST_DEPTH, counting the sub-lists that move
 * with them. A doc that already holds deeper lists (pasted, or from the API) keeps working: Tab is
 * refused only when it makes the doc's deepest list deeper than both the cap and what it held.
 */
export function tabWouldSinkPastListCap(state: EditorState): boolean {
  const listItem = state.schema.nodes.listItem;
  if (listItem === undefined) return false;
  // A dry run: the command hands its transaction to this dispatch, and nothing applies it.
  const sunk: Transaction[] = [];
  sinkListItem(listItem)(state, (transaction) => {
    sunk.push(transaction);
  });
  const sinking = sunk.at(-1);
  if (sinking === undefined) return false;
  const after = maxListDepth(sinking.doc);
  return after > MAX_LIST_DEPTH && after > maxListDepth(state.doc);
}

/** Swallows Tab where it would sink past the cap; elsewhere StarterKit's list item sinks. */
const ListDepthCap = Extension.create({
  name: 'noteListDepthCap',
  // Above the list item's own Tab (priority 100), whose keymap would sink first.
  priority: 1000,
  addKeyboardShortcuts() {
    return { Tab: ({ editor }) => tabWouldSinkPastListCap(editor.state) };
  },
});

// The editor's extensions --------------------------------------------------------------------------

export interface NoteExtensionOptions {
  /** Shown in an empty editor. */
  placeholder?: string;
  /** How the editor draws a chip (CitationChip.tsx); left out, the schema's own HTML. */
  citationView?: NodeViewRenderer;
}

/**
 * Both notes editors' extensions. The schema depends on none of the options, so the doc check
 * (`noteSchema`) and every editor agree on it.
 */
export function noteExtensions(options: NoteExtensionOptions = {}): Extensions {
  const { placeholder, citationView } = options;
  const citation =
    citationView === undefined
      ? CitationNode
      : CitationNode.extend({ addNodeView: () => citationView });
  return [
    // Link opens nothing on click: in Electron a click would hit the window-open guard, and the
    // user is editing (M4 plan, "Traps").
    StarterKit.configure({ link: { openOnClick: false } }),
    citation,
    ListDepthCap,
    ...(placeholder === undefined ? [] : [Placeholder.configure({ placeholder })]),
  ];
}

let schema: Schema | undefined;

/** The notes schema, built once: what both editors and every doc check use. */
export function noteSchema(): Schema {
  schema ??= getSchema(noteExtensions());
  return schema;
}

/**
 * Why the editor cannot show `doc` as it is, or null when it can. An editor that showed it would
 * drop the parts it cannot hold, and the next save would store the doc without them.
 */
export function noteDocSchemaProblem(doc: NoteDoc, against: Schema = noteSchema()): string | null {
  try {
    DocNode.fromJSON(against, doc).check();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
