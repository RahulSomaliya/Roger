import { getText, getTextSerializersFromSchema } from '@tiptap/core';
import { Node } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
// The API's AI doc fixture: the one file both sides pin the doc shape with (M4 plan, "The AI notes
// doc"). M4-T8's golden test regenerates it from the API's doc builder; a change re-runs this.
import fixture from '../../../../../api/tests/fixtures/ai_notes_doc.json';
import {
  CITATION_NODE_TYPE,
  MAX_NOTE_DOC_DEPTH,
  type NoteDoc,
  noteDocProblem,
  type NoteNode,
} from '../../../shared/notes';
import {
  MAX_LIST_DEPTH,
  maxListDepth,
  noteDocSchemaProblem,
  noteSchema,
  tabWouldSinkPastListCap,
} from './citationNode';

const SEGMENT_ID = 'fd9daa6d-24ad-4dec-8fca-01604dd531da';

const text = (value: string, marks?: NoteNode['marks']): NoteNode =>
  marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
const paragraph = (...content: NoteNode[]): NoteNode => ({ type: 'paragraph', content });
const item = (...content: NoteNode[]): NoteNode => ({ type: 'listItem', content });
const bulletList = (...items: NoteNode[]): NoteNode => ({ type: 'bulletList', content: items });
const docOf = (...content: NoteNode[]): NoteDoc => ({ type: 'doc', content });
const chip = (): NoteNode => ({
  type: CITATION_NODE_TYPE,
  attrs: { segmentIds: [SEGMENT_ID], startMs: 192_000, label: '03:12', support: 'ok' },
});

/**
 * A bullet list nested `depth` levels deep, one item per level saying its level, and at the
 * deepest level one item per entry of `deepest`, holding that inline content.
 */
function nestedList(depth: number, deepest: NoteNode[][], level = 1): NoteNode {
  if (level === depth) return bulletList(...deepest.map((inline) => item(paragraph(...inline))));
  return bulletList(item(paragraph(text(`level ${level}`)), nestedList(depth, deepest, level + 1)));
}

/** An editor state with the cursor at the end of the text node that reads `marker`. */
function stateWithCursorIn(doc: NoteDoc, marker: string): EditorState {
  const node = Node.fromJSON(noteSchema(), doc);
  const ends: number[] = [];
  node.descendants((child, pos) => {
    if (child.isText && child.text === marker) ends.push(pos + marker.length);
  });
  const cursor = ends[0];
  if (cursor === undefined) throw new Error(`no text "${marker}" in the doc`);
  return EditorState.create({ doc: node, selection: TextSelection.create(node, cursor) });
}

describe('the notes editor schema', () => {
  it("the API's fixture passes Node.fromJSON and doc.check() in the editor schema", () => {
    // setContent strips what the schema refuses without an error, so only fromJSON plus check(),
    // which throw, prove the API's doc fits the editor (M4 plan, "Traps").
    const doc = Node.fromJSON(noteSchema(), fixture);
    expect(() => {
      doc.check();
    }).not.toThrow();
    expect(doc.toJSON()).toEqual(fixture);
    expect(noteDocSchemaProblem(fixture as NoteDoc)).toBeNull();
  });

  it('a list item without a paragraph fails the check', () => {
    const doc = docOf(bulletList(item(bulletList(item(paragraph(text('nested')))))));
    expect(() => {
      Node.fromJSON(noteSchema(), doc).check();
    }).toThrow();
    expect(noteDocSchemaProblem(doc)).toMatch(/listItem/);
  });

  it('refuses a chip without its attrs, and a node the editor does not know', () => {
    expect(noteDocSchemaProblem(docOf(paragraph({ type: CITATION_NODE_TYPE })))).toMatch(
      /segmentIds/,
    );
    const unsure = { ...chip(), attrs: { ...chip().attrs, support: 'maybe' } };
    expect(noteDocSchemaProblem(docOf(paragraph(unsure)))).toMatch(/support/);
    expect(noteDocSchemaProblem(docOf({ type: 'table', content: [] }))).toMatch(/table/);
  });

  it('copies a chip as plain text as its time in brackets', () => {
    const schema = noteSchema();
    const doc = Node.fromJSON(schema, docOf(paragraph(text('Beta ships Friday '), chip())));
    expect(getText(doc, { textSerializers: getTextSerializersFromSchema(schema) })).toBe(
      'Beta ships Friday [03:12]',
    );
  });
});

describe('the list depth cap', () => {
  const link = { type: 'link', attrs: { href: 'https://example.com/a/long/path', target: null } };
  const busy = [
    text('send the deck', [{ type: 'bold' }]),
    text(' and '),
    text('the link', [link]),
    chip(),
  ];

  // shared/notes.ts counts levels by node: an item d lists deep puts its text at 2d + 3 and a
  // link's attrs at 2d + 6, so a deeper cap would let Tab make notes main refuses to save.
  it('lets an item MAX_LIST_DEPTH lists deep hold anything the API stores, and no deeper', () => {
    expect(MAX_LIST_DEPTH).toBe(13);
    expect(MAX_NOTE_DOC_DEPTH).toBe(32);
    expect(noteDocProblem(docOf(nestedList(MAX_LIST_DEPTH, [busy])))).toBeNull();
    expect(noteDocProblem(docOf(nestedList(MAX_LIST_DEPTH + 1, [busy])))).toMatch(/deeper/);
  });

  it('counts the deepest list item', () => {
    const depthOf = (doc: NoteDoc): number => maxListDepth(Node.fromJSON(noteSchema(), doc));
    expect(depthOf(docOf(paragraph(text('none'))))).toBe(0);
    expect(depthOf(docOf(nestedList(5, [[text('x')]])))).toBe(5);
  });

  it('lets Tab sink a list item up to MAX_LIST_DEPTH and no further', () => {
    const siblingsAt = (depth: number): NoteDoc =>
      docOf(nestedList(depth, [[text('first')], [text('second')]]));
    // "second" sinks under "first": from 12 to 13 is fine, from 13 to 14 is refused.
    expect(
      tabWouldSinkPastListCap(stateWithCursorIn(siblingsAt(MAX_LIST_DEPTH - 1), 'second')),
    ).toBe(false);
    expect(tabWouldSinkPastListCap(stateWithCursorIn(siblingsAt(MAX_LIST_DEPTH), 'second'))).toBe(
      true,
    );
  });

  it('refuses to sink an item whose own sub-list would go past the cap', () => {
    // "lead" (level 2) follows "before" and holds a sub-list down to MAX_LIST_DEPTH: sinking it
    // moves that whole sub-list one level deeper.
    const doc = docOf(
      bulletList(
        item(
          paragraph(text('top')),
          bulletList(
            item(paragraph(text('before'))),
            item(paragraph(text('lead')), nestedList(MAX_LIST_DEPTH - 2, [[text('bottom')]])),
          ),
        ),
      ),
    );
    const state = stateWithCursorIn(doc, 'lead');
    expect(maxListDepth(state.doc)).toBe(MAX_LIST_DEPTH);
    expect(tabWouldSinkPastListCap(state)).toBe(true);
  });

  it('leaves Tab alone outside a list and where nothing can sink', () => {
    const plain = docOf(paragraph(text('plain')));
    expect(tabWouldSinkPastListCap(stateWithCursorIn(plain, 'plain'))).toBe(false);
    // The first item of a list has no item before it to sink under.
    const single = docOf(nestedList(1, [[text('only')]]));
    expect(tabWouldSinkPastListCap(stateWithCursorIn(single, 'only'))).toBe(false);
  });

  it('does not lock Tab in a doc that arrived deeper than the cap', () => {
    const doc = docOf(
      nestedList(MAX_LIST_DEPTH + 2, [[text('pasted')]]),
      bulletList(item(paragraph(text('one'))), item(paragraph(text('two')))),
    );
    expect(tabWouldSinkPastListCap(stateWithCursorIn(doc, 'two'))).toBe(false);
  });
});
