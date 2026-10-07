import { describe, expect, it } from 'vitest';
import { MAX_CHAT_TEXT_CHARS, MAX_NOTE_DOC_BYTES, type NoteDoc } from '../../shared/notes';
import {
  parseChatAnswerRequest,
  parseGenerateNotesRequest,
  parseMeetingIdPayload,
  parseNotesFlushAck,
  parseNotesRunRequest,
  parseResolveNoteConflictRequest,
  parseSaveNoteRequest,
  parseSendChatMessageRequest,
  type Parsed,
} from './notes-ipc-validation';

const MEETING = '0b8e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const RUN = '7f3c9d1e-2a4b-4c6d-8e0f-1a2b3c4d5e6f';
const MESSAGE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REVISION = '1d2c3b4a-5f6e-4d7c-9b8a-0f1e2d3c4b5a';
const SECRET = 'Pricing for Acme is 40k';

function docSaying(text: string): NoteDoc {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function refused<T>(parsed: Parsed<T>): string {
  if (parsed.ok) throw new Error('expected a refusal');
  return parsed.problem;
}

describe('the notes and chat payloads', () => {
  it('refuses oversized docs, bad ids, unknown kinds and over-long chat text', () => {
    const save = { meetingId: MEETING, kind: 'user', doc: docSaying('x'), base: null };
    const huge = docSaying('a'.repeat(MAX_NOTE_DOC_BYTES));
    const proto = JSON.parse('{"type":"doc","content":[],"__proto__":{"x":1}}') as unknown;
    const cases: [string, Parsed<unknown>, string][] = [
      ['a doc over the size limit', parseSaveNoteRequest({ ...save, doc: huge }), 'the doc'],
      ['a doc with a __proto__ key', parseSaveNoteRequest({ ...save, doc: proto }), '__proto__'],
      ['a doc that is no doc', parseSaveNoteRequest({ ...save, doc: SECRET }), 'not a TipTap'],
      ['an unknown kind', parseSaveNoteRequest({ ...save, kind: 'draft' }), 'kind'],
      [
        'an upper-case meeting id',
        parseSaveNoteRequest({ ...save, meetingId: MEETING.toUpperCase() }),
        'meetingId',
      ],
      ['a path for a meeting id', parseMeetingIdPayload('../notes.sqlite'), 'meeting id'],
      ['no payload', parseMeetingIdPayload(undefined), 'meeting id'],
      [
        'a base with a bad revision',
        parseSaveNoteRequest({ ...save, base: { revisionId: 'r', version: 1 } }),
        'base',
      ],
      [
        'a base with a negative version',
        parseSaveNoteRequest({ ...save, base: { revisionId: null, version: -1 } }),
        'base',
      ],
      [
        'a save with no base',
        parseSaveNoteRequest({ meetingId: MEETING, kind: 'user', doc: docSaying('x') }),
        'base',
      ],
      [
        'an unknown conflict choice',
        parseResolveNoteConflictRequest({ meetingId: MEETING, kind: 'user', keep: 'both' }),
        'keep',
      ],
      [
        'a template id that is no id',
        parseGenerateNotesRequest({ meetingId: MEETING, templateId: 'Stand up!' }),
        'templateId',
      ],
      [
        'a blank template id',
        parseGenerateNotesRequest({ meetingId: MEETING, templateId: '' }),
        'templateId',
      ],
      ['a bad run id', parseNotesRunRequest({ meetingId: MEETING, runId: 'run-1' }), 'runId'],
      ['a bad flush id', parseNotesFlushAck({ requestId: 42 }), 'requestId'],
      [
        'chat text over the limit',
        parseSendChatMessageRequest({
          meetingId: MEETING,
          messageId: MESSAGE,
          text: 'a'.repeat(MAX_CHAT_TEXT_CHARS + 1),
        }),
        'text',
      ],
      [
        'blank chat text',
        parseSendChatMessageRequest({ meetingId: MEETING, messageId: MESSAGE, text: '   ' }),
        'text',
      ],
      [
        'a bad message id',
        parseSendChatMessageRequest({ meetingId: MEETING, messageId: 'm1', text: 'Why?' }),
        'messageId',
      ],
      [
        'a cancel with a bad message id',
        parseChatAnswerRequest({ meetingId: MEETING, messageId: null }),
        'messageId',
      ],
      ['an array for a request', parseChatAnswerRequest([MEETING, MESSAGE]), 'object'],
    ];
    for (const [what, parsed, named] of cases) {
      expect(refused(parsed), what).toContain(named);
    }
  });

  it('names the broken rule, never what the user typed', () => {
    const problems = [
      refused(
        parseSaveNoteRequest({
          meetingId: SECRET,
          kind: 'user',
          doc: docSaying(SECRET),
          base: null,
        }),
      ),
      refused(
        parseSaveNoteRequest({
          meetingId: MEETING,
          kind: SECRET,
          doc: docSaying(SECRET),
          base: null,
        }),
      ),
      refused(parseSendChatMessageRequest({ meetingId: MEETING, messageId: SECRET, text: SECRET })),
      refused(parseGenerateNotesRequest({ meetingId: MEETING, templateId: SECRET })),
    ];
    for (const problem of problems) expect(problem).not.toContain('Acme');
  });

  it('takes each well-formed payload as a fresh object of the fields it checked', () => {
    const doc = docSaying('Ship beta Friday');
    expect(
      parseSaveNoteRequest({
        meetingId: MEETING,
        kind: 'ai',
        doc,
        base: { revisionId: REVISION, version: 3, extra: true },
        sender: 'forged',
      }),
    ).toEqual({
      ok: true,
      value: { meetingId: MEETING, kind: 'ai', doc, base: { revisionId: REVISION, version: 3 } },
    });
    expect(
      parseSaveNoteRequest({
        meetingId: MEETING,
        kind: 'user',
        doc,
        base: { revisionId: null, version: 0 },
      }),
    ).toEqual({
      ok: true,
      value: { meetingId: MEETING, kind: 'user', doc, base: { revisionId: null, version: 0 } },
    });
    expect(parseMeetingIdPayload(MEETING)).toEqual({ ok: true, value: MEETING });
    expect(
      parseResolveNoteConflictRequest({ meetingId: MEETING, kind: 'user', keep: 'theirs', x: 1 }),
    ).toEqual({ ok: true, value: { meetingId: MEETING, kind: 'user', keep: 'theirs' } });
    expect(parseGenerateNotesRequest({ meetingId: MEETING, templateId: 'one_on_one' })).toEqual({
      ok: true,
      value: { meetingId: MEETING, templateId: 'one_on_one' },
    });
    expect(parseNotesRunRequest({ meetingId: MEETING, runId: RUN })).toEqual({
      ok: true,
      value: { meetingId: MEETING, runId: RUN },
    });
    expect(parseNotesFlushAck({ requestId: RUN })).toEqual({ ok: true, value: { requestId: RUN } });
    // Code points, as the API counts characters: 4000 emoji are 8000 UTF-16 units.
    const longest = '\u{1F600}'.repeat(MAX_CHAT_TEXT_CHARS);
    expect(
      parseSendChatMessageRequest({ meetingId: MEETING, messageId: MESSAGE, text: longest }),
    ).toEqual({ ok: true, value: { meetingId: MEETING, messageId: MESSAGE, text: longest } });
    expect(parseChatAnswerRequest({ meetingId: MEETING, messageId: MESSAGE })).toEqual({
      ok: true,
      value: { meetingId: MEETING, messageId: MESSAGE },
    });
  });
});
