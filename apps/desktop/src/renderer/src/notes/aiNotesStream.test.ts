import { describe, expect, it } from 'vitest';
import type { NotesStreamMessage } from '../../../shared/ipc/notes';
import type {
  LocalNote,
  Note,
  NotesStreamEvent,
  PendingGenerateState,
  RefCitation,
} from '../../../shared/notes';
import {
  afterNoteChanged,
  afterPendingChanged,
  type AiNotesStreamView,
  applyNotesEvent,
  chipLabel,
  chipsFor,
  shownStream,
} from './aiNotesStream';

const MEETING = '5c1d7a4e-2f3b-4c8a-9e61-0d2b7f4a9c13';
const RUN = '6a0d6a52-6f0c-4c35-9d0e-1c8f7f0f8a11';
const OTHER_RUN = '0b7c3f1e-9a2d-4e5f-8c61-3d4e5f6a7b8c';

const segment = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cite = (line: number, seconds: number): RefCitation => ({
  ref: `L${String(line)}`,
  segmentId: segment(line),
  startMs: seconds * 1000,
});

function message(event: NotesStreamEvent, runId = RUN): NotesStreamMessage {
  return { meetingId: MEETING, runId, event };
}

/** Folds the events into a view, as the panel does one event at a time. */
function play(
  events: readonly (NotesStreamEvent | NotesStreamMessage)[],
  from: AiNotesStreamView | null = null,
): AiNotesStreamView | null {
  return events.reduce<AiNotesStreamView | null>(
    (view, next) => applyNotesEvent(view, 'event' in next ? next : message(next)),
    from,
  );
}

const RUN_EVENT: NotesStreamEvent = {
  type: 'run',
  runId: RUN,
  model: 'xiaomi/mimo-v2.6-pro',
  templateId: 'client_call',
  lineCount: 412,
};

const SAVED: Note = {
  kind: 'ai',
  doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] },
  version: 3,
  templateId: 'client_call',
  lastRunId: RUN,
  generatedVersion: 3,
  updatedAt: '2026-10-06T11:12:00.000Z',
};

function localAi(overrides: Partial<LocalNote> = {}): LocalNote {
  return {
    meetingId: MEETING,
    kind: 'ai',
    doc: SAVED.doc,
    revisionId: null,
    dirty: false,
    baseVersion: 3,
    templateId: 'client_call',
    lastRunId: RUN,
    generatedVersion: 3,
    conflictCopy: null,
    sync: 'synced',
    updatedAt: '2026-10-06T11:12:00.000Z',
    ...overrides,
  };
}

function pending(overrides: Partial<PendingGenerateState> = {}): PendingGenerateState {
  return {
    meetingId: MEETING,
    runId: RUN,
    templateId: 'client_call',
    reason: 'after_stop',
    createdAt: '2026-10-06T11:10:00.000Z',
    status: { phase: 'running' },
    ...overrides,
  };
}

describe('applyNotesEvent', () => {
  it('builds sections and items in order', () => {
    const view = play([
      RUN_EVENT,
      { type: 'section', index: 0, heading: 'Their goals' },
      {
        type: 'item',
        section: 0,
        text: 'Finance needs BI exports before rollout',
        citations: [cite(12, 192), cite(13, 197), cite(15, 214)],
        support: 'ok',
      },
      { type: 'section', index: 1, heading: 'Decisions' },
      {
        type: 'item',
        section: 1,
        text: 'Year-one price stays at $50k',
        citations: [cite(40, 1730)],
        support: 'weak',
      },
      // A late line for the first section lands under it, not under the newest heading.
      {
        type: 'item',
        section: 0,
        text: 'Search is slow on long calls',
        citations: [cite(58, 3725)],
        support: 'ok',
      },
      // A section the model added after the template's: its index skips a number.
      { type: 'section', index: 4, heading: 'Risks' },
    ]);

    expect(view?.phase).toBe('streaming');
    expect(view?.runId).toBe(RUN);
    expect(view?.templateId).toBe('client_call');
    expect(view?.sections.map(({ index, heading }) => [index, heading])).toEqual([
      [0, 'Their goals'],
      [1, 'Decisions'],
      [4, 'Risks'],
    ]);
    expect(view?.sections[0]?.items.map((item) => item.text)).toEqual([
      'Finance needs BI exports before rollout',
      'Search is slow on long calls',
    ]);
    // L12 and L13 are neighbours, so one chip reveals both, as the saved doc groups them.
    expect(view?.sections[0]?.items[0]?.chips).toEqual([
      { segmentIds: [segment(12), segment(13)], startMs: 192_000, label: '03:12', support: 'ok' },
      { segmentIds: [segment(15)], startMs: 214_000, label: '03:34', support: 'ok' },
    ]);
    expect(view?.sections[1]?.items[0]?.chips).toEqual([
      { segmentIds: [segment(40)], startMs: 1_730_000, label: '28:50', support: 'weak' },
    ]);
    expect(view?.sections[2]?.items).toEqual([]);
    expect(shownStream(view ?? null)).toBe('live');
  });

  it('from_notes events build the closing list', () => {
    const view = play([
      RUN_EVENT,
      { type: 'section', index: 0, heading: 'Summary' },
      { type: 'from_notes', text: 'Ask about the Q3 renewal date' },
      { type: 'from_notes', text: 'Check the travel budget for November' },
    ]);
    expect(view?.fromNotes).toEqual([
      'Ask about the Q3 renewal date',
      'Check the travel budget for November',
    ]);
    // They are not lines of any section: no chips, their own list.
    expect(view?.sections[0]?.items).toEqual([]);
  });

  it('keeps the removed lines with their reason codes', () => {
    const view = play([
      RUN_EVENT,
      { type: 'dropped', text: 'Everyone agreed it went well', reason: 'no_refs' },
      { type: 'dropped', text: 'Budget is $2m', reason: 'unknown_refs' },
    ]);
    expect(view?.dropped).toEqual([
      { text: 'Everyone agreed it went well', reason: 'no_refs' },
      { text: 'Budget is $2m', reason: 'unknown_refs' },
    ]);
  });

  it('keeps partial notes with a banner after an error', () => {
    const view = play([
      RUN_EVENT,
      { type: 'section', index: 0, heading: 'Summary' },
      {
        type: 'item',
        section: 0,
        text: 'Pilot usage is strong in support',
        citations: [cite(41, 612)],
        support: 'ok',
      },
      { type: 'error', code: 'llm_provider_error', message: 'The model provider failed.' },
    ]);
    expect(view?.phase).toBe('failed');
    expect(view?.error).toEqual({
      code: 'llm_provider_error',
      message: 'The model provider failed.',
    });
    expect(view?.sections[0]?.items.map((item) => item.text)).toEqual([
      'Pilot usage is strong in support',
    ]);
    expect(shownStream(view ?? null)).toBe('partial');
  });

  it('done replaces the stream view with the saved doc', () => {
    const view = play([
      RUN_EVENT,
      { type: 'section', index: 0, heading: 'Summary' },
      {
        type: 'item',
        section: 0,
        text: 'Pilot usage is strong in support',
        citations: [cite(41, 612)],
        support: 'ok',
      },
      { type: 'from_notes', text: 'Ask about the Q3 renewal date' },
      { type: 'done', runId: RUN, note: SAVED },
    ]);
    expect(view?.phase).toBe('done');
    expect(view?.saved).toEqual(SAVED);
    expect(view?.sections).toEqual([]);
    expect(view?.fromNotes).toEqual([]);
    expect(shownStream(view ?? null)).toBeNull();
  });

  it('a cancelled run ends as cancelled, with no lines to keep', () => {
    const view = play([
      RUN_EVENT,
      { type: 'error', code: 'cancelled', message: 'Notes generation was cancelled.' },
    ]);
    expect(view?.phase).toBe('cancelled');
    expect(shownStream(view ?? null)).toBeNull();
  });

  it('takes one terminal event per run: a later one changes nothing', () => {
    // After a cancel the run may still be polled and found failed; the page heard `cancelled`.
    const cancelled = play([
      RUN_EVENT,
      { type: 'error', code: 'cancelled', message: 'Notes generation was cancelled.' },
    ]);
    const after = play(
      [
        { type: 'error', code: 'internal_error', message: 'Failed.' },
        { type: 'item', section: 0, text: 'late', citations: [], support: 'ok' },
        { type: 'done', runId: RUN, note: SAVED },
      ],
      cancelled,
    );
    expect(after).toBe(cancelled);
  });

  it("starts over on a run event: a stale-version retry's conflict error does not stay", () => {
    const conflict = play([
      { type: 'error', code: 'conflict', message: 'The notes changed; pull and retry.' },
    ]);
    expect(conflict?.phase).toBe('failed');
    const retried = play([RUN_EVENT, { type: 'section', index: 0, heading: 'Summary' }], conflict);
    expect(retried?.phase).toBe('streaming');
    expect(retried?.error).toBeNull();
    expect(retried?.sections.map((section) => section.heading)).toEqual(['Summary']);
  });

  it('shows no partial lines of a run it joined midway', () => {
    // The panel opened while a run streamed: without its run and section events, its lines would
    // show under no heading. The pending generate says "Writing your notes" until it ends.
    const view = play([
      { type: 'item', section: 0, text: 'Pilot usage', citations: [cite(41, 612)], support: 'ok' },
      { type: 'from_notes', text: 'Ask about Q3' },
    ]);
    expect(view).toBeNull();
    // Its end still counts: an error is shown, a done is the saved doc.
    expect(play([{ type: 'error', code: 'cut_off', message: 'Cut off.' }])?.phase).toBe('failed');
    expect(play([{ type: 'done', runId: RUN, note: SAVED }])?.phase).toBe('done');
  });

  it('a run event of another run replaces the view', () => {
    const first = play([RUN_EVENT, { type: 'section', index: 0, heading: 'Summary' }]);
    const second = play([message({ ...RUN_EVENT, runId: OTHER_RUN }, OTHER_RUN)], first);
    expect(second?.runId).toBe(OTHER_RUN);
    expect(second?.sections).toEqual([]);
    // An item of the old run after that is not this view's.
    expect(
      play(
        [message({ type: 'item', section: 0, text: 'x', citations: [], support: 'ok' })],
        second,
      ),
    ).toBe(second);
  });
});

describe('afterNoteChanged', () => {
  it("ends the view once the run's notes are saved, also after a cancel the run beat", () => {
    // cancel_unconfirmed: the page heard `cancelled`, then main loaded what the run saved.
    const cancelled = play([
      RUN_EVENT,
      { type: 'error', code: 'cancelled', message: 'Notes generation was cancelled.' },
    ]);
    expect(afterNoteChanged(cancelled, localAi())).toBeNull();
    const streaming = play([RUN_EVENT]);
    expect(afterNoteChanged(streaming, localAi())).toBeNull();
  });

  it('keeps the view for a note another run wrote, or the user', () => {
    const failed = play([RUN_EVENT, { type: 'error', code: 'cut_off', message: 'Cut off.' }]);
    expect(afterNoteChanged(failed, localAi({ lastRunId: OTHER_RUN }))).toBe(failed);
    expect(afterNoteChanged(failed, localAi({ lastRunId: null }))).toBe(failed);
    expect(afterNoteChanged(null, localAi())).toBeNull();
  });
});

describe('afterPendingChanged', () => {
  it('ends a streaming view when its generate is gone (a lost stream that finished)', () => {
    const streaming = play([RUN_EVENT, { type: 'section', index: 0, heading: 'Summary' }]);
    expect(afterPendingChanged(streaming, null)).toBeNull();
    expect(afterPendingChanged(streaming, pending())).toBe(streaming);
  });

  it('keeps an error banner when the generate ends, and drops it for a new generate', () => {
    const failed = play([RUN_EVENT, { type: 'error', code: 'cut_off', message: 'Cut off.' }]);
    expect(afterPendingChanged(failed, null)).toBe(failed);
    expect(
      afterPendingChanged(
        failed,
        pending({ status: { phase: 'failed', code: 'cut_off', message: 'x' } }),
      ),
    ).toBe(failed);
    // Retry after a failed run takes a new run id.
    expect(afterPendingChanged(failed, pending({ runId: OTHER_RUN }))).toBeNull();
  });

  it('drops a done view with its generate', () => {
    const done = play([RUN_EVENT, { type: 'done', runId: RUN, note: SAVED }]);
    expect(afterPendingChanged(done, null)).toBeNull();
  });

  it('ends a streaming view when its generate is no longer running', () => {
    // A lost stream: main polled the run for 2 minutes, could not reach the API, and the same
    // generate now waits offline. No event of the run comes until the next attempt's `run`.
    const streaming = play([
      RUN_EVENT,
      { type: 'section', index: 0, heading: 'Summary' },
      { type: 'item', section: 0, text: 'Pilot went well', citations: [], support: 'ok' },
    ]);
    expect(
      afterPendingChanged(
        streaming,
        pending({ status: { phase: 'waiting_for_notes', cause: 'offline' } }),
      ),
    ).toBeNull();
    expect(
      afterPendingChanged(
        streaming,
        pending({ status: { phase: 'waiting_for_lines', waitingLines: 3 } }),
      ),
    ).toBeNull();
    // main's own local failure sends no `error` event: its banner comes from the pending generate.
    expect(
      afterPendingChanged(
        streaming,
        pending({
          status: {
            phase: 'failed',
            code: 'internal_error',
            message: 'Roger could not generate the notes. It will try again.',
          },
        }),
      ),
    ).toBeNull();
    // The next attempt re-sends the run id, and its `run` event starts the view again.
    expect(play([RUN_EVENT])?.phase).toBe('streaming');
  });
});

describe('chips', () => {
  it('labels a chip as the API does: mm:ss, or h:mm:ss past an hour', () => {
    expect(chipLabel(0)).toBe('00:00');
    expect(chipLabel(192_000)).toBe('03:12');
    expect(chipLabel(3_599_999)).toBe('59:59');
    expect(chipLabel(3_725_000)).toBe('1:02:05');
  });

  it('groups only neighbouring lines, in the order cited', () => {
    expect(
      chipsFor([cite(7, 10), cite(8, 12), cite(9, 15), cite(30, 100), cite(31, 104)], 'ok').map(
        (chip) => chip.segmentIds.length,
      ),
    ).toEqual([3, 2]);
    expect(chipsFor([], 'ok')).toEqual([]);
    // A ref the API sent in another shape stands alone.
    expect(
      chipsFor(
        [
          { ref: 'L4', segmentId: segment(4), startMs: 1000 },
          { ref: 'X5', segmentId: segment(5), startMs: 2000 },
        ],
        'ok',
      ),
    ).toHaveLength(2);
  });
});
