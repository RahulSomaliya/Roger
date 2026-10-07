import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  LlmRun,
  LocalNote,
  NoteDoc,
  NoteTemplate,
  PendingGenerateState,
  PendingGenerateStatus,
} from '../../../shared/notes';
import { CitationNavigatorProvider } from '../transcript/transcriptNavigator';
import type { AiNotesState } from './aiNotesActions';
import type { AiNotesStreamView } from './aiNotesStream';
import { type AiNotesPanelActions, AiNotesView } from './AiNotesPanel';
import type { NoteEditorProps } from './NoteEditor';

// Node has no window.roger and no DOM for TipTap: the editor shows what it was given.
vi.mock('./NoteEditor', () => ({
  NoteEditor: (props: NoteEditorProps) =>
    createElement('div', {
      'data-editor': props.kind,
      'data-label': props.label,
      'data-read-only': String(props.readOnly ?? false),
    }),
}));

const MEETING = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';
const RUN = '6a0d6a52-6f0c-4c35-9d0e-1c8f7f0f8a11';
const NEXT_RUN = '0b7c3f1e-9a2d-4e5f-8c61-3d4e5f6a7b8c';
const segment = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const doc = (text: string): NoteDoc => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const TEMPLATES: NoteTemplate[] = [
  { id: 'general', name: 'General', description: 'Any call.', sections: [] },
  { id: 'client_call', name: 'Client call', description: 'Their goals.', sections: [] },
  { id: 'standup', name: 'Standup', description: 'Done, next, blockers.', sections: [] },
  { id: 'one_on_one', name: '1:1', description: 'Updates.', sections: [] },
];

function aiNote(overrides: Partial<LocalNote> = {}): LocalNote {
  return {
    meetingId: MEETING,
    kind: 'ai',
    doc: doc('Year-one price stays at $50k'),
    revisionId: null,
    dirty: false,
    baseVersion: 4,
    templateId: 'client_call',
    lastRunId: RUN,
    generatedVersion: 4,
    conflictCopy: null,
    sync: 'synced',
    updatedAt: '2026-10-06T11:12:00.000Z',
    ...overrides,
  };
}

function pending(status: PendingGenerateStatus): PendingGenerateState {
  return {
    meetingId: MEETING,
    runId: NEXT_RUN,
    templateId: status.phase === 'needs_template' ? null : 'client_call',
    reason: 'after_stop',
    createdAt: '2026-10-06T11:10:00.000Z',
    status,
  };
}

function run(overrides: Partial<LlmRun> = {}): LlmRun {
  return {
    id: RUN,
    meetingId: MEETING,
    kind: 'notes',
    status: 'succeeded',
    model: 'xiaomi/mimo-v2.6-pro',
    templateId: 'client_call',
    errorCode: null,
    error: null,
    dropped: [
      { text: 'Everyone agreed it went well', reason: 'no_refs' },
      { text: 'Budget is $2m', reason: 'unknown_refs' },
    ],
    flaggedCount: 2,
    fromNotesCount: 0,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    costUsd: null,
    startedAt: '2026-10-06T11:10:05.000Z',
    finishedAt: '2026-10-06T11:10:40.000Z',
    outputDoc: null,
    replacedDoc: doc('Price discussed; no decision'),
    ...overrides,
  };
}

const LIVE: AiNotesStreamView = {
  runId: NEXT_RUN,
  phase: 'streaming',
  templateId: 'client_call',
  sections: [
    {
      index: 0,
      heading: 'Their goals',
      items: [
        {
          text: 'Finance needs BI exports before rollout',
          chips: [
            {
              segmentIds: [segment(12), segment(13)],
              startMs: 192_000,
              label: '03:12',
              support: 'ok',
            },
          ],
          support: 'ok',
        },
        {
          text: 'Multi-year at $47k if signed before the 30th',
          chips: [
            { segmentIds: [segment(40)], startMs: 1_730_000, label: '28:50', support: 'weak' },
          ],
          support: 'weak',
        },
      ],
    },
    { index: 1, heading: 'Decisions', items: [] },
  ],
  fromNotes: ['Ask about the Q3 renewal date'],
  dropped: [{ text: 'It went well', reason: 'no_refs' }],
  error: null,
  saved: null,
};

function state(overrides: Partial<AiNotesState> = {}): AiNotesState {
  return {
    status: 'ready',
    loadError: null,
    pending: null,
    note: null,
    stream: null,
    lastRun: { status: 'none' },
    templates: { status: 'ready', value: TEMPLATES },
    confirm: null,
    picker: null,
    busy: null,
    cancelling: false,
    actionError: null,
    ...overrides,
  };
}

const ACTIONS: AiNotesPanelActions = {
  openPicker: () => undefined,
  closePicker: () => undefined,
  pick: () => Promise.resolve(true),
  generate: () => Promise.resolve(true),
  regenerate: () => Promise.resolve(true),
  restorePrevious: () => Promise.resolve(true),
  confirmAction: () => Promise.resolve(true),
  dismissConfirm: () => undefined,
  cancel: () => undefined,
  dismissFailure: () => undefined,
  dismissError: () => undefined,
  reload: () => undefined,
  reloadTemplates: () => undefined,
  reloadRun: () => undefined,
};

function render(given: AiNotesState, suggested: string | null = null): string {
  return renderToStaticMarkup(
    createElement(
      CitationNavigatorProvider,
      null,
      createElement(AiNotesView, { meetingId: MEETING, state: given, actions: ACTIONS, suggested }),
    ),
  ).replaceAll('<!-- -->', '');
}

describe('AiNotesView', () => {
  it('offers Generate when there are no AI notes and nothing is pending', () => {
    const html = render(state());
    expect(html).toMatch(/^<div class="ai-notes">/);
    expect(html).toContain('No AI notes yet');
    expect(html).toContain('>Generate notes</button>');
    expect(html).not.toContain('data-editor');
  });

  it('shows the template picker the user opened, in place of the empty state', () => {
    const generate = render(state({ picker: 'generate' }), 'client_call');
    expect(generate).toContain('>Which kind of call was this?</p>');
    expect(generate).toContain('Roger writes the AI notes in the shape of the call.');
    expect(generate).toContain('Suggested');
    expect(generate).toContain('>Cancel</button>');
    expect(generate).not.toContain('No AI notes yet');

    const regenerate = render(state({ note: aiNote(), picker: 'regenerate' }));
    expect(regenerate).toContain('>Regenerate as which kind of call?</p>');
    expect(regenerate).toContain('Restore previous notes brings them back.');
  });

  it('asks which kind of call it was, with Not now', () => {
    const html = render(state({ pending: pending({ phase: 'needs_template' }) }), 'standup');
    expect(html).toContain('>Which kind of call was this?</p>');
    expect(html.match(/class="template-option[ "]/g)).toHaveLength(4);
    // Roger could not tell at Stop: the picker suggests nothing of its own here.
    expect(html).not.toContain('Suggested');
    expect(html).toContain('>Not now</button>');
    expect(html).not.toContain('No AI notes yet');
  });

  it('says what a pending generate waits for, with Cancel', () => {
    const html = render(
      state({ pending: pending({ phase: 'waiting_for_lines', waitingLines: 12 }) }),
    );
    // The line and the Cancel that ends its wait share the bar.
    expect(html).toContain(
      '<div class="ai-notes-bar"><div class="ai-notes-bar-text"><p class="ai-notes-progress" role="status">Notes will generate when 12 lines finish uploading.</p></div><div class="ai-notes-actions"><button type="button" class="note-button">Cancel</button></div></div>',
    );
    expect(html).not.toContain('Generate notes');
  });

  it("streams a run's lines over the hidden, read-only editor", () => {
    const html = render(
      state({ note: aiNote(), pending: pending({ phase: 'running' }), stream: LIVE }),
    );
    expect(html).toContain(
      '<p class="ai-notes-progress ai-notes-progress-running" role="status">Writing your notes...</p>',
    );
    expect(html).toContain('<div class="ai-notes-stream ai-notes-stream-live" aria-busy="true">');
    expect(html).toContain('<h2>Their goals</h2>');
    expect(html).toContain('<h2>Decisions</h2>');
    expect(html).toContain('<li><p>Finance needs BI exports before rollout ');
    expect(html).toContain('aria-label="Show the transcript at 03:12"');
    expect(html).toContain('class="citation-chip citation-chip-weak"');
    expect(html).toContain('<h2>From your notes</h2><p><em>Not said on the call</em></p>');
    expect(html).toContain('<li><p>Ask about the Q3 renewal date</p></li>');
    // The old notes stay mounted under the lines, so nothing typed is lost, and nobody types.
    expect(html).toContain(
      '<div class="ai-notes-editor" hidden=""><div data-editor="ai" data-label="AI notes" data-read-only="true"></div></div>',
    );
    expect(html).toContain('>Stop</button>');
    expect(html).toContain('Removed lines (1)');
    expect(html).not.toContain('Regenerate');
  });

  it('keeps the partial notes under the error banner, with Retry', () => {
    const failed: AiNotesStreamView = {
      ...LIVE,
      phase: 'failed',
      error: { code: 'llm_provider_error', message: 'Provider returned 503.' },
    };
    const html = render(
      state({
        stream: failed,
        pending: pending({
          phase: 'failed',
          code: 'llm_provider_error',
          message: 'Provider returned 503.',
        }),
      }),
    );
    expect(html).toMatch(
      /<div class="error ai-notes-failure" role="alert"><p class="ai-notes-failure-title">The AI service could not write the notes\.<\/p><p class="ai-notes-failure-detail">Provider returned 503\.<\/p>/,
    );
    expect(html).toContain('>Retry</button>');
    expect(html).toContain('>Dismiss</button>');
    expect(html).toContain('<div class="ai-notes-stream ai-notes-stream-partial">');
    expect(html).toContain('Written before the run stopped. Not saved.');
    expect(html).toContain('Finance needs BI exports before rollout');
  });

  it('offers Cancel, not Dismiss, for a failed generate main tries again by itself', () => {
    const html = render(
      state({
        pending: pending({
          phase: 'failed',
          code: 'internal_error',
          message: 'Roger could not generate the notes. It will try again.',
        }),
      }),
    );
    expect(html).toContain(
      '<p class="ai-notes-failure-title">Roger could not generate the notes.</p><p class="ai-notes-failure-detail">It will try again.</p>',
    );
    expect(html).toContain('>Retry</button>');
    expect(html).toContain('>Cancel</button>');
    expect(html).not.toContain('>Dismiss</button>');
  });

  it('shows a cancelled run as a notice, not an error', () => {
    const cancelled: AiNotesStreamView = {
      ...LIVE,
      phase: 'cancelled',
      error: { code: 'cancelled', message: 'Notes generation was cancelled.' },
    };
    const html = render(state({ note: aiNote(), stream: cancelled }));
    expect(html).toContain('<div class="notice ai-notes-failure" role="status">');
    expect(html).toContain('Notes generation was cancelled.');
    expect(html).not.toContain('Retry');
    expect(html).toContain('data-read-only="false"');
  });

  it('shows the saved notes with their template, lines to check, removed lines and actions', () => {
    const html = render(
      state({
        note: aiNote(),
        lastRun: { status: 'ready', runId: RUN, run: run() },
      }),
    );
    expect(html).toContain('<p class="ai-notes-meta">Client call template, 2 lines to check</p>');
    expect(html).toContain('>Regenerate</button>');
    expect(html).toContain('>Restore previous notes</button>');
    expect(html).toContain(
      '<div class="ai-notes-editor"><div data-editor="ai" data-label="AI notes" data-read-only="false"></div></div>',
    );
    expect(html).toContain('<summary>Removed lines (2)</summary>');
    expect(html).toContain(
      '<span class="ai-notes-removed-text">Everyone agreed it went well</span> <span class="ai-notes-removed-reason">(cited no transcript line)</span>',
    );
    expect(html).toContain('(cited lines that are not in the transcript)');
    expect(html).not.toContain('No AI notes yet');
  });

  it('says when the run behind the notes cannot be read, with Try again', () => {
    const html = render(
      state({
        note: aiNote(),
        lastRun: { status: 'failed', runId: RUN, error: 'Roger is offline' },
      }),
    );
    expect(html).toContain(
      'Roger could not read the run that wrote these notes (Roger is offline), so it cannot list the lines it removed.',
    );
    expect(html).toContain('>Try again</button>');
  });

  it('asks before replacing AI notes edited since their run', () => {
    const regenerate = render(
      state({
        note: aiNote({ dirty: true }),
        confirm: { action: 'regenerate', templateId: 'standup' },
      }),
    );
    expect(regenerate).toContain('Replace your edited AI notes?');
    expect(regenerate).toContain('Restore previous notes brings this version back');
    expect(regenerate).toContain('>Regenerate as Standup</button>');
    expect(regenerate).toContain('>Keep my edits</button>');

    const restore = render(
      state({ note: aiNote({ dirty: true }), confirm: { action: 'restore' } }),
    );
    expect(restore).toContain('Replace your edited AI notes with the previous version?');
    expect(restore).toContain('no run holds your edits');
    expect(restore).toContain('>Restore previous notes</button>');
  });

  it('says why it could not open, or why an action failed', () => {
    const failed = render(state({ status: 'failed', loadError: 'database closed' }));
    expect(failed).toContain('Roger could not open the AI notes: database closed');
    expect(failed).toContain('>Try again</button>');
    expect(render(state({ status: 'loading' }))).toContain('Opening the AI notes...');

    const refused = render(
      state({ note: aiNote(), actionError: 'Roger could not start the notes: busy' }),
    );
    expect(refused).toContain('<div class="error ai-notes-error" role="alert">');
    expect(refused).toContain('Roger could not start the notes: busy');
  });

  it('waits on Stop while main stops the run', () => {
    const html = render(
      state({ note: aiNote(), pending: pending({ phase: 'running' }), cancelling: true }),
    );
    expect(html).toMatch(
      /<button type="button" class="note-button" disabled="">Stopping\.\.\.<\/button>/,
    );
  });
});
