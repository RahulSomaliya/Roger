import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatStreamEvent, RefCitation } from '../../../shared/notes';
import {
  answerBlocks,
  type AnswerBlock,
  applyChatEvent,
  canRetry,
  type ChatAnswer,
  chipLabel,
  describeAnswerError,
  failedAnswer,
  isAnswering,
  storedAnswer,
  WAITING_ANSWER,
} from './chatStream';

const RUN = '0b7e4c1a-9d2f-4e83-a6c5-3f1d8b2e7a90';
const LINE_12 = 'fd9daa6d-24ad-4dec-8fca-01604dd531da';
const LINE_13 = '2a6c9e14-7b3d-4f58-9c0e-1d4b7a2f6e83';
const LINE_3 = '9e3b5d71-0c4a-4b2e-8f69-7a1c3e5d9b24';

const cite = (ref: string, segmentId: string, startMs: number): RefCitation => ({
  ref,
  segmentId,
  startMs,
});

const L12 = cite('L12', LINE_12, 192_000);
const L13 = cite('L13', LINE_13, 199_500);
const L3 = cite('L3', LINE_3, 42_000);

function play(...events: ChatStreamEvent[]): ChatAnswer {
  return events.reduce(applyChatEvent, WAITING_ANSWER);
}

const run: ChatStreamEvent = { type: 'run', runId: RUN, model: 'xiaomi/mimo-v2.6-pro' };
const delta = (text: string): ChatStreamEvent => ({ type: 'delta', text });
const citation = (ref: RefCitation): ChatStreamEvent => ({ type: 'citation', ...ref });

function answerMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: '6f2d8a35-1c7e-4b90-9a4d-5e3f2b1c8d07',
    role: 'assistant',
    text: 'Legal reviews the renewal on Friday [L12, L13].',
    citations: [L12, L13],
    replyTo: '4c8e2b6f-3a1d-4e75-b9c0-8d2f6a4e1b39',
    runId: RUN,
    status: 'complete',
    createdAt: '2026-10-07T09:31:12.000Z',
    ...overrides,
  };
}

/** A block's parts as one line: chips as `<label: segment ids>`. */
function flat(blocks: readonly AnswerBlock[]): string[] {
  return blocks.map(
    (block) =>
      `${block.kind}: ` +
      block.parts
        .map((part) =>
          part.kind === 'text'
            ? part.text
            : `<${part.citation.label}: ${part.citation.segmentIds.join(' ')}>`,
        )
        .join(''),
  );
}

const shown = (answer: ChatAnswer): string[] => flat(answerBlocks(answer.text, answer.citations));

describe('chatStream', () => {
  it('deltas append and citation events turn refs into chips', () => {
    const before = play(run, delta('Legal reviews the renewal on Friday [L1'), delta('2].'));
    expect(before.phase).toBe('streaming');
    expect(before.runId).toBe(RUN);
    expect(before.text).toBe('Legal reviews the renewal on Friday [L12].');
    // The bracket closed, but the API has not mapped the ref yet: it is text.
    expect(shown(before)).toEqual(['paragraph: Legal reviews the renewal on Friday [L12].']);

    const after = applyChatEvent(before, citation(L12));
    expect(after.citations).toEqual([L12]);
    expect(shown(after)).toEqual([
      `paragraph: Legal reviews the renewal on Friday <03:12: ${LINE_12}>.`,
    ]);
    const chip = answerBlocks(after.text, after.citations)[0]?.parts[1];
    expect(chip).toEqual({
      kind: 'chip',
      refs: ['L12'],
      citation: { segmentIds: [LINE_12], startMs: 192_000, label: '03:12', support: 'ok' },
    });
  });

  it('unknown refs stay text until done', () => {
    const streaming = play(
      run,
      delta('The budget is 50k [L3, N2], owner unclear [L99]. Legal on Friday [L12-L13].'),
      citation(L3),
      citation(L12),
    );
    // N2 and L99 never get a citation; L13 has none yet. A group shows what is mapped as one chip,
    // and keeps the rest as text.
    expect(shown(streaming)).toEqual([
      `paragraph: The budget is 50k <00:42: ${LINE_3}> [N2], owner unclear [L99]. Legal on Friday <03:12: ${LINE_12}> [L13].`,
    ]);

    // `done`'s text replaces the streamed text: the API took the unmapped refs out.
    const done = applyChatEvent(streaming, {
      type: 'done',
      message: answerMessage({
        text: 'The budget is 50k [L3], owner unclear. Legal on Friday [L12, L13].',
        citations: [L3, L12, L13],
      }),
    });
    expect(done.phase).toBe('complete');
    expect(done.error).toBeNull();
    expect(shown(done)).toEqual([
      `paragraph: The budget is 50k <00:42: ${LINE_3}>, owner unclear. Legal on Friday <03:12: ${LINE_12} ${LINE_13}>.`,
    ]);
  });

  it('an error keeps the partial answer and offers retry', () => {
    const failed = play(
      run,
      delta('The quote is twelve percent off for two years [L12]'),
      citation(L12),
      delta(', and fifteen'),
      { type: 'error', code: 'llm_provider_error', message: 'The model provider failed.' },
    );
    expect(failed.phase).toBe('failed');
    expect(failed.text).toBe('The quote is twelve percent off for two years [L12], and fifteen');
    expect(shown(failed)).toEqual([
      `paragraph: The quote is twelve percent off for two years <03:12: ${LINE_12}>, and fifteen`,
    ]);
    expect(failed.error).toEqual({
      code: 'llm_provider_error',
      message: 'The model provider failed.',
    });
    expect(isAnswering(failed)).toBe(false);
    expect(canRetry(failed)).toBe(true);
    expect(describeAnswerError(failed.error ?? { code: '', message: '' })).toBe(
      'The AI service did not answer. Try again in a moment.',
    );

    // Asking again cannot help a meeting over the chat budget.
    const tooLong = play({
      type: 'error',
      code: 'meeting_too_long',
      message: 'Meeting is over the chat budget',
    });
    expect(canRetry(tooLong)).toBe(false);
  });

  it('a new run starts the answer over: a retry or an attach replays it from the start', () => {
    const failed = play(run, delta('Half an ans'), {
      type: 'error',
      code: 'network_error',
      message: 'POST /v1/meetings/x/chat stream failed: socket hang up',
    });
    expect(failed.text).toBe('Half an ans');
    const retried: ChatStreamEvent[] = [
      { type: 'run', runId: '7d1f3b9e-2c4a-4e68-8b05-6a9c2e4f1d73', model: 'm' },
      delta('Whole'),
    ];
    const again = retried.reduce(applyChatEvent, failed);
    expect(again).toEqual({
      phase: 'streaming',
      runId: '7d1f3b9e-2c4a-4e68-8b05-6a9c2e4f1d73',
      text: 'Whole',
      citations: [],
      error: null,
    });
  });

  it('a citation counts once per ref, as the API sends it', () => {
    const answer = play(run, delta('[L12] and [L12]'), citation(L12), citation(L12));
    expect(answer.citations).toEqual([L12]);
  });

  it('a replayed complete answer is done alone, with no run event', () => {
    const replayed = play({ type: 'done', message: answerMessage() });
    expect(replayed.phase).toBe('complete');
    expect(replayed.runId).toBe(RUN);
    expect(shown(replayed)).toEqual([
      `paragraph: Legal reviews the renewal on Friday <03:12: ${LINE_12} ${LINE_13}>.`,
    ]);
  });

  it('a cancelled answer keeps what came and says so', () => {
    const cancelled = play(run, delta('So far'), {
      type: 'error',
      code: 'cancelled',
      message: 'The answer was cancelled.',
    });
    expect(cancelled.phase).toBe('failed');
    expect(cancelled.text).toBe('So far');
    expect(describeAnswerError(cancelled.error ?? { code: '', message: '' })).toBe(
      'You stopped this answer.',
    );
    expect(canRetry(cancelled)).toBe(true);
  });

  it('waits, then streams, while the answer is on its way', () => {
    expect(isAnswering(WAITING_ANSWER)).toBe(true);
    expect(WAITING_ANSWER.phase).toBe('waiting');
    expect(isAnswering(play(run))).toBe(true);
    expect(isAnswering(play({ type: 'done', message: answerMessage() }))).toBe(false);
  });
});

describe('storedAnswer', () => {
  it('reads a complete, a streaming and a failed answer from the thread', () => {
    expect(storedAnswer(answerMessage())).toEqual({
      phase: 'complete',
      runId: RUN,
      text: 'Legal reviews the renewal on Friday [L12, L13].',
      citations: [L12, L13],
      error: null,
    });
    expect(
      storedAnswer(answerMessage({ status: 'streaming', text: '', citations: [] })),
    ).toMatchObject({ phase: 'streaming', text: '' });
    const failed = storedAnswer(answerMessage({ status: 'failed', text: '', citations: [] }));
    expect(failed.phase).toBe('failed');
    expect(canRetry(failed)).toBe(true);
    expect(describeAnswerError(failed.error ?? { code: '', message: '' })).toBe(
      'This answer did not finish.',
    );
  });
});

describe('failedAnswer', () => {
  it('keeps the text so far and names why', () => {
    const answer = failedAnswer(play(run, delta('Partial')), {
      code: 'not_sent',
      message: "Error invoking remote method 'chat:send': Error: the API is away",
    });
    expect(answer).toMatchObject({ phase: 'failed', text: 'Partial', runId: RUN });
    expect(answer.error).toEqual({
      code: 'not_sent',
      message: "Error invoking remote method 'chat:send': Error: the API is away",
    });
  });
});

describe('describeAnswerError', () => {
  it('says what a person can do for each code, and passes other messages on', () => {
    const say = (code: string, message = 'API text'): string =>
      describeAnswerError({ code, message });
    expect(say('network_error')).toBe(
      'Roger could not reach the server. Check the connection and try again.',
    );
    expect(say('meeting_too_long')).toBe(
      'This meeting is too long to chat with: over about 10 hours of talk.',
    );
    expect(say('not_found')).toBe(
      'This meeting is not on the server yet. Ask again once its transcript has uploaded.',
    );
    expect(say('not_sent', 'the API is away')).toBe(
      'Roger could not send this question: the API is away',
    );
    // Main's words while an earlier try's stream is still closing: no message id for people.
    expect(
      say(
        'not_sent',
        'the answer to message 4c8e2b6f-3a1d-4e75-b9c0-8d2f6a4e1b39 is already on its way',
      ),
    ).toBe('The last try is still closing. Try again in a moment.');
    expect(say('internal_error', 'The answer could not be saved.')).toBe(
      'The answer could not be saved.',
    );
  });
});

describe('answerBlocks', () => {
  const cited = [L3, L12, L13];

  it('splits lines into paragraphs and bullet and numbered items', () => {
    const text = [
      'Three things were agreed:',
      '',
      '- Legal reviews on Friday [L12]',
      '* Budget stays at 50k [L3]',
      '1. Send the quote [L13]',
      '2) Book the demo',
      'That is all.',
    ].join('\n');
    expect(flat(answerBlocks(text, cited))).toEqual([
      'paragraph: Three things were agreed:',
      `bullet: Legal reviews on Friday <03:12: ${LINE_12}>`,
      `bullet: Budget stays at 50k <00:42: ${LINE_3}>`,
      `numbered: Send the quote <03:19: ${LINE_13}>`,
      'numbered: Book the demo',
      'paragraph: That is all.',
    ]);
  });

  it('reads the ref groups the API reads: wrapped, ranged, any case, and a dash', () => {
    const text = 'A [[L12]] B ([L3], [L13]) C [l12 - l13] D [L12\u2013L13; L3]';
    expect(flat(answerBlocks(text, cited))).toEqual([
      `paragraph: A <03:12: ${LINE_12}> B <00:42: ${LINE_3} ${LINE_13}> C <03:12: ${LINE_12} ${LINE_13}> D <00:42: ${LINE_12} ${LINE_13} ${LINE_3}>`,
    ]);
  });

  it('leaves brackets that are not ref groups as text', () => {
    const text = 'See [the doc] and [L12 maybe] or [12] and an open [L1';
    expect(flat(answerBlocks(text, cited))).toEqual([`paragraph: ${text}`]);
  });

  it('expands a range only as far as the API cites, eight refs a group', () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      cite(`L${index + 1}`, `00000000-0000-4000-8000-00000000000${index}`, index * 1000),
    );
    const [part] = answerBlocks('[L1-L999999]', many)[0]?.parts ?? [];
    expect(part?.kind === 'chip' ? part.refs : null).toEqual([
      'L1',
      'L2',
      'L3',
      'L4',
      'L5',
      'L6',
      'L7',
      'L8',
    ]);
  });

  it('dates a chip from the earliest of its lines', () => {
    const [, chip] = answerBlocks('Friday [L13, L12]', cited)[0]?.parts ?? [];
    expect(chip).toEqual({
      kind: 'chip',
      refs: ['L13', 'L12'],
      citation: {
        segmentIds: [LINE_13, LINE_12],
        startMs: 192_000,
        label: '03:12',
        support: 'ok',
      },
    });
  });

  it('gives no block for empty text', () => {
    expect(answerBlocks('', cited)).toEqual([]);
    expect(answerBlocks('\n \n', cited)).toEqual([]);
  });
});

describe('chipLabel', () => {
  it('writes minutes and seconds, and hours past the first', () => {
    expect(chipLabel(0)).toBe('00:00');
    expect(chipLabel(192_400)).toBe('03:12');
    expect(chipLabel(3_599_999)).toBe('59:59');
    expect(chipLabel(3_725_000)).toBe('1:02:05');
  });
});
