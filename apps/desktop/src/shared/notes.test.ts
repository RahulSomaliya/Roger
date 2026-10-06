import { describe, expect, it } from 'vitest';
// The API's AI doc fixture: the one file both sides pin the doc shape with (M4 plan, "The AI notes
// doc"). M4-T8's golden test regenerates it from the API's doc builder.
import fixture from '../../../api/tests/fixtures/ai_notes_doc.json';
import {
  FROM_YOUR_NOTES_HEADING,
  isChatText,
  isCitationAttrs,
  isNoteDoc,
  isNoteKind,
  MAX_CHAT_TEXT_CHARS,
  MAX_NOTE_DOC_BYTES,
  MAX_NOTE_DOC_DEPTH,
  NOT_SAID_ON_THE_CALL,
  type NoteDoc,
  noteDocProblem,
  type NoteNode,
} from './notes';

const SEGMENT_ID = 'fd9daa6d-24ad-4dec-8fca-01604dd531da';
const VALID_ATTRS = { segmentIds: [SEGMENT_ID], startMs: 192_000, label: '03:12', support: 'ok' };

/** A doc with one bullet that ends in a citation chip with these attrs. */
function docWithCitation(attrs: unknown): unknown {
  return {
    type: 'doc',
    content: [
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'Beta ships Friday ' },
                  { type: 'citation', attrs },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function fixtureDoc(): NoteDoc {
  const doc: unknown = fixture;
  if (!isNoteDoc(doc)) {
    throw new Error(`the API fixture is not a notes doc: ${noteDocProblem(doc)}`);
  }
  return doc;
}

function textOf(node: NoteNode): string {
  return node.text ?? (node.content ?? []).map(textOf).join('');
}

describe('notes docs', () => {
  it("accepts the API's fixture doc", () => {
    expect(noteDocProblem(fixture)).toBeNull();
  });

  it('rejects JSON that is not a doc', () => {
    const notDocs: unknown[] = [
      null,
      'doc',
      42,
      [],
      {},
      { type: 'paragraph', content: [] },
      { type: 'doc', content: 'Beta ships Friday' },
      { type: 'doc', content: [1] },
      { type: 'doc', content: [{ text: 'a node with no type' }] },
      { type: 'doc', content: [{ type: '' }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 5 }] }] },
      { type: 'doc', content: [{ type: 'paragraph', attrs: ['not', 'an', 'object'] }] },
      { type: 'doc', content: [{ type: 'text', text: 'x', marks: 'bold' }] },
      { type: 'doc', content: [{ type: 'text', text: 'x', marks: [{ attrs: {} }] }] },
      { type: 'doc', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: 1 }] }] },
      { type: 'doc', content: [{ type: 'paragraph', content: [new Date(0)] }] },
    ];
    for (const value of notDocs) {
      expect(isNoteDoc(value), JSON.stringify(value)).toBe(false);
      expect(typeof noteDocProblem(value), JSON.stringify(value)).toBe('string');
    }
  });

  it('rejects malformed citation attrs', () => {
    expect(isCitationAttrs(VALID_ATTRS)).toBe(true);
    expect(isNoteDoc(docWithCitation(VALID_ATTRS))).toBe(true);

    const malformed: unknown[] = [
      undefined,
      [],
      { ...VALID_ATTRS, segmentIds: undefined },
      { ...VALID_ATTRS, segmentIds: [] },
      { ...VALID_ATTRS, segmentIds: SEGMENT_ID },
      { ...VALID_ATTRS, segmentIds: ['L12'] },
      // The navigator matches ids as text against `data-segment-id`: another case never matches.
      { ...VALID_ATTRS, segmentIds: [SEGMENT_ID.toUpperCase()] },
      { ...VALID_ATTRS, startMs: -1 },
      { ...VALID_ATTRS, startMs: 1.5 },
      { ...VALID_ATTRS, startMs: '192000' },
      { ...VALID_ATTRS, label: '' },
      { ...VALID_ATTRS, label: 192 },
      { ...VALID_ATTRS, support: 'strong' },
      { segmentIds: [SEGMENT_ID], startMs: 0, label: '00:00' },
    ];
    for (const attrs of malformed) {
      expect(isCitationAttrs(attrs), JSON.stringify(attrs)).toBe(false);
      expect(isNoteDoc(docWithCitation(attrs)), JSON.stringify(attrs)).toBe(false);
    }
  });

  it('accepts the From your notes section of the fixture', () => {
    const content = fixtureDoc().content ?? [];
    const start = content.findIndex(
      (node) => node.type === 'heading' && textOf(node) === FROM_YOUR_NOTES_HEADING,
    );
    expect(start).toBeGreaterThan(0);

    // D7 (a): the closing section is the heading, a muted line, then plain bullets with no chips.
    const [heading, notice, list, ...after] = content.slice(start);
    expect(heading?.attrs).toEqual({ level: 2 });
    expect(notice && textOf(notice)).toBe(NOT_SAID_ON_THE_CALL);
    expect(notice?.content?.[0]?.marks).toEqual([{ type: 'italic' }]);
    expect(list?.type).toBe('bulletList');
    expect(JSON.stringify(list)).not.toContain('"citation"');
    expect(after).toEqual([]);

    const section: unknown = { type: 'doc', content: content.slice(start) };
    expect(noteDocProblem(section)).toBeNull();
  });

  it('refuses __proto__, constructor and prototype keys anywhere in the doc', () => {
    // JSON.parse makes these own keys, as a doc that arrives over IPC or from the API would carry
    // them; an object literal would set the prototype instead.
    const docs = [
      '{"type":"doc","__proto__":{"polluted":true}}',
      '{"type":"doc","content":[{"type":"paragraph","constructor":{}}]}',
      '{"type":"doc","content":[{"type":"paragraph","attrs":{"prototype":{}}}]}',
      '{"type":"doc","content":[{"type":"text","text":"x","marks":[{"type":"link","attrs":{"href":{"__proto__":{}}}}]}]}',
    ];
    for (const json of docs) {
      const doc: unknown = JSON.parse(json);
      expect(noteDocProblem(doc), json).toMatch(/__proto__|constructor|prototype/);
    }
  });

  it('refuses values JSON cannot carry, which IPC can', () => {
    // Structured clone carries these; JSON.stringify throws on a BigInt and turns the rest into
    // something else (NaN into null, a Date into a string, a Map into {}) without a word.
    const attrsValues: unknown[] = [
      10n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(0),
      new Map(),
    ];
    for (const value of attrsValues) {
      const doc = { type: 'doc', content: [{ type: 'paragraph', attrs: { value } }] };
      expect(noteDocProblem(doc), String(value)).toBe('holds a value JSON cannot carry');
    }
    expect(
      noteDocProblem({ type: 'doc', content: [{ type: 'paragraph', attrs: { a: null } }] }),
    ).toBeNull();
  });

  describe('depth', () => {
    // Levels follow the doc's tree: the doc is 1 and each node one below the node holding it (a
    // `content` list sits on its node's level). Inside a node, every other object or array is one
    // level below its parent. The API's 422 (M4-T6) must count no more strictly.
    const TOO_DEEP = `nested deeper than ${MAX_NOTE_DOC_DEPTH} levels`;
    const LINKED: NoteNode = {
      type: 'text',
      text: 'the brief',
      marks: [{ type: 'link', attrs: { href: 'https://example.com/brief', target: '_blank' } }],
    };

    /** A paragraph holding `text`, inside `blockquotes` blockquotes. */
    function quoted(blockquotes: number, text: NoteNode): unknown {
      let node: NoteNode = { type: 'paragraph', content: [text] };
      for (let i = 0; i < blockquotes; i += 1) node = { type: 'blockquote', content: [node] };
      return { type: 'doc', content: [node] };
    }

    it('accepts a doc 32 levels deep and refuses one 33 deep', () => {
      // The plan's limit; both fixtures below are counted for 32, so changing it fails them.
      expect(MAX_NOTE_DOC_DEPTH).toBe(32);
      // Blockquotes at 2 to b + 1, the paragraph at b + 2, its text node at b + 3.
      expect(noteDocProblem(quoted(29, { type: 'text', text: 'x' }))).toBeNull();
      expect(noteDocProblem(quoted(30, { type: 'text', text: 'x' }))).toBe(TOO_DEEP);
    });

    it('counts the objects and arrays of marks and attrs as levels', () => {
      // The text node at b + 3, its marks list at b + 4, the link at b + 5, its attrs at b + 6.
      expect(noteDocProblem(quoted(26, LINKED))).toBeNull();
      expect(noteDocProblem(quoted(27, LINKED))).toBe(TOO_DEEP);
    });

    it('saves a bullet list a user tabbed 13 levels deep, a link in its deepest item', () => {
      // StarterKit sinks a list item on Tab with no cap. Counting every JSON object and array
      // refused the 7th level, and with it every later save of that note.
      let list: NoteNode = {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [LINKED] }] }],
      };
      for (let level = 2; level <= 13; level += 1) {
        const point: NoteNode = { type: 'paragraph', content: [{ type: 'text', text: 'point' }] };
        list = { type: 'bulletList', content: [{ type: 'listItem', content: [point, list] }] };
      }
      // The 13th list at 26, its item 27, paragraph 28, text 29, marks 30, link 31, attrs 32.
      expect(noteDocProblem({ type: 'doc', content: [list] })).toBeNull();
    });

    it('refuses a doc nested thousands deep, by nodes or inside attrs, without recursing', () => {
      const deepNodes: unknown = { type: 'paragraph' };
      const deepArrays: unknown[] = [];
      // A `content` key inside attrs still costs its objects a level each.
      const deepContentKeys: Record<string, unknown> = {};
      let node = deepNodes;
      let array = deepArrays;
      let object = deepContentKeys;
      for (let i = 0; i < 100_000; i += 1) {
        node = { type: 'blockquote', content: [node] };
        const innerArray: unknown[] = [];
        array.push(innerArray);
        array = innerArray;
        const innerObject: Record<string, unknown> = {};
        object.content = [innerObject];
        object = innerObject;
      }
      const docs: unknown[] = [
        { type: 'doc', content: [node] },
        { type: 'doc', content: [{ type: 'paragraph', attrs: { values: deepArrays } }] },
        { type: 'doc', content: [{ type: 'paragraph', attrs: deepContentKeys }] },
      ];
      for (const doc of docs) expect(noteDocProblem(doc)).toBe(TOO_DEEP);
    });
  });

  it(`refuses a doc over ${MAX_NOTE_DOC_BYTES} bytes of JSON, counted in UTF-8`, () => {
    const withText = (text: string): unknown => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const overhead = JSON.stringify(withText('')).length;
    expect(noteDocProblem(withText('a'.repeat(MAX_NOTE_DOC_BYTES - overhead)))).toBeNull();
    expect(noteDocProblem(withText('a'.repeat(MAX_NOTE_DOC_BYTES - overhead + 1)))).toMatch(
      /larger than/,
    );
    // "\u00e9" (e acute) is one character in JavaScript and two bytes on the wire.
    expect(noteDocProblem(withText('\u00e9'.repeat(MAX_NOTE_DOC_BYTES / 2)))).toMatch(
      /larger than/,
    );
  });
});

describe('note kinds', () => {
  it('knows the user and AI docs and nothing else', () => {
    expect(isNoteKind('user')).toBe(true);
    expect(isNoteKind('ai')).toBe(true);
    for (const value of ['AI', 'chat', '', null, undefined, 1]) {
      expect(isNoteKind(value)).toBe(false);
    }
  });
});

describe('chat text', () => {
  it(`takes 1 to ${MAX_CHAT_TEXT_CHARS} characters with something besides spaces`, () => {
    expect(isChatText('What did they decide about the pilot?')).toBe(true);
    expect(isChatText('x'.repeat(MAX_CHAT_TEXT_CHARS))).toBe(true);
    for (const value of ['', '   \n\t', 'x'.repeat(MAX_CHAT_TEXT_CHARS + 1), null, 42]) {
      expect(isChatText(value)).toBe(false);
    }
  });

  it('counts characters as the API does, not UTF-16 units', () => {
    // An emoji is one character to the API's length check and two units to String.length.
    expect(isChatText('\u{1F642}'.repeat(MAX_CHAT_TEXT_CHARS))).toBe(true);
    expect(isChatText('\u{1F642}'.repeat(MAX_CHAT_TEXT_CHARS + 1))).toBe(false);
  });
});
