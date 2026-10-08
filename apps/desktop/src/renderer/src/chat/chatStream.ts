import type {
  ChatMessage,
  ChatStreamEvent,
  CitationAttrs,
  RefCitation,
} from '../../../shared/notes';
import { describeError } from '../app/describeError';

/**
 * One answer of the meeting chat as the panel shows it, from the API's events as main forwards
 * them (`chat:event`, docs/api-contract.md "Chat"): `run`, then `delta` pieces and a `citation` for
 * each line ref as soon as its bracket closes, then `done` with the stored answer, or `error`.
 *
 * The answer's text cites lines as ref groups, `[L12]` or `[L12, L15]`. A ref becomes a chip once
 * a `citation` event (or the stored answer's citations) maps it to its transcript line; a ref with
 * none stays text. While streaming that is every `N` ref (a note block has no line) and every ref
 * the meeting does not hold: the API takes them out only when it stores the answer, so `done`'s
 * text replaces the streamed text and they go then.
 */

/** `waiting` until the API names the run; `failed` also covers a stopped answer. */
export type AnswerPhase = 'waiting' | 'streaming' | 'complete' | 'failed';

export interface AnswerError {
  /** The API's or main's code (`llm_provider_error`, `cancelled`, `network_error`, ...). */
  code: string;
  message: string;
}

export interface ChatAnswer {
  phase: AnswerPhase;
  /** The run writing it, once its `run` event named it, or the stored answer's. */
  runId: string | null;
  text: string;
  /** The line refs mapped so far, each once, in the order they came. */
  citations: readonly RefCitation[];
  /** Why it failed; null unless `failed`. */
  error: AnswerError | null;
}

/** A question just asked: main has it, and its answer has not begun. */
export const WAITING_ANSWER: ChatAnswer = {
  phase: 'waiting',
  runId: null,
  text: '',
  citations: [],
  error: null,
};

/** The code of a question main did not take (`chat:send` rejected); its message is main's. */
export const NOT_SENT = 'not_sent';

/** A question the thread holds with no answer at all: the page can only ask it again. */
export const NO_ANSWER: ChatAnswer = {
  phase: 'failed',
  runId: null,
  text: '',
  citations: [],
  error: { code: 'no_answer', message: 'This question has no answer yet.' },
};

/**
 * The next state of an answer after one of its events. A `run` starts the text over: the API
 * sends one when it writes a failed answer again (a retry keeps the message id) and when a re-sent
 * id attaches to an answer being written (its events so far, from the start). A `done` is the
 * stored answer and always wins; a replayed complete answer is `done` alone, with no `run`.
 */
export function applyChatEvent(answer: ChatAnswer, event: ChatStreamEvent): ChatAnswer {
  switch (event.type) {
    case 'run':
      return { phase: 'streaming', runId: event.runId, text: '', citations: [], error: null };
    case 'delta':
      if (isFinished(answer)) return answer;
      return { ...answer, phase: 'streaming', text: answer.text + event.text };
    case 'citation': {
      if (isFinished(answer) || answer.citations.some(({ ref }) => ref === event.ref)) {
        return answer;
      }
      const { ref, segmentId, startMs } = event;
      return { ...answer, citations: [...answer.citations, { ref, segmentId, startMs }] };
    }
    case 'done':
      return storedAnswer(event.message);
    case 'error':
      // A stored answer is the truth; an error after it cannot unmake it.
      if (answer.phase === 'complete') return answer;
      return failedAnswer(answer, { code: event.code, message: event.message });
  }
}

/** An answer as the thread stores it (`GET .../chat`, or `done`'s message). */
export function storedAnswer(message: ChatMessage): ChatAnswer {
  const { runId, text, citations } = message;
  switch (message.status) {
    case 'complete':
      return { phase: 'complete', runId, text, citations, error: null };
    case 'streaming':
      return { phase: 'streaming', runId, text, citations, error: null };
    case 'failed':
      return {
        phase: 'failed',
        runId,
        text,
        citations,
        error: { code: 'stored_failure', message: 'This answer did not finish.' },
      };
  }
}

/** The answer failed: what came so far stays on screen ("an error keeps the partial answer"). */
export function failedAnswer(answer: ChatAnswer, error: AnswerError): ChatAnswer {
  return { ...answer, phase: 'failed', error };
}

/** Its stream is still to come or coming: the page can stop it, and asks nothing else meanwhile. */
export function isAnswering(answer: ChatAnswer): boolean {
  return answer.phase === 'waiting' || answer.phase === 'streaming';
}

/** Codes for which asking the same question again changes nothing. */
const FINAL_CODES: ReadonlySet<string> = new Set(['meeting_too_long', 'validation_error']);

/** Asking again re-sends the question's id: the API writes a failed answer again. */
export function canRetry(answer: ChatAnswer): boolean {
  return answer.phase === 'failed' && !FINAL_CODES.has(answer.error?.code ?? '');
}

/**
 * Main's refusal of a re-sent question whose earlier try's stream is still open
 * (main/notes/notes-ipc.ts, `answer`). It only happens when Retry is pressed in the moment
 * between that try's `error` event and the end of its stream.
 */
const STILL_ON_ITS_WAY = /^the answer to message \S+ is already on its way$/;

/** Why an answer failed, for people. Main's and the API's own wording names routes and ids. */
export function describeAnswerError({ code, message }: AnswerError): string {
  switch (code) {
    case 'cancelled':
      return 'You stopped this answer.';
    case 'network_error':
      return 'Roger could not reach the server. Check the connection and try again.';
    case 'llm_provider_error':
      return 'The AI service did not answer. Try again in a moment.';
    case 'meeting_too_long':
      return 'This meeting is too long to chat with: over about 10 hours of talk.';
    case 'not_found':
      return 'This meeting is not on the server yet. Try again once its transcript has uploaded.';
    // Roger's own code for a stored answer that never finished (storedAnswer): its words are ours.
    case 'stored_failure':
      return message;
    case NOT_SENT:
      return STILL_ON_ITS_WAY.test(message)
        ? 'The last try is still closing. Try again in a moment.'
        : `Roger could not send this question: ${describeError(message)}`;
    // An unknown code's message is the API's or a vendor's text, which names routes and ids: the
    // generic line, never the text. A known code above carries its own words.
    default:
      return 'Something went wrong. Try again in a moment.';
  }
}

function isFinished(answer: ChatAnswer): boolean {
  return answer.phase === 'complete' || answer.phase === 'failed';
}

// The answer's text as blocks of text and chips -------------------------------------------------

export type AnswerPart =
  | { kind: 'text'; text: string }
  /** One ref group's mapped refs: one chip, as an AI notes line has one chip for its lines. */
  | { kind: 'chip'; refs: readonly string[]; citation: CitationAttrs };

/** A line of the answer: the prompt asks for "plain sentences or a short list" (chat_prompt.py). */
export interface AnswerBlock {
  kind: 'paragraph' | 'bullet' | 'numbered';
  parts: readonly AnswerPart[];
}

/*
 * The ref grammar of the API's `_REF_GROUP` (services/notes_protocol.py), which decides what the
 * API sends a `citation` for and what it writes back into the stored answer. Change the two
 * together: a group the API reads and this does not stays text after its chip was sent.
 * Like the API's, each optional space is ` ?`, never `\s*`, and a separator is `(?: ?[,;])? ?`,
 * never ` ?[,;]? ?`: two ways to match one space make a failed match retry every split.
 */
const DASH = '[-\\u2013\\u2014]';
const REF = `[LN]\\d{1,6}(?: ?${DASH} ?[LN]?\\d{1,6})?`;
const BRACKETED_REFS = `\\[ ?${REF}(?: ?[,;] ?${REF})* ?\\]`;
const BRACKETED_GROUPS = `${BRACKETED_REFS}(?:(?: ?[,;])? ?${BRACKETED_REFS})*`;
/**
 * One `[L12, L15]` group, or groups the model wrapped in one more pair of brackets (`[[L12]]`,
 * `([L12], [L13])`), the wrapper with them. The API's pattern also takes the space before a group;
 * here that space stays text, before the chip.
 */
const REF_GROUP = new RegExp(
  `\\[ ?${BRACKETED_GROUPS} ?\\]|\\( ?${BRACKETED_GROUPS} ?\\)|${BRACKETED_REFS}`,
  'gi',
);
const REFS_IN_BRACKETS = new RegExp(`\\[ ?(${REF}(?: ?[,;] ?${REF})*) ?\\]`, 'gi');
const REF_TOKEN = new RegExp(`^([LN])(\\d+)(?: ?${DASH} ?([LN])?(\\d+))?$`, 'i');
const REF_SEPARATOR = / ?[,;] ?/;
/**
 * The API's `MAX_REFS_PER_LINE`: it sends a citation for at most this many refs of one group, and
 * a range like `[L1-L999999]` is expanded only that far.
 */
const MAX_REFS_PER_GROUP = 8;

/** A list line as models write one: `- `, `* `, a bullet character, or `1. ` and `1) `. */
const LIST_ITEM = /^(?:([-*\u2022])|\d{1,3}[.)]) +(.*)$/;

/**
 * The answer's text as the panel draws it: one block per line, each line's ref groups turned into
 * chips for the refs `citations` maps. In a group with some refs mapped and some not, the chip
 * comes first and the others stay text after it, in brackets.
 */
export function answerBlocks(text: string, citations: readonly RefCitation[]): AnswerBlock[] {
  const byRef = new Map(citations.map((citation) => [citation.ref.toUpperCase(), citation]));
  return text.split(/\r?\n/).flatMap((raw): AnswerBlock[] => {
    const line = raw.trim();
    if (line === '') return [];
    const item = LIST_ITEM.exec(line);
    if (item === null) return [{ kind: 'paragraph', parts: answerParts(line, byRef) }];
    const [, bullet, content = ''] = item;
    return [
      { kind: bullet === undefined ? 'numbered' : 'bullet', parts: answerParts(content, byRef) },
    ];
  });
}

function answerParts(line: string, byRef: ReadonlyMap<string, RefCitation>): AnswerPart[] {
  const parts: AnswerPart[] = [];
  const addText = (text: string): void => {
    if (text === '') return;
    const last = parts.at(-1);
    if (last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + text };
    else parts.push({ kind: 'text', text });
  };
  let readTo = 0;
  for (const match of line.matchAll(REF_GROUP)) {
    const refs = refsOf(match[0]);
    const mapped = refs.flatMap((ref) => byRef.get(ref) ?? []);
    if (mapped.length === 0) continue;
    addText(line.slice(readTo, match.index));
    parts.push({ kind: 'chip', refs: mapped.map(({ ref }) => ref), citation: chipOf(mapped) });
    const unmapped = refs.filter((ref) => !byRef.has(ref));
    if (unmapped.length > 0) addText(` [${unmapped.join(', ')}]`);
    readTo = match.index + match[0].length;
  }
  addText(line.slice(readTo));
  return parts;
}

/** A group's refs as the API names them (`L12`), ranges expanded, each once, at most eight. */
function refsOf(group: string): string[] {
  const refs = new Set<string>();
  for (const ref of expand(group)) {
    refs.add(ref);
    if (refs.size === MAX_REFS_PER_GROUP) break;
  }
  return [...refs];
}

/** Lazy, as the API's `_expand`: `[L1-L999999]` costs only the refs the cap lets through. */
function* expand(group: string): Generator<string> {
  for (const [, list = ''] of group.matchAll(REFS_IN_BRACKETS)) {
    for (const token of list.split(REF_SEPARATOR)) {
      const match = REF_TOKEN.exec(token);
      // REF_GROUP admits only ref tokens, so a token that does not match is a bug here.
      if (match === null) throw new Error(`Ref token "${token}" does not match the ref pattern`);
      const [, kind = '', start = '', endKind, end] = match;
      if (end === undefined) {
        yield refName(kind, start);
      } else if (endKind !== undefined && endKind.toUpperCase() !== kind.toUpperCase()) {
        // `L3-N5` is not a range; the API keeps both ends rather than guess.
        yield refName(kind, start);
        yield refName(endKind, end);
      } else {
        const [from, to] = [Number(start), Number(end)];
        const high = Math.max(from, to);
        for (let number = Math.min(from, to); number <= high; number += 1) {
          yield refName(kind, String(number));
        }
      }
    }
  }
}

/** `l012` is `L12`, as the API writes a ref (`Ref.__str__`). */
function refName(kind: string, digits: string): string {
  return `${kind.toUpperCase()}${Number(digits)}`;
}

/** The chip of a group: its lines, timed and labelled at the earliest of them. */
function chipOf(mapped: readonly RefCitation[]): CitationAttrs {
  const startMs = Math.min(...mapped.map((citation) => citation.startMs));
  return {
    segmentIds: mapped.map(({ segmentId }) => segmentId),
    startMs,
    label: chipLabel(startMs),
    support: 'ok',
  };
}

/**
 * A chip's time: "03:12", or "1:02:05" past an hour. The same label the API gives an AI notes
 * chip (`chip_label` in services/notes_generation.py), so the two kinds of chip read alike.
 */
export function chipLabel(startMs: number): string {
  const total = Math.max(0, Math.floor(startMs / 1000));
  const hours = Math.floor(total / 3600);
  const clock = [Math.floor((total % 3600) / 60), total % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
  return hours > 0 ? `${hours}:${clock}` : clock;
}
