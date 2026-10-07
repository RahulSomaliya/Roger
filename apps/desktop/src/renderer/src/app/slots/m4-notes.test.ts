import { createElement } from 'react';
import type * as React from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingChat } from '../../chat/MeetingChat';
import { AiNotesPanel } from '../../notes/AiNotesPanel';
import type { NoteEditorProps } from '../../notes/NoteEditor';
import type { SlotEntry } from '../slotRegistry';
import { contributions } from './m4-notes';

// The editor is a stand-in: this checks what the slot hands it. The editor is NoteEditor.test.ts's
// and the page with the real regions is checked in the browser (e2e/m4-t20.qa.e2e.ts).
const fakes = vi.hoisted(() => ({
  editors: [] as NoteEditorProps[],
  responderCalls: 0,
}));
vi.mock('../../notes/NoteEditor', () => ({
  NoteEditor: (props: NoteEditorProps) => {
    fakes.editors.push(props);
    return null;
  },
}));
vi.mock('../../notes/debouncedSaver', () => ({
  notesFlushResponder: () => {
    fakes.responderCalls += 1;
  },
}));
// Node has no effects under renderToString: run them as the page would, once, in order.
const effects = vi.hoisted(() => ({ run: [] as (() => void)[] }));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useEffect: (effect: () => void) => {
    effects.run.push(effect);
  },
}));

const MEETING = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';

beforeEach(() => {
  fakes.editors = [];
  fakes.responderCalls = 0;
  effects.run = [];
});

function only<Props>(entries: readonly SlotEntry<Props>[] | undefined, slot: string) {
  const [entry] = entries ?? [];
  if (entries?.length !== 1 || entry === undefined) {
    throw new Error(`M4-T20 mounts exactly one entry in ${slot}`);
  }
  return entry;
}

describe("M4-T20's meeting regions", () => {
  it('mounts My notes as the user editor, named for its tab, with the notepad placeholder', () => {
    const entry = only(contributions.meetingMyNotes, 'meetingMyNotes');
    renderToString(createElement(entry.component, { meetingId: MEETING }));
    expect(fakes.editors).toEqual([
      {
        meetingId: MEETING,
        kind: 'user',
        label: 'My notes',
        placeholder: 'Type your notes. Roger turns them into clean notes after the call.',
      },
    ]);
  });

  it('mounts the AI notes panel and the meeting chat, each for its own slot', () => {
    expect(only(contributions.meetingAiNotes, 'meetingAiNotes').component).toBe(AiNotesPanel);
    expect(only(contributions.meetingChat, 'meetingChat').component).toBe(MeetingChat);
  });

  it('mounts no Settings section: the notes have nothing left to set', () => {
    expect(contributions.settings).toBeUndefined();
  });
});

describe("M4-T20's flush responder", () => {
  // Without it a window that never opened notes never acks main's flush: Stop of a meeting nobody
  // spoke in waits 1 s per window and keeps the meeting (NotesQuitGuard.saveOpenNotes).
  it('is started once by an entry in the banner, which every page shows', () => {
    const entry = only(contributions.banner, 'banner');
    renderToString(createElement(entry.component, {}));
    for (const effect of effects.run) effect();
    expect(fakes.responderCalls).toBe(1);
  });
});
