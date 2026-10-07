import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { idleCaptureStatus } from '../../../shared/capture';
import type { LocalNote } from '../../../shared/notes';
import type { MeetingSlotProps, SlotEntry, Slots } from '../app/slotRegistry';
import { type AiNotesApi, AiNotesSession, type AiNotesState } from '../notes/aiNotesActions';
import { useCitationNavigator } from '../transcript/transcriptNavigator';
import { MeetingPage } from './MeetingPage';
import { useMeetingView } from './useMeeting';
import type * as UseMeeting from './useMeeting';

// What the page's AI notes session says: a test sets it, and the real session class holds it. The
// session's channels are never called (the page's effects do not run under renderToString).
const fakes = vi.hoisted(() => ({ state: null as AiNotesState | null }));

const NOTES_API: AiNotesApi = {
  getNotes: vi.fn(),
  saveNote: vi.fn(),
  listNoteTemplates: vi.fn(),
  generateNotes: vi.fn(),
  cancelNotesGenerate: vi.fn(),
  getPendingGenerate: vi.fn(),
  getNotesRun: vi.fn(),
  onNoteChanged: vi.fn(),
  onNotesEvent: vi.fn(),
  onPendingGenerateChanged: vi.fn(),
};

// The page with every region mounted, as it is once M4-T20's slot file mounts the notes and chat
// (the real slot files are mocked here). Each stand-in shows what it can read.
vi.mock('../app/slots', () => {
  const region =
    (name: string) =>
    ({ meetingId }: MeetingSlotProps) =>
      createElement('p', { className: `stand-in-${name}` }, `${name} of ${meetingId}`);
  const entry = (
    id: string,
    component: (props: MeetingSlotProps) => unknown,
  ): SlotEntry<MeetingSlotProps> => ({
    id,
    order: 0,
    component: component as SlotEntry<MeetingSlotProps>['component'],
  });
  // Calls both hooks a transcript needs: either one throws without the page around it.
  const Transcript = ({ meetingId }: MeetingSlotProps) => {
    const navigator = useCitationNavigator();
    const view = useMeetingView();
    return createElement(
      'p',
      { className: 'stand-in-transcript' },
      `transcript of ${meetingId} (${view.storedLines.length} stored lines, reveal: ${typeof navigator.reveal})`,
    );
  };
  const slots: Slots = {
    banner: [],
    home: [],
    settings: [],
    setup: [],
    meetingBanner: [],
    meetingCaptureStatus: [],
    meetingAudioNote: [],
    meetingCaptureReport: [],
    meetingTranscript: [entry('transcript', Transcript)],
    meetingMyNotes: [entry('my-notes', region('my-notes'))],
    meetingAiNotes: [entry('ai-notes', region('ai-notes'))],
    meetingChat: [entry('chat', region('chat'))],
  };
  return { slots };
});
vi.mock('../app/ShellContext', () => ({
  useShell: () => ({
    route: { name: 'meeting', meetingId: MEETING },
    navigate: vi.fn(),
    capture: {
      status: idleCaptureStatus({
        state: 'idle',
        pending: 0,
        rejected: 0,
        lastError: null,
        nextAttemptAt: null,
      }),
      segments: [],
      interim: { mic: null, system: null },
      localError: null,
      busy: false,
      start: vi.fn(),
      stop: vi.fn(),
    },
    captureMeeting: null,
    startNewNote: vi.fn(),
    stopRecording: vi.fn(),
    actionError: null,
  }),
}));
vi.mock('./useMeeting', async (importOriginal) => ({
  ...(await importOriginal<typeof UseMeeting>()),
  useMeetingNotes: (meetingId: string) => {
    const session = new AiNotesSession(NOTES_API, meetingId);
    return { session, state: fakes.state ?? session.getState() };
  },
  useMeeting: () => ({
    value: {
      id: MEETING,
      title: 'Northwind renewal: scope and pricing',
      startedAt: '2026-10-06T09:00:00.000Z',
      endedAt: '2026-10-06T09:45:00.000Z',
      segments: [],
    },
    error: null,
    refresh: vi.fn(),
  }),
}));

const MEETING = '9b2e6f10-7c4d-4a5b-8e3f-61a0c2d9e874';

const page = (): string => renderToString(createElement(MeetingPage, { meetingId: MEETING }));

/** The opening tag of the element whose id is `id`. */
function tagWithId(html: string, id: string): string {
  const tag = new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0];
  if (tag === undefined) throw new Error(`no element with id ${id}`);
  return tag;
}

const AI_NOTE: LocalNote = {
  meetingId: MEETING,
  kind: 'ai',
  doc: { type: 'doc', content: [] },
  revisionId: null,
  dirty: false,
  baseVersion: 1,
  templateId: 'general',
  lastRunId: null,
  generatedVersion: 1,
  conflictCopy: null,
  sync: 'synced',
  updatedAt: '2026-10-06T11:12:00.000Z',
};

/** What the session says once main has answered and the meeting has AI notes. */
function withAiNotes(): AiNotesState {
  return { ...new AiNotesSession(NOTES_API, MEETING).getState(), status: 'ready', note: AI_NOTE };
}

/** The tab row's tabs, as [label, selected]. */
function tabs(html: string): [string, string][] {
  return [
    ...html.matchAll(/<button[^>]*role="tab"[^>]*aria-selected="(true|false)"[^>]*>([^<]*)</g),
  ].map((match) => [match[2] ?? '', match[1] ?? '']);
}

describe('the meeting page with every region mounted', () => {
  it('gives each region its meeting, inside the citation navigator and the page view', () => {
    fakes.state = null;
    const html = page();
    expect(html).toContain(`my-notes of ${MEETING}`);
    expect(html).toContain(`chat of ${MEETING}`);
    expect(html).toContain(`transcript of ${MEETING} (0 stored lines, reveal: function)`);
  });

  it('has one tab row, My notes then Transcript then Chat, opening on your notes', () => {
    fakes.state = null;
    const html = page();
    expect(tabs(html)).toEqual([
      ['My notes', 'true'],
      ['Transcript', 'false'],
      ['Chat', 'false'],
    ]);
    expect(tagWithId(html, 'meeting-panel-mine')).not.toContain('hidden');
  });

  it('shows no AI notes tab before there are AI notes, and no empty state in its place', () => {
    // The AI notes slot IS mounted here: the page holds the tab back until notes exist or are
    // being written ("No AI notes yet / Generate notes" is gone with its empty state).
    fakes.state = null;
    const html = page();
    expect(tabs(html).map(([label]) => label)).not.toContain('AI notes');
    expect(html).not.toContain(`ai-notes of ${MEETING}`);
    expect(html).not.toContain('No AI notes yet');
  });

  it('adds the AI notes tab, mounted and closed, once AI notes exist', () => {
    fakes.state = withAiNotes();
    const html = page();
    expect(tabs(html)).toEqual([
      ['My notes', 'true'],
      ['AI notes', 'false'],
      ['Transcript', 'false'],
      ['Chat', 'false'],
    ]);
    expect(tagWithId(html, 'meeting-panel-ai')).toContain('hidden=""');
    expect(html).toContain(`ai-notes of ${MEETING}`);
  });

  it('keeps the transcript mounted while another tab shows, so a reveal can find its lines', () => {
    fakes.state = null;
    const html = page();
    expect(tagWithId(html, 'meeting-panel-transcript')).toContain('hidden=""');
    expect(html).toContain('class="stand-in-transcript"');
  });

  it('labels each pane by its tab, for a screen reader', () => {
    fakes.state = null;
    const html = page();
    expect(tagWithId(html, 'meeting-panel-chat')).toContain('aria-labelledby="meeting-tab-chat"');
    expect(tagWithId(html, 'meeting-tab-chat')).toContain('aria-controls="meeting-panel-chat"');
  });

  it('has no side-by-side layout and no second row of tabs', () => {
    fakes.state = withAiNotes();
    const html = page();
    expect(html).not.toContain('data-layout');
    expect(html).not.toContain('meeting-pane-button');
    expect(html.match(/role="tablist"/g)).toHaveLength(1);
  });
});
