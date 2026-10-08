import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  LlmRun,
  LocalNote,
  NoteDoc,
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
    templateId: 'client_call',
    reason: 'button',
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
    templates: { status: 'ready', value: [] },
    confirm: null,
    busy: null,
    cancelling: false,
    actionError: null,
    ...overrides,
  };
}

const ACTIONS: AiNotesPanelActions = {
  generate: () => Promise.resolve(true),
  cancel: () => undefined,
  dismissFailure: () => undefined,
  dismissError: () => undefined,
  reload: () => undefined,
  reloadRun: () => undefined,
};

function render(given: AiNotesState): string {
  return renderToStaticMarkup(
    createElement(
      CitationNavigatorProvider,
      null,
      createElement(AiNotesView, { meetingId: MEETING, state: given, actions: ACTIONS }),
    ),
  ).replaceAll('<!-- -->', '');
}

describe('AiNotesView', () => {
  it('has no empty state and no action of its own to start notes: the header owns Write notes', () => {
    // The tab exists only once notes exist, a generate is pending or a run failed
    // (aiNotesTabExists); a stand-in for the state before that draws nothing.
    const html = render(state());
    expect(html).toBe('<div class="ai-notes"></div>');
    for (const gone of [
      'No AI notes yet',
      'Generate notes',
      'Which kind of call',
      'template-picker',
      'Regenerate',
      'Restore previous notes',
      'ai-notes-bar',
      'ai-notes-meta',
      'empty-state',
    ]) {
      expect(html, gone).not.toContain(gone);
    }
  });

  it('says nothing while main answers, and why it could not open when it did not', () => {
    expect(render(state({ status: 'loading' }))).toBe(
      '<div class="ai-notes" aria-busy="true"></div>',
    );

    const failed = render(state({ status: 'failed', loadError: 'database closed' }));
    expect(failed).toMatch(/<div class="problem" role="alert"><svg/);
    expect(failed).toContain('Roger could not open the AI notes: database closed');
    expect(failed).toContain('>Try again</button>');
  });

  it('says what a pending generate waits for, and leaves Cancel to the header', () => {
    const html = render(
      state({ pending: pending({ phase: 'waiting_for_lines', waitingLines: 12 }) }),
    );
    expect(html).toContain(
      '<p class="ai-notes-waiting" role="status">Roger will write the notes when 12 lines finish uploading.</p>',
    );
    expect(html).not.toContain('Cancel');
    expect(html).not.toContain('Stop');
  });

  it("streams a run's lines over the hidden, read-only editor, and says nothing of the run itself", () => {
    const html = render(
      state({ note: aiNote(), pending: pending({ phase: 'running' }), stream: LIVE }),
    );
    // "Writing notes…" is the header's button; saying it here too would say it twice.
    expect(html).not.toContain('Writing notes');
    expect(html).not.toContain('ai-notes-waiting');
    expect(html).toContain('<div class="ai-notes-stream ai-notes-stream-live" aria-busy="true">');
    expect(html).toContain('<h2>Their goals</h2>');
    expect(html).toContain('<h2>Decisions</h2>');
    expect(html).toContain('<li><p>Finance needs BI exports before rollout ');
    expect(html).toContain('aria-label="Show the transcript at 03:12"');
    // A flagged line marks itself with the word "check", on the shared chip.
    expect(html).toContain('<span class="chip-flag">check</span>');
    expect(html).toContain('<h2>From your notes</h2><p><em>Not said on the call</em></p>');
    expect(html).toContain('<li><p>Ask about the Q3 renewal date</p></li>');
    // The old notes stay mounted under the lines, so nothing typed is lost, and nobody types.
    expect(html).toContain(
      '<div class="ai-notes-editor" hidden=""><div data-editor="ai" data-label="AI notes" data-read-only="true"></div></div>',
    );
    expect(html).not.toContain('>Stop</button>');
    expect(html).toContain('1 line left out');
  });

  it('keeps the partial notes under the problem line, with Try again', () => {
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
    // An icon and words, never a red or tinted box (docs/design.md, Problem line).
    expect(html).toMatch(
      /<div class="problem ai-notes-failure" role="alert"><svg[^>]*><[^]*<\/svg><div class="problem-text"><p class="ai-notes-failure-title">The AI service could not write the notes\.<\/p><details class="ai-notes-failure-details"><summary>Details<\/summary><p class="ai-notes-failure-detail">Provider returned 503\.<\/p><\/details>/,
    );
    expect(html).not.toMatch(/class="(?:[^"]* )?(?:error|notice)[" ]/);
    expect(html).toMatch(/data-variant="secondary" data-size="sm">Try again<\/button>/);
    expect(html).not.toContain('>Retry<');
    expect(html).toMatch(/data-variant="ghost" data-size="sm">Dismiss<\/button>/);
    expect(html).not.toContain('data-variant="primary"');
    expect(html).toContain('<div class="ai-notes-stream ai-notes-stream-partial">');
    expect(html).toContain('Written before the run stopped. Not saved.');
    expect(html).toContain('Finance needs BI exports before rollout');
  });

  it('shows Try again as busy, not disabled, while it starts', () => {
    const html = render(
      state({
        busy: 'generate',
        pending: pending({ phase: 'failed', code: 'llm_provider_error', message: 'x' }),
      }),
    );
    expect(html).toMatch(/aria-disabled="true">Trying again…<\/button>/);
    expect(html).not.toContain(' disabled=');
  });

  it('offers Cancel, not Dismiss, for a failed generate main tries again by itself', () => {
    const html = render(
      state({
        pending: pending({
          phase: 'failed',
          code: 'internal_error',
          message: 'Roger could not write the notes. It will try again.',
        }),
      }),
    );
    expect(html).toContain(
      '<p class="ai-notes-failure-title">Roger could not write the notes.</p><details class="ai-notes-failure-details"><summary>Details</summary><p class="ai-notes-failure-detail">It will try again.</p></details>',
    );
    expect(html).toContain('>Try again</button>');
    expect(html).toContain('>Cancel</button>');
    expect(html).not.toContain('>Dismiss</button>');
  });

  it('shows a cancelled run as a quiet line, not a problem', () => {
    const cancelled: AiNotesStreamView = {
      ...LIVE,
      phase: 'cancelled',
      error: { code: 'cancelled', message: 'Writing the notes was cancelled.' },
    };
    const html = render(state({ note: aiNote(), stream: cancelled }));
    expect(html).toContain('<div class="problem ai-notes-failure" role="status">');
    expect(html).toContain('Writing the notes was cancelled.');
    expect(html).not.toContain('Try again');
    expect(html).toContain('data-read-only="false"');
  });

  it('shows the saved notes and the lines left out, closed, with no meta line or action bar', () => {
    const html = render(
      state({
        note: aiNote(),
        lastRun: { status: 'ready', runId: RUN, run: run() },
      }),
    );
    expect(html).toContain(
      '<div class="ai-notes-editor"><div data-editor="ai" data-label="AI notes" data-read-only="false"></div></div>',
    );
    expect(html).toContain('<summary>2 lines left out</summary>');
    // The closed disclosure holds the list, not an intro paragraph.
    expect(html).not.toContain('Every AI line links');
    expect(html).toContain(
      '<span class="ai-notes-removed-text">Everyone agreed it went well</span> <span class="ai-notes-removed-reason">(cited no transcript line)</span>',
    );
    expect(html).toContain('(cited lines that are not in the transcript)');
    // The menu names the template and a flagged line marks itself: no "template, 2 lines to check".
    expect(html).not.toContain('template');
    expect(html).not.toContain('to check');
    expect(html).not.toContain('<details open');
  });

  it('says when the run behind the notes cannot be read, with Try again', () => {
    const html = render(
      state({
        note: aiNote(),
        lastRun: { status: 'failed', runId: RUN, error: 'Roger is offline' },
      }),
    );
    expect(html).toContain(
      'Roger could not read the run that wrote these notes (Roger is offline), so it cannot list the lines it left out.',
    );
    expect(html).toContain('>Try again</button>');
  });

  it('draws no question over edited notes: the header asks (ReplaceNotesDialog)', () => {
    const html = render(
      state({
        note: aiNote({ dirty: true }),
        confirm: { action: 'regenerate', templateId: 'standup' },
      }),
    );
    expect(html).not.toContain('Replace your edited AI notes');
    expect(html).not.toContain('Keep my edits');
  });

  it("shows why Try again or Cancel failed, as a problem line: the header's session cannot see it", () => {
    const refused = render(
      state({ note: aiNote(), actionError: 'Roger could not start writing the notes: busy' }),
    );
    expect(refused).toMatch(/<div class="problem" role="alert"><svg/);
    expect(refused).toContain('Roger could not start writing the notes: busy');
    expect(refused).toContain('>Dismiss</button>');
    expect(refused).not.toContain('class="error');
  });
});
