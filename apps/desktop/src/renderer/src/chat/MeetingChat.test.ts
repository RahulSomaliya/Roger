import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MAX_CHAT_TEXT_CHARS, type RefCitation } from '../../../shared/notes';
import { CitationNavigatorProvider } from '../transcript/transcriptNavigator';
import { type ChatAnswer, NO_ANSWER, WAITING_ANSWER } from './chatStream';
import { type ChatActions, ChatPanel, draftCount } from './MeetingChat';
import type { ChatExchange, MeetingChatState } from './useMeetingChat';

const Q1 = '11111111-1111-4111-8111-111111111111';
const L6: RefCitation = {
  ref: 'L6',
  segmentId: 'c3f2e5a4-7d9f-4a3b-8e8c-4f6b8d0a2c33',
  startMs: 34_700,
};
const L17: RefCitation = {
  ref: 'L17',
  segmentId: 'e5b4a7c6-9f1b-4c5d-8a0e-6b8d0f2c4e55',
  startMs: 107_000,
};

const NO_ACTIONS: ChatActions = {
  ask: () => false,
  retry: () => undefined,
  cancel: () => undefined,
  reload: () => undefined,
};

function state(overrides: Partial<MeetingChatState> = {}): MeetingChatState {
  return {
    status: 'ready',
    error: null,
    exchanges: [],
    answering: false,
    notice: null,
    ...overrides,
  };
}

function exchange(answer: ChatAnswer, live = true): ChatExchange {
  return {
    key: Q1,
    question: { id: Q1, text: 'How many lines did the retry logic upload?' },
    answer,
    live,
  };
}

function complete(text: string, citations: RefCitation[]): ChatAnswer {
  return { phase: 'complete', runId: 'r', text, citations, error: null };
}

function render(panel: MeetingChatState): string {
  return renderToStaticMarkup(
    createElement(
      CitationNavigatorProvider,
      null,
      createElement(ChatPanel, { state: panel, actions: NO_ACTIONS }),
    ),
  );
}

/** The markup's text with tags dropped, for checks on what a person reads. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const button = (html: string, label: string): string | null =>
  new RegExp(`<button[^>]*>${label}</button>`).exec(html)?.[0] ?? null;

describe('ChatPanel', () => {
  it('shows each question with its answer, its refs as chips that open the transcript', () => {
    const html = render(
      state({
        exchanges: [
          exchange(
            complete('About fifteen hundred lines, with zero duplicates [L6].', [L6]),
            false,
          ),
        ],
      }),
    );
    expect(html).toContain('<section class="meeting-chat" aria-label="Chat">');
    expect(textOf(html)).toContain(
      'You asked: How many lines did the retry logic upload? Roger: About fifteen hundred lines, with zero duplicates 00:34 .',
    );
    expect(html).toContain('aria-label="Show the transcript at 00:34"');
    expect(button(html, 'Stop')).toBeNull();
    expect(button(html, 'Try again')).toBeNull();
  });

  it('draws a list the answer writes as a list', () => {
    const html = render(
      state({
        exchanges: [
          exchange(
            complete(
              'Two blockers:\n- The permission screen [L6]\n- The long-call path [L17]\n1. First\n2. Second',
              [L6, L17],
            ),
          ),
        ],
      }),
    );
    expect(html).toMatch(/<p>Two blockers:<\/p><ul><li>The permission screen <button/);
    expect(html).toMatch(/<li>The long-call path <button[^>]*>.*?<\/button><\/li><\/ul><ol>/);
    expect(html).toContain('<ol><li>First</li><li>Second</li></ol>');
  });

  it('an answer on its way can be stopped, and the next question waits for it', () => {
    const html = render(state({ exchanges: [exchange(WAITING_ANSWER)], answering: true }));
    expect(textOf(html)).toContain('Reading the meeting...');
    expect(button(html, 'Stop')).not.toBeNull();
    expect(html).toMatch(/<button type="submit" class="btn" data-variant="ghost"[^>]* disabled=""/);

    const streaming = render(
      state({
        exchanges: [
          exchange({ ...WAITING_ANSWER, phase: 'streaming', runId: 'r', text: 'About fif' }),
        ],
        answering: true,
      }),
    );
    expect(textOf(streaming)).toContain('Roger: About fif Writing...');
    expect(streaming).toContain('aria-busy="true"');
  });

  it('an answer another window is still writing shows no Stop', () => {
    const html = render(
      state({ exchanges: [exchange({ ...WAITING_ANSWER, phase: 'streaming' }, false)] }),
    );
    expect(textOf(html)).toContain('Roger is still writing this answer.');
    expect(button(html, 'Stop')).toBeNull();
  });

  it('a failed answer keeps its text, says why and offers to ask again', () => {
    const failed: ChatAnswer = {
      phase: 'failed',
      runId: 'r',
      text: 'The quote is twelve percent off [L6]',
      citations: [L6],
      error: { code: 'llm_provider_error', message: 'The model provider failed.' },
    };
    const html = render(state({ exchanges: [exchange(failed)] }));
    expect(textOf(html)).toContain(
      'The quote is twelve percent off 00:34 The AI service did not answer. Try again in a moment.',
    );
    expect(html).toContain('role="alert"');
    expect(button(html, 'Try again')).not.toBeNull();

    const stopped = render(
      state({
        exchanges: [exchange({ ...failed, error: { code: 'cancelled', message: 'Cancelled.' } })],
      }),
    );
    expect(textOf(stopped)).toContain('You stopped this answer.');
    expect(stopped).not.toContain('role="alert"');
    expect(button(stopped, 'Ask again')).not.toBeNull();

    const tooLong = render(
      state({
        exchanges: [
          exchange({ ...failed, error: { code: 'meeting_too_long', message: 'Too long' } }),
        ],
      }),
    );
    expect(button(tooLong, 'Try again')).toBeNull();
    expect(button(tooLong, 'Ask again')).toBeNull();
  });

  it('while an answer is coming, another answer cannot be asked again', () => {
    const html = render(state({ exchanges: [exchange(NO_ANSWER, false)], answering: true }));
    expect(button(html, 'Try again')).toMatch(/disabled=""/);
  });

  it('the empty chat says what it can answer', () => {
    const html = render(state());
    expect(textOf(html)).toContain(
      'Ask anything about this call: what was decided, a number someone gave, who said they would do what. Each answer links to the transcript lines behind it.',
    );
    expect(html).toContain('placeholder="Ask about this meeting"');
    // Nothing typed yet.
    expect(html).toMatch(/<button type="submit" class="btn" data-variant="ghost"[^>]* disabled=""/);
  });

  it('says it is opening, then why the thread could not be read, with Try again', () => {
    expect(render(state({ status: 'loading' }))).toContain('Opening the chat...');
    const html = render(state({ status: 'failed', error: 'GET /v1/meetings/x/chat failed' }));
    expect(textOf(html)).toContain(
      'Could not open this chat: GET /v1/meetings/x/chat failed Try again',
    );
    expect(html).toContain('role="alert"');
  });

  it('shows a notice that belongs to no one answer', () => {
    const html = render(
      state({ notice: 'Roger could not stop that answer (offline). It may still arrive.' }),
    );
    expect(html).toMatch(/<p class="meeting-chat-notice" role="status">Roger could not stop/);
  });
});

describe('draftCount', () => {
  it('counts only near the limit, in characters as the API counts them', () => {
    expect(draftCount('A short question')).toBeNull();
    expect(draftCount('x'.repeat(MAX_CHAT_TEXT_CHARS - 200))).toBeNull();
    expect(draftCount('x'.repeat(MAX_CHAT_TEXT_CHARS - 199))).toEqual({
      text: '3801 / 4000',
      over: false,
    });
    // An emoji is one character to the API, two to String.length.
    expect(draftCount('\u{1F600}'.repeat(MAX_CHAT_TEXT_CHARS))).toEqual({
      text: '4000 / 4000',
      over: false,
    });
    expect(draftCount(`  ${'x'.repeat(MAX_CHAT_TEXT_CHARS + 1)}  `)).toEqual({
      text: 'Too long: 4001 / 4000 characters',
      over: true,
    });
  });
});
