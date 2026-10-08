import { describe, expect, it } from 'vitest';
import type { NoteDoc } from '../../../shared/notes';
import { noteDocText } from './noteText';

const text = (value: string) => ({ type: 'text', text: value });
const para = (...content: ReturnType<typeof text>[]) => ({ type: 'paragraph', content });
const chip = {
  type: 'citation',
  attrs: { segmentIds: ['a'], startMs: 192000, label: '03:12', support: 'ok' },
};

describe('noteDocText', () => {
  it('writes headings, paragraphs and lists as plain lines with no markup', () => {
    const doc: NoteDoc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [text('Decisions')] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [para(text('Ship on Friday'))] },
            {
              type: 'listItem',
              content: [
                para(text('Owners')),
                {
                  type: 'orderedList',
                  content: [
                    { type: 'listItem', content: [para(text('Ana'))] },
                    { type: 'listItem', content: [para(text('Ben'))] },
                  ],
                },
              ],
            },
          ],
        },
        para(text('Thanks, all.')),
      ],
    };
    expect(noteDocText(doc)).toBe(
      [
        'Decisions',
        '',
        '- Ship on Friday',
        '- Owners',
        '  1. Ana',
        '  2. Ben',
        '',
        'Thanks, all.',
      ].join('\n'),
    );
  });

  it('leaves the citation chips and their times out', () => {
    const doc: NoteDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [text('Budget is 40k '), chip, text('.')] }],
    };
    const out = noteDocText(doc);
    expect(out).toBe('Budget is 40k.');
    expect(out).not.toContain('03:12');
  });

  it('keeps a hard break as a line break and ignores marks', () => {
    const doc: NoteDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'one', marks: [{ type: 'bold' }] },
            { type: 'hardBreak' },
            text('two'),
          ],
        },
      ],
    };
    expect(noteDocText(doc)).toBe('one\ntwo');
  });

  it('is empty for a doc with no words', () => {
    expect(noteDocText({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe('');
    expect(noteDocText({ type: 'doc' })).toBe('');
  });
});
