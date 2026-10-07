"""Chat with one meeting (M4-T10): one thread per meeting, each answer written by an LLM run.

A question is claimed in the route's own session, which the route commits and closes; then the run
registry (services/llm_runs.py) writes the answer in the background, and the route's SSE response
only subscribes. So an answer finishes and is saved even when the desktop goes away mid-stream, and
no transaction is held across the model call (routers/chat.py, its traps).

The answer is grounded in the meeting: its transcript (`L` refs), the user's notes (`N` refs) and
the AI notes as context (chat_prompt.py). As it streams, each `[L12]` the map holds is sent once as
a `citation` event; the stored answer keeps only those refs.

A question's `message_id` is the desktop's, and a re-send never stores a second question:
- its answer is complete: that answer's `done` is replayed, and nothing is paid for twice;
- its answer is being written here: the stream attaches to the run, the events so far then live;
- its answer failed, or its run died: the same answer row is written again, by a new run;
- the id is stored under another meeting or workspace, or is an answer's: 409, nothing replayed.

A chat run takes no meeting lock (`services.notes.lock_meeting`): it writes no note, so it never
holds up a notes save, and it may run beside a notes run.
"""

from collections.abc import AsyncGenerator
from contextlib import aclosing
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import ColumnElement, case, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from roger_api.auth import Principal
from roger_api.db.models import TranscriptSegment
from roger_api.db.models_notes import ChatMessage, LlmRun
from roger_api.errors import ConflictError, MeetingTooLongError
from roger_api.log import get_logger
from roger_api.schemas.chat import ChatMessageOut
from roger_api.schemas.common import storable_text
from roger_api.services.chat_prompt import (
    CHAT_HISTORY_EXCHANGES,
    CHAT_PROMPT_VERSION,
    AnswerReader,
    ChatExchange,
    ChatPrompt,
    build_chat_prompt,
)
from roger_api.services.citations import Citation, RefMap, SourceLine
from roger_api.services.llm_runs import (
    STALE_AFTER,
    LiveRun,
    LlmRuntime,
    RunContext,
    RunEvent,
    RunSave,
    RunWork,
    claim_run,
)
from roger_api.services.meetings import require_meeting
from roger_api.services.notes import get_notes
from roger_api.services.notes_markdown import render_markdown, split_note_blocks
from roger_api.services.notes_model import ModelRequest, TextDelta

# Private there because services/segments.py has another owner in Phase 2. The one transcript
# order: a second copy that drifted would number lines differently from the transcript the desktop
# and MCP show.
from roger_api.services.segments import _TRANSCRIPT_ORDER

logger = get_logger(__name__)

# A question and its answer are stored in one transaction, so they share `created_at` (Postgres's
# now() is the transaction's start): the question sorts first.
_THREAD_ORDER = (
    ChatMessage.created_at,
    case((ChatMessage.role == "user", 0), else_=1),
    ChatMessage.id,
)


@dataclass(frozen=True, slots=True)
class AnswerToWrite:
    """A claimed answer the model has yet to write: a new question, or one written again."""

    run: LlmRun
    answer_id: UUID
    request: ModelRequest
    refs: RefMap
    again: bool


@dataclass(frozen=True, slots=True)
class AnswerWritten:
    message: ChatMessage


@dataclass(frozen=True, slots=True)
class AnswerBeingWritten:
    live: LiveRun


type AnswerClaim = AnswerToWrite | AnswerWritten | AnswerBeingWritten


@dataclass(frozen=True, slots=True)
class AnswerStream:
    """What `POST .../chat` sends: a written answer's `done` alone, or a run's events."""

    written: ChatMessage | None = None
    live: LiveRun | None = None

    async def events(self) -> AsyncGenerator[RunEvent, None]:
        if self.written is not None:
            yield _done(self.written)
        if self.live is not None:
            # A subscriber that leaves never touches the run: it finishes and saves unwatched.
            async with aclosing(self.live.subscribe()) as events:
                async for event in events:
                    yield event


async def list_thread(
    session: AsyncSession, principal: Principal, meeting_id: UUID, *, limit: int
) -> list[ChatMessage]:
    """The latest `limit` messages of the meeting's thread, oldest first. Raises NotFoundError."""
    await require_meeting(session, principal, meeting_id)
    latest = await session.scalars(
        select(ChatMessage)
        .where(*_thread_of(principal, meeting_id))
        .order_by(*(column.desc() for column in _THREAD_ORDER))
        .limit(limit)
    )
    return list(reversed(latest.all()))


async def claim_answer(
    session: AsyncSession,
    runtime: LlmRuntime,
    principal: Principal,
    meeting_id: UUID,
    *,
    message_id: UUID,
    text: str,
    max_input_tokens: int,
) -> AnswerClaim:
    """Claims the answer to question `message_id`, or finds it (a re-send, module docstring).

    Does not commit: the route commits and closes the session, then calls `start_answer`. Raises
    NotFoundError for the meeting, ConflictError when the id is stored elsewhere or its answer is
    being written by another API process, and MeetingTooLongError when the meeting is over
    `max_input_tokens`; nothing is stored then.
    """
    await require_meeting(session, principal, meeting_id)
    question = await session.scalar(
        select(ChatMessage)
        .where(
            *_thread_of(principal, meeting_id),
            ChatMessage.id == message_id,
            ChatMessage.role == "user",
        )
        # Two re-sends of one question take turns: only one of them writes its answer again.
        .with_for_update()
    )
    if question is None:
        if await _stored_elsewhere(session, message_id):
            raise ConflictError(
                f"Message {message_id} is already stored under another meeting or workspace, "
                "or as an answer"
            )
        return await _claim_writing(
            session,
            runtime,
            principal,
            meeting_id,
            _Question(message_id, text, asked_at=None),
            answer_id=None,
            max_input_tokens=max_input_tokens,
        )
    answer = await _answer_to(session, principal, question)
    if answer is not None and answer.status == "complete":
        return AnswerWritten(answer)
    if answer is not None and answer.status == "streaming":
        live = (
            None if answer.run_id is None else runtime.find(principal.workspace_id, answer.run_id)
        )
        if live is not None:
            return AnswerBeingWritten(live)
        if not await _run_is_over(session, principal, answer.run_id):
            raise ConflictError(
                f"The answer to message {message_id} is being written by another API process; "
                "read the thread once it has finished"
            )
    # Failed, or its run died (`claim_run`'s sweep fails that run and this answer first).
    return await _claim_writing(
        session,
        runtime,
        principal,
        meeting_id,
        _Question(question.id, question.text, asked_at=question.created_at),
        answer_id=None if answer is None else answer.id,
        max_input_tokens=max_input_tokens,
    )


async def start_answer(runtime: LlmRuntime, claim: AnswerClaim) -> AnswerStream:
    """The answer's stream. Call it only once the claim has committed and its session is closed.

    For an answer to write, it returns once the model stream has opened, and raises the
    `LlmProviderError` of a vendor that refused (the 502 envelope). The run and the answer are
    stored failed by then, so the same message id sent again writes the answer again.
    """
    match claim:
        case AnswerWritten(message=message):
            logger.info(
                "chat_answer_replayed", answer_id=str(message.id), run_id=str(message.run_id)
            )
            return AnswerStream(written=message)
        case AnswerBeingWritten(live=live):
            logger.info("chat_answer_attached", run_id=str(live.run_id))
            return AnswerStream(live=live)
        case AnswerToWrite():
            logger.info(
                "chat_answer_started",
                run_id=str(claim.run.id),
                meeting_id=str(claim.run.meeting_id),
                answer_id=str(claim.answer_id),
                line_count=claim.run.line_count,
                again=claim.again,
            )
            return AnswerStream(live=await runtime.start(claim.run, _answer_work(claim)))


@dataclass(frozen=True, slots=True)
class _Question:
    id: UUID
    text: str
    # When it was stored; None for a question this claim stores.
    asked_at: datetime | None


async def _claim_writing(
    session: AsyncSession,
    runtime: LlmRuntime,
    principal: Principal,
    meeting_id: UUID,
    question: _Question,
    *,
    answer_id: UUID | None,
    max_input_tokens: int,
) -> AnswerToWrite:
    refs, prompt = await _meeting_prompt(session, principal, meeting_id)
    if prompt.estimated_tokens > max_input_tokens:
        raise MeetingTooLongError(
            f"Meeting {meeting_id} is too long to chat with: its transcript and notes are about "
            f"{prompt.estimated_tokens} tokens, over the budget of {max_input_tokens}"
        )
    history = await _history(session, principal, meeting_id, asked_before=question.asked_at)
    if question.asked_at is None:
        await _store_question(session, principal, meeting_id, question)
    run = LlmRun(
        id=uuid4(),
        workspace_id=principal.workspace_id,
        meeting_id=meeting_id,
        kind="chat",
        status="running",
        model=runtime.notes_model.model_id("chat"),
        prompt_version=CHAT_PROMPT_VERSION,
        template_id=None,
        line_count=len(refs.lines),
        ref_map=refs.to_json(),
    )
    # Fails the meeting's dead runs first, and their streaming answers: one of them may be the
    # answer written again below, which then moves to this run.
    await claim_run(session, run)
    if answer_id is None:
        answer_id = uuid4()
        session.add(
            ChatMessage(
                id=answer_id,
                workspace_id=principal.workspace_id,
                meeting_id=meeting_id,
                role="assistant",
                text="",
                reply_to=question.id,
                run_id=run.id,
                status="streaming",
            )
        )
    else:
        # Needs no status check: `_answer_to` holds this row, failed or streaming, locked until the
        # claim commits. Without that lock this would reset an answer saved in between.
        await session.execute(
            update(ChatMessage)
            .where(ChatMessage.id == answer_id, ChatMessage.workspace_id == principal.workspace_id)
            .values(text="", citations=None, run_id=run.id, status="streaming")
        )
    await session.flush()
    return AnswerToWrite(
        run=run,
        answer_id=answer_id,
        request=prompt.request(history, question.text),
        refs=refs,
        again=question.asked_at is not None,
    )


async def _meeting_prompt(
    session: AsyncSession, principal: Principal, meeting_id: UUID
) -> tuple[RefMap, ChatPrompt]:
    rows = await session.execute(
        # Never `words`: per-word timings are most of a row, and the prompt shows none.
        select(
            TranscriptSegment.id,
            TranscriptSegment.start_ms,
            TranscriptSegment.speaker,
            TranscriptSegment.text,
        )
        .where(
            TranscriptSegment.meeting_id == meeting_id,
            TranscriptSegment.workspace_id == principal.workspace_id,
        )
        .order_by(*_TRANSCRIPT_ORDER)
    )
    lines = tuple(
        SourceLine(segment_id=segment_id, start_ms=start_ms, speaker=speaker, text=text)
        for segment_id, start_ms, speaker, text in rows
    )
    notes = await get_notes(session, principal, meeting_id)
    blocks = () if notes.user is None else split_note_blocks(notes.user.doc)
    refs = RefMap(lines=lines, note_blocks=tuple(block.markdown for block in blocks))
    ai_notes = "" if notes.ai is None else render_markdown(notes.ai.doc)
    return refs, build_chat_prompt(refs, ai_notes)


async def _history(
    session: AsyncSession, principal: Principal, meeting_id: UUID, *, asked_before: datetime | None
) -> list[ChatExchange]:
    """The latest complete exchanges, oldest first: before `asked_before` when the question is
    written again, so it reads the thread as it was when it was asked."""
    asked = aliased(ChatMessage)
    query = (
        select(asked.text, ChatMessage.text)
        .join(
            asked,
            (asked.id == ChatMessage.reply_to) & (asked.workspace_id == ChatMessage.workspace_id),
        )
        .where(
            *_thread_of(principal, meeting_id),
            ChatMessage.role == "assistant",
            ChatMessage.status == "complete",
        )
        .order_by(asked.created_at.desc(), asked.id.desc())
        .limit(CHAT_HISTORY_EXCHANGES)
    )
    if asked_before is not None:
        query = query.where(asked.created_at < asked_before)
    rows = (await session.execute(query)).all()
    return [ChatExchange(question=question, answer=answer) for question, answer in reversed(rows)]


async def _store_question(
    session: AsyncSession, principal: Principal, meeting_id: UUID, question: _Question
) -> None:
    stored = await session.scalar(
        insert(ChatMessage)
        .values(
            id=question.id,
            workspace_id=principal.workspace_id,
            meeting_id=meeting_id,
            role="user",
            text=question.text,
            status="complete",
        )
        .on_conflict_do_nothing(index_elements=[ChatMessage.id])
        .returning(ChatMessage.id)
    )
    if stored is None:
        # Another request stored this id after the lookup above: the same question sent twice at
        # once. Its answer is that request's; this one stores nothing.
        raise ConflictError(
            f"Message {question.id} was sent twice at once; read the thread for its answer"
        )


async def _answer_to(
    session: AsyncSession, principal: Principal, question: ChatMessage
) -> ChatMessage | None:
    """The question's answer, locked until the claim commits.

    A run's save or failure (`llm_runs._succeed`, `_end_running_row`) waits for that lock, so the
    status read here stays true through `_run_is_over` and `_claim_writing`. Unlocked, a save could
    commit between this read (`streaming`) and `_run_is_over` (its run now `succeeded`, so over),
    and `_claim_writing` would reset the complete answer and pay for it again. FOR NO KEY UPDATE is
    enough to hold off an UPDATE (CLAUDE.md failure log, M3-T2).

    Lock order: this answer, then its run when `claim_run`'s sweep fails it as stale. A run that
    another API process fails at that moment takes them the other way round; Postgres ends that
    deadlock by failing one of the two transactions, never by a wrong write.
    """
    return await session.scalar(
        select(ChatMessage)
        .where(
            *_thread_of(principal, question.meeting_id),
            ChatMessage.reply_to == question.id,
            ChatMessage.role == "assistant",
        )
        .order_by(ChatMessage.created_at.desc())
        .limit(1)
        .with_for_update(key_share=True)
    )


async def _stored_elsewhere(session: AsyncSession, message_id: UUID) -> bool:
    # Message ids are globally unique primary keys, so this check cannot be workspace-scoped. It
    # tells the caller nothing about the other row beyond the conflict itself.
    found = await session.scalar(select(ChatMessage.id).where(ChatMessage.id == message_id))
    return found is not None


async def _run_is_over(session: AsyncSession, principal: Principal, run_id: UUID | None) -> bool:
    """True when the run has ended, or its heartbeat is STALE_AFTER old on the database clock (the
    sweep's own test, `llm_runs._fail_stale_runs`): no API process is writing the answer.

    Called only for an answer `_answer_to` locked as `streaming`, so its run never reads
    `succeeded` here: a run saves its answer `complete` and ends `succeeded` in one commit, which
    waits on that lock. Unlocked, `succeeded` here meant "saved a moment ago", and the claim wrote
    that answer again.
    """
    if run_id is None:
        return True
    over = await session.scalar(
        select(
            or_(LlmRun.status != "running", LlmRun.heartbeat_at < func.now() - STALE_AFTER)
        ).where(LlmRun.id == run_id, LlmRun.workspace_id == principal.workspace_id)
    )
    return over is None or over


def _answer_work(claim: AnswerToWrite) -> RunWork:
    async def work(context: RunContext) -> RunSave:
        # First, before the model opens (`start` returns once it has): every subscriber, a late one
        # too, reads the run id before any text, and a cancel can name the run. LlmStreams.ts
        # drops a chat stream whose `run` has no `model` (phase-2-build-order.md, section 10).
        context.emit(RunEvent("run", {"run_id": str(claim.run.id), "model": claim.run.model}))
        reader = AnswerReader(claim.refs)
        async with context.stream(claim.request) as events:
            async for event in events:
                if isinstance(event, TextDelta):
                    # Made storable as it arrives, so the stream, the citations and the stored
                    # answer all read the same text.
                    text = storable_text(event.text)
                    context.emit(RunEvent("delta", {"text": text}))
                    for citation in reader.feed(text):
                        context.emit(RunEvent("citation", _citation_json(citation)))
        answer = reader.finish()

        async def save(session: AsyncSession) -> list[RunEvent]:
            message = await session.scalar(
                update(ChatMessage)
                .where(
                    ChatMessage.id == claim.answer_id,
                    ChatMessage.workspace_id == claim.run.workspace_id,
                    ChatMessage.run_id == claim.run.id,
                    ChatMessage.status == "streaming",
                )
                .values(
                    text=answer.text,
                    citations=[_citation_json(citation) for citation in answer.citations],
                    status="complete",
                )
                .returning(ChatMessage)
            )
            if message is None:
                # The registry fails the run with `internal_error` and never logs this text.
                raise LookupError(
                    f"Answer {claim.answer_id} is no longer written by run {claim.run.id}"
                )
            await session.execute(
                update(LlmRun)
                .where(LlmRun.id == claim.run.id, LlmRun.workspace_id == claim.run.workspace_id)
                .values(output_text=answer.raw)
            )
            return [_done(message)]

        return save

    return work


def _thread_of(principal: Principal, meeting_id: UUID) -> tuple[ColumnElement[bool], ...]:
    return (
        ChatMessage.meeting_id == meeting_id,
        ChatMessage.workspace_id == principal.workspace_id,
    )


def _citation_json(citation: Citation) -> dict[str, object]:
    """One entry of `chat_messages.citations`, and a `citation` event's data."""
    return {
        "ref": citation.ref,
        "segment_id": str(citation.segment_id),
        "start_ms": citation.start_ms,
    }


def _done(message: ChatMessage) -> RunEvent:
    return RunEvent("done", {"message": ChatMessageOut.from_row(message).model_dump(mode="json")})
