import { describe, expect, it, vi } from 'vitest';
import type { LocalNote, PendingGenerateState } from '../../../shared/notes';
import type { AiNotesState } from '../notes/aiNotesActions';
import type { AiNotesStreamView } from '../notes/aiNotesStream';
import {
  aiNotesTabExists,
  headerAction,
  type HeaderActionInput,
  notesMenuEntries,
  templateForWriting,
} from './headerAction';

const MEETING = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';

const READY: AiNotesState = {
  status: 'ready',
  loadError: null,
  pending: null,
  note: null,
  stream: null,
  lastRun: { status: 'none' },
  templates: { status: 'loading' },
  confirm: null,
  busy: null,
  cancelling: false,
  actionError: null,
};

const NOTE: LocalNote = {
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

const pending = (status: PendingGenerateState['status']): PendingGenerateState => ({
  meetingId: MEETING,
  runId: '6a0d6a52-6f0c-4c35-9d0e-1c8f7f0f8a11',
  templateId: 'general',
  reason: 'button',
  createdAt: '2026-10-06T11:10:00.000Z',
  status,
});

const PAST: HeaderActionInput = {
  phase: 'idle',
  captureBusy: false,
  elsewhere: false,
  stored: true,
  notes: READY,
};

describe('headerAction: the one primary the table in docs/design.md names', () => {
  it('is Starting… (busy) while the meeting starts', () => {
    expect(headerAction({ ...PAST, phase: 'starting' })).toEqual({ kind: 'start' });
  });

  it('is Stop while it records, and busy once a stop is under way', () => {
    expect(headerAction({ ...PAST, phase: 'recording' })).toEqual({ kind: 'stop', busy: false });
    expect(headerAction({ ...PAST, phase: 'recording', captureBusy: true })).toEqual({
      kind: 'stop',
      busy: true,
    });
    expect(headerAction({ ...PAST, phase: 'stopping' })).toEqual({ kind: 'stop', busy: true });
  });

  it('is Write notes for a stopped meeting with no AI notes', () => {
    expect(headerAction(PAST)).toEqual({ kind: 'write' });
  });

  it('is none once AI notes exist: the notes are the loud thing', () => {
    expect(headerAction({ ...PAST, notes: { ...READY, note: NOTE } })).toEqual({ kind: 'none' });
  });

  it('is Writing notes… (busy) while a run is under way, with Cancel when main can drop it', () => {
    const running = { ...READY, pending: pending({ phase: 'running' }) };
    expect(headerAction({ ...PAST, notes: running })).toEqual({
      kind: 'writing',
      cancellable: true,
      cancelling: false,
    });
    expect(headerAction({ ...PAST, notes: { ...running, cancelling: true } })).toEqual({
      kind: 'writing',
      cancellable: true,
      cancelling: true,
    });
    // The press itself, before main has answered with a pending generate: nothing to cancel yet.
    expect(headerAction({ ...PAST, notes: { ...READY, busy: 'generate' } })).toEqual({
      kind: 'writing',
      cancellable: false,
      cancelling: false,
    });
  });

  it('is Writing notes… while a generate waits for the lines or the notes to upload', () => {
    const waiting = { ...READY, pending: pending({ phase: 'waiting_for_lines', waitingLines: 3 }) };
    expect(headerAction({ ...PAST, notes: waiting })).toEqual({
      kind: 'writing',
      cancellable: true,
      cancelling: false,
    });
  });

  it('is none after a failed generate: its problem line has the Try again', () => {
    const failed = pending({ phase: 'failed', code: 'llm_provider_error', message: 'down' });
    expect(headerAction({ ...PAST, notes: { ...READY, pending: failed } })).toEqual({
      kind: 'none',
    });
  });

  it('is none while another meeting records, and for a meeting this Mac does not hold', () => {
    expect(headerAction({ ...PAST, elsewhere: true })).toEqual({ kind: 'none' });
    expect(headerAction({ ...PAST, stored: false })).toEqual({ kind: 'none' });
  });

  it('is none until main has answered what it holds, so the button never flashes', () => {
    for (const status of ['loading', 'failed'] as const) {
      expect(headerAction({ ...PAST, notes: { ...READY, status } })).toEqual({ kind: 'none' });
    }
  });
});

describe("aiNotesTabExists: the tab that carries the failed run's banner", () => {
  const failedRun = (wrote: boolean): AiNotesStreamView => ({
    runId: '6a0d6a52-6f0c-4c35-9d0e-1c8f7f0f8a11',
    phase: 'failed',
    templateId: 'general',
    sections: [],
    fromNotes: wrote ? ['A line the run wrote before it failed'] : [],
    dropped: [],
    error: { code: 'llm_provider_error', message: 'The model provider is down' },
    saved: null,
  });

  it('is absent for an empty state, and while main has not answered', () => {
    expect(aiNotesTabExists(READY)).toBe(false);
    expect(aiNotesTabExists({ ...READY, status: 'loading' })).toBe(false);
  });

  it('is there once notes exist or a generate is pending', () => {
    expect(aiNotesTabExists({ ...READY, note: NOTE })).toBe(true);
    expect(aiNotesTabExists({ ...READY, pending: pending({ phase: 'running' }) })).toBe(true);
  });

  // A failed run leaves nothing pending and no note, so `layout.empty` is true; the banner (and
  // the lines a partial run wrote) live only in the AI notes pane, so the tab must stay for them.
  it('stays after a run failed with no lines, so its banner has a tab', () => {
    expect(aiNotesTabExists({ ...READY, stream: failedRun(false) })).toBe(true);
  });

  it('stays after a run failed with lines written, which only that pane shows', () => {
    expect(aiNotesTabExists({ ...READY, stream: failedRun(true) })).toBe(true);
  });

  it('offers Write notes beside that tab: the failed run left nothing to retry from the banner', () => {
    expect(headerAction({ ...PAST, notes: { ...READY, stream: failedRun(true) } })).toEqual({
      kind: 'write',
    });
  });
});

describe('templateForWriting', () => {
  it("is the title's best guess, and General when unsure (call 6)", () => {
    expect(templateForWriting('Daily standup')).toBe('standup');
    expect(templateForWriting('Northwind renewal: client demo')).toBe('client_call');
    expect(templateForWriting('Meeting at 5:01 pm')).toBe('general');
    expect(templateForWriting('Untitled meeting')).toBe('general');
  });

  it('reads an outside guest as a client call, and a call with only colleagues as General', () => {
    const me = { email: 'me@linkt.ai', isSelf: true };
    expect(templateForWriting('Sync', [me, { email: 'sam@northwind.com', isSelf: false }])).toBe(
      'client_call',
    );
    expect(templateForWriting('Sync', [me, { email: 'ana@linkt.ai', isSelf: false }])).toBe(
      'general',
    );
    // The title still wins over the guests, as suggestTemplate orders its cues.
    expect(
      templateForWriting('Daily standup', [me, { email: 'sam@northwind.com', isSelf: false }]),
    ).toBe('standup');
  });
});

describe('notesMenuEntries', () => {
  const TEMPLATES: AiNotesState['templates'] = {
    status: 'ready',
    value: [
      { id: 'general', name: 'General', description: '', sections: [] },
      { id: 'standup', name: 'Standup', description: '', sections: [] },
    ],
  };
  const actions = { regenerate: vi.fn(), restorePrevious: vi.fn() };
  const withNotes = (overrides: Partial<AiNotesState> = {}): AiNotesState => ({
    ...READY,
    note: NOTE,
    templates: TEMPLATES,
    ...overrides,
  });

  it('offers Write again as each template once AI notes exist', () => {
    const entries = notesMenuEntries(withNotes(), actions);
    expect(entries.map((entry) => entry.label)).toEqual([
      'Write again as General',
      'Write again as Standup',
    ]);
    entries[1]?.onSelect();
    expect(actions.regenerate).toHaveBeenCalledWith('standup');
  });

  it('offers nothing before there are notes, or while a run is under way', () => {
    expect(notesMenuEntries({ ...READY, templates: TEMPLATES }, actions)).toEqual([]);
    const running = withNotes({ pending: pending({ phase: 'running' }) });
    expect(notesMenuEntries(running, actions)).toEqual([]);
  });

  it('offers no Write again as while the templates have not loaded, and still Restore', () => {
    const restorable = withNotes({
      templates: { status: 'loading' },
      lastRun: {
        status: 'ready',
        runId: 'run-1',
        run: {
          id: 'run-1',
          meetingId: MEETING,
          kind: 'notes',
          status: 'succeeded',
          model: 'm',
          templateId: 'general',
          errorCode: null,
          error: null,
          dropped: [],
          flaggedCount: 0,
          fromNotesCount: 0,
          inputTokens: null,
          outputTokens: null,
          cachedTokens: null,
          costUsd: null,
          startedAt: '2026-10-06T11:10:00.000Z',
          finishedAt: '2026-10-06T11:11:00.000Z',
          outputDoc: null,
          replacedDoc: { type: 'doc', content: [{ type: 'paragraph' }] },
        },
      },
      note: { ...NOTE, lastRunId: 'run-1' },
    });
    const entries = notesMenuEntries(restorable, actions);
    expect(entries.map((entry) => entry.label)).toEqual(['Restore previous notes']);
    entries[0]?.onSelect();
    expect(actions.restorePrevious).toHaveBeenCalled();
  });
});
