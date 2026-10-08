import { describe, expect, it, vi } from 'vitest';
import type { LocalNote, MeetingNotes, NoteDoc, NoteKind } from '../../../shared/notes';
import { copyNotes } from './copyNotes';

const MEETING = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';

const note = (kind: NoteKind, doc: NoteDoc): LocalNote => ({
  meetingId: MEETING,
  kind,
  doc,
  revisionId: null,
  dirty: false,
  baseVersion: 1,
  templateId: null,
  lastRunId: null,
  generatedVersion: null,
  conflictCopy: null,
  sync: 'synced',
  updatedAt: '2026-10-08T09:00:00.000Z',
});

const words = (text: string): NoteDoc => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function deps(notes: Partial<MeetingNotes>, writeText = vi.fn(() => Promise.resolve())) {
  return {
    writeText,
    getNotes: vi.fn(() => Promise.resolve({ meetingId: MEETING, user: null, ai: null, ...notes })),
  };
}

describe('copyNotes', () => {
  it('puts the plain text of the notes in view on the clipboard and says it was copied', async () => {
    const d = deps({ user: note('user', words('mine')), ai: note('ai', words('theirs')) });
    expect(await copyNotes(d, MEETING, 'ai')).toEqual({ kind: 'copied' });
    expect(d.writeText).toHaveBeenCalledWith('theirs');
    expect(await copyNotes(d, MEETING, 'user')).toEqual({ kind: 'copied' });
    expect(d.writeText).toHaveBeenLastCalledWith('mine');
  });

  it('copies nothing, and says so, when the notes hold no words', async () => {
    const d = deps({ user: note('user', { type: 'doc', content: [{ type: 'paragraph' }] }) });
    expect(await copyNotes(d, MEETING, 'user')).toEqual({ kind: 'empty' });
    expect(await copyNotes(d, MEETING, 'ai')).toEqual({ kind: 'empty' });
    expect(d.writeText).not.toHaveBeenCalled();
  });

  it('reports a clipboard that refused instead of claiming a copy', async () => {
    const d = deps(
      { ai: note('ai', words('theirs')) },
      vi.fn(() => Promise.reject(new Error('NotAllowedError'))),
    );
    const outcome = await copyNotes(d, MEETING, 'ai');
    expect(outcome.kind).toBe('failed');
  });

  it('reports a read of the notes that failed', async () => {
    const d = {
      writeText: vi.fn(() => Promise.resolve()),
      getNotes: vi.fn(() => Promise.reject(new Error('boom'))),
    };
    expect((await copyNotes(d, MEETING, 'user')).kind).toBe('failed');
    expect(d.writeText).not.toHaveBeenCalled();
  });
});
