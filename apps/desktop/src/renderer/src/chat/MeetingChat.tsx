import {
  Fragment,
  type KeyboardEvent,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type CitationAttrs, isChatText, MAX_CHAT_TEXT_CHARS } from '../../../shared/notes';
import { CitationChipButton } from '../notes/CitationChip';
import { useCitationNavigator } from '../transcript/transcriptNavigator';
import {
  type AnswerBlock,
  type AnswerPart,
  answerBlocks,
  canRetry,
  describeAnswerError,
  isAnswering,
} from './chatStream';
import { type ChatExchange, type MeetingChatState, useMeetingChat } from './useMeetingChat';
// The chip's look: CitationChipButton is the notes' chip, and NoteEditor.tsx, which imports its
// styles, may not be on the page (the chat pane alone on a narrow window).
import '../notes/notes.css';
import './chat.css';

/**
 * Chat with one meeting (M4 "Chat"): questions answered from its transcript and notes, the
 * answer streaming in with its transcript refs as chips. A chip asks the meeting page's one
 * navigator (transcript/transcriptNavigator.ts) to show its lines, as an AI notes chip does, so
 * the panel needs the page's CitationNavigatorProvider above it. The meeting page mounts it in
 * its chat region (`meetingChat` slot, M4-T20).
 */
export function MeetingChat({ meetingId }: { meetingId: string }) {
  const { chat, state } = useMeetingChat(meetingId);
  return <ChatPanel state={state} actions={chat} />;
}

/** What the panel asks of the chat (MeetingChatStore). */
export interface ChatActions {
  ask(text: string): boolean;
  retry(questionId: string): void;
  cancel(questionId: string): void;
  reload(): void;
}

/** The panel as drawn from the chat's state: the thread, then the box to ask in. */
export function ChatPanel({ state, actions }: { state: MeetingChatState; actions: ChatActions }) {
  // Whether the log shows its end, so a growing answer keeps it there. Read and written only in
  // handlers and effects: a ref read during render breaks react-hooks/refs.
  const atEndRef = useRef(true);
  const ask = (text: string): boolean => {
    const asked = actions.ask(text);
    if (asked) atEndRef.current = true;
    return asked;
  };
  return (
    <section className="meeting-chat" aria-label="Chat">
      <h2 className="meeting-chat-title">Chat</h2>
      <ChatLog state={state} actions={actions} atEndRef={atEndRef} />
      {state.notice === null ? null : (
        <p className="meeting-chat-notice" role="status">
          {state.notice}
        </p>
      )}
      <ChatComposer ready={state.status === 'ready'} answering={state.answering} onAsk={ask} />
    </section>
  );
}

/** Within this many pixels of its end, the log counts as showing its end. */
const AT_END_SLACK_PX = 24;

function ChatLog({
  state,
  actions,
  atEndRef,
}: {
  state: MeetingChatState;
  actions: ChatActions;
  atEndRef: RefObject<boolean>;
}) {
  const log = useRef<HTMLDivElement>(null);
  const last = state.exchanges.at(-1);
  // What makes the log grow: a new exchange, the last answer's text and its state line.
  const grows = `${state.status}/${state.exchanges.length}/${last?.answer.phase ?? ''}/${last?.answer.text.length ?? 0}`;
  useLayoutEffect(() => {
    const element = log.current;
    if (element !== null && atEndRef.current) element.scrollTop = element.scrollHeight;
  }, [grows, atEndRef]);

  return (
    <div
      ref={log}
      className="meeting-chat-log"
      role="log"
      aria-label="Questions and answers"
      // A region that scrolls takes the keyboard, so it can be scrolled without a mouse.
      tabIndex={0}
      onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        atEndRef.current = scrollHeight - scrollTop - clientHeight <= AT_END_SLACK_PX;
      }}
    >
      <LogContent state={state} actions={actions} />
    </div>
  );
}

function LogContent({ state, actions }: { state: MeetingChatState; actions: ChatActions }) {
  if (state.status === 'loading') {
    return (
      <p className="meeting-chat-message" aria-busy="true">
        Opening the chat...
      </p>
    );
  }
  if (state.status === 'failed') {
    return (
      <div className="error meeting-chat-read-error" role="alert">
        Could not open this chat: {state.error}{' '}
        <button
          type="button"
          className="meeting-chat-button"
          onClick={() => {
            actions.reload();
          }}
        >
          Try again
        </button>
      </div>
    );
  }
  if (state.exchanges.length === 0) {
    return (
      <p className="meeting-chat-message">
        Ask anything about this call: what was decided, a number someone gave, who said they would
        do what. Each answer links to the transcript lines behind it.
      </p>
    );
  }
  return state.exchanges.map((exchange) => (
    <Exchange
      key={exchange.key}
      exchange={exchange}
      answering={state.answering}
      actions={actions}
    />
  ));
}

function Exchange({
  exchange: { key, question, answer, live },
  answering,
  actions,
}: {
  exchange: ChatExchange;
  /** Some answer is still coming: no other question is asked meanwhile. */
  answering: boolean;
  actions: ChatActions;
}) {
  const coming = isAnswering(answer);
  const blocks = answerBlocks(answer.text, answer.citations);
  const stopped = answer.error?.code === 'cancelled';
  return (
    <div className="meeting-chat-exchange" data-phase={answer.phase}>
      {question === null ? null : (
        <p className="meeting-chat-question">
          <span className="meeting-chat-who">You asked: </span>
          {question.text}
        </p>
      )}
      <div className="meeting-chat-answer" aria-busy={coming ? true : undefined}>
        <span className="meeting-chat-who">Roger: </span>
        {blocks.length === 0 ? null : <AnswerText blocks={blocks} />}
        {answer.phase === 'waiting' ? (
          <p className="meeting-chat-state">Reading the meeting...</p>
        ) : answer.phase === 'streaming' ? (
          <p className="meeting-chat-state">
            {live ? 'Writing...' : 'Roger is still writing this answer.'}
          </p>
        ) : null}
        {answer.error === null ? null : (
          <p
            className={stopped ? 'meeting-chat-state' : 'meeting-chat-error'}
            role={stopped ? undefined : 'alert'}
          >
            {describeAnswerError(answer.error)}
          </p>
        )}
        {live && coming ? (
          <div className="meeting-chat-actions">
            <button
              type="button"
              className="meeting-chat-button"
              onClick={() => {
                actions.cancel(key);
              }}
            >
              Stop
            </button>
          </div>
        ) : question !== null && canRetry(answer) ? (
          <div className="meeting-chat-actions">
            <button
              type="button"
              className="meeting-chat-button"
              disabled={answering}
              title={answering ? 'Wait for the answer that is coming, or stop it' : undefined}
              onClick={() => {
                actions.retry(question.id);
              }}
            >
              {stopped ? 'Ask again' : 'Try again'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The answer's lines: paragraphs, and runs of list lines as one list. */
function AnswerText({ blocks }: { blocks: readonly AnswerBlock[] }) {
  return (
    <div className="meeting-chat-text">
      {listRuns(blocks).flatMap((run, index) => {
        const items = run.blocks.map((block, item) => (
          <li key={item}>
            <Parts parts={block.parts} />
          </li>
        ));
        switch (run.kind) {
          case 'paragraph':
            return run.blocks.map((block, item) => (
              <p key={`${index}/${item}`}>
                <Parts parts={block.parts} />
              </p>
            ));
          case 'bullet':
            return [<ul key={index}>{items}</ul>];
          case 'numbered':
            return [<ol key={index}>{items}</ol>];
        }
      })}
    </div>
  );
}

interface BlockRun {
  kind: AnswerBlock['kind'];
  blocks: AnswerBlock[];
}

/** Consecutive blocks of one kind, so the list lines between paragraphs form one list each. */
function listRuns(blocks: readonly AnswerBlock[]): BlockRun[] {
  const runs: BlockRun[] = [];
  for (const block of blocks) {
    const last = runs.at(-1);
    if (last?.kind === block.kind) last.blocks.push(block);
    else runs.push({ kind: block.kind, blocks: [block] });
  }
  return runs;
}

function Parts({ parts }: { parts: readonly AnswerPart[] }) {
  return parts.map((part, index) =>
    part.kind === 'text' ? (
      <Fragment key={index}>{part.text}</Fragment>
    ) : (
      <AnswerChip key={index} citation={part.citation} />
    ),
  );
}

/** A chip of the answer, revealing as an AI notes chip does (notes/CitationChip.tsx). */
function AnswerChip({ citation }: { citation: CitationAttrs }) {
  const navigator = useCitationNavigator();
  const [removed, setRemoved] = useState(false);
  return (
    <CitationChipButton
      attrs={citation}
      removed={removed}
      onReveal={() => {
        setRemoved(navigator.reveal(citation.segmentIds) === 'not_loaded');
      }}
    />
  );
}

/** Shown from this many characters, so a long question is cut by the person, not refused. */
const COUNT_FROM = MAX_CHAT_TEXT_CHARS - 200;

/**
 * The draft's length near the API's limit, in characters as the API counts them (code points,
 * after trimming); null below it.
 */
export function draftCount(draft: string): { text: string; over: boolean } | null {
  const count = Array.from(draft.trim()).length;
  if (count <= COUNT_FROM) return null;
  const over = count > MAX_CHAT_TEXT_CHARS;
  const measure = `${count} / ${MAX_CHAT_TEXT_CHARS}`;
  return { text: over ? `Too long: ${measure} characters` : measure, over };
}

function ChatComposer({
  ready,
  answering,
  onAsk,
}: {
  /** The thread is read; before that a question could repeat one already asked. */
  ready: boolean;
  answering: boolean;
  onAsk: (text: string) => boolean;
}) {
  const [draft, setDraft] = useState('');
  const count = draftCount(draft);
  const canAsk = ready && !answering && isChatText(draft.trim());
  const submit = (): void => {
    if (canAsk && onAsk(draft)) setDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter asks and Shift+Enter starts a new line. Not while an input method is composing:
    // there Enter picks the candidate.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };
  return (
    <form
      className="meeting-chat-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        className="meeting-chat-input"
        aria-label="Ask about this meeting"
        placeholder="Ask about this meeting"
        rows={1}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        className="meeting-chat-ask"
        disabled={!canAsk}
        title={answering ? 'Wait for the answer that is coming, or stop it' : undefined}
      >
        Ask
      </button>
      {count === null ? null : (
        <p
          className={
            count.over ? 'meeting-chat-count meeting-chat-count-over' : 'meeting-chat-count'
          }
          aria-live="polite"
        >
          {count.text}
        </p>
      )}
    </form>
  );
}
