import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { idleCaptureStatus } from '../../../shared/capture';
import type { MeetingSlotProps, SlotEntry, Slots } from '../app/slotRegistry';
import { useCitationNavigator } from '../transcript/transcriptNavigator';
import { MeetingPage } from './MeetingPage';
import { useMeetingView } from './useMeeting';
import type * as UseMeeting from './useMeeting';

// The page with every region mounted, as it will be once M4-T20 mounts the notes and chat (the
// real slot files have only the transcript today). Each stand-in shows what it can read.
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

describe('the meeting page with every region mounted', () => {
  it('gives each region its meeting, inside the citation navigator and the page view', () => {
    const html = page();
    expect(html).toContain(`my-notes of ${MEETING}`);
    expect(html).toContain(`chat of ${MEETING}`);
    expect(html).toContain(`transcript of ${MEETING} (0 stored lines, reveal: function)`);
  });

  it('offers Notes, Transcript and Chat for a narrow page, opening on the notes', () => {
    const html = page();
    const buttons = [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)</g)];
    expect(buttons.map((match) => [match[2], match[1]])).toEqual([
      ['Notes', 'true'],
      ['Transcript', 'false'],
      ['Chat', 'false'],
    ]);
    expect(tagWithId(html, 'meeting-pane-notes')).toContain('data-active="true"');
  });

  it('keeps the transcript mounted while another pane shows, so a reveal can find its lines', () => {
    const html = page();
    expect(tagWithId(html, 'meeting-pane-transcript')).not.toContain('data-active');
    expect(html).toContain('class="stand-in-transcript"');
  });

  it('puts My notes and AI notes in tabs, both mounted, My notes open', () => {
    const html = page();
    const tabs = [
      ...html.matchAll(/<button[^>]*role="tab"[^>]*aria-selected="(true|false)"[^>]*>([^<]*)</g),
    ];
    expect(tabs.map((match) => [match[2], match[1]])).toEqual([
      ['My notes', 'true'],
      ['AI notes', 'false'],
    ]);
    expect(tagWithId(html, 'meeting-notes-panel-ai')).toContain('hidden=""');
    expect(html).toContain(`ai-notes of ${MEETING}`);
  });
});
