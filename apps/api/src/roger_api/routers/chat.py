"""Chat with one meeting (M4-T10): its thread, and a question answered as server-sent events
(docs/api-contract.md, "Chat"; the logic is services/chat.py).

app.py includes `router` once (P2-F2); its prefix, tags and routes live here, never in app.py.
Every route resolves the `Principal` first (`PrincipalDep`); tests/test_auth.py fails any route
that answers without a token.

Traps, shared with routers/notes_runs.py (each file points at the other):
- Anything raised inside the SSE generator arrives after the `200` headers, as a stream that
  breaks off instead of the error envelope. So `_answer_stream`, a dependency, checks the meeting,
  claims the answer and opens the model before `ask` yields anything: the 404, 409, 422 and 502
  envelopes still reach the client.
- That dependency is `Depends(..., scope="function")` and opens its own session from
  `DatabaseDep`, committing and closing it before the model is opened. A request-scoped `yield`
  dependency (`SessionDep`) exits only after the stream ends (FastAPI 0.142.2): the claim's
  transaction would stay open for the whole answer, held across the vendor call (CLAUDE.md failure
  log), and the run registry's own sessions would never see the run row. A function-scoped
  dependency may use request-scoped ones (`PrincipalDep`), never the reverse (FastAPI raises
  DependencyScopeError).
- `httpx.ASGITransport` buffers whole responses, so tests through it never see a disconnect, a
  cancel or a re-send attaching mid-answer: those are tested at the service (tests/test_llm_runs.py
  and tests/test_chat_api.py's attach test).
"""

from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.sse import EventSourceResponse, ServerSentEvent

from roger_api.auth import PrincipalDep
from roger_api.dependencies import DatabaseDep, SessionDep, SettingsDep
from roger_api.routers.responses import ERROR_RESPONSES, NOT_FOUND
from roger_api.schemas.chat import ChatAsk, ChatMessageOut, ChatThread
from roger_api.schemas.common import ErrorEnvelope
from roger_api.services import chat
from roger_api.services.llm_runs import LlmRuntimeDep

router = APIRouter(prefix="/v1/meetings", tags=["chat"], responses=ERROR_RESPONSES)

# The most messages one read of the thread returns.
MAX_THREAD_LIMIT = 200


@router.get("/{meeting_id}/chat", responses=NOT_FOUND)
async def get_thread(
    meeting_id: UUID,
    principal: PrincipalDep,
    session: SessionDep,
    limit: Annotated[int, Query(ge=1, le=MAX_THREAD_LIMIT)] = 50,
) -> ChatThread:
    messages = await chat.list_thread(session, principal, meeting_id, limit=limit)
    return ChatThread(items=[ChatMessageOut.from_row(message) for message in messages])


async def _answer_stream(
    meeting_id: UUID,
    body: ChatAsk,
    principal: PrincipalDep,
    database: DatabaseDep,
    runtime: LlmRuntimeDep,
    settings: SettingsDep,
) -> chat.AnswerStream:
    # Its own session, committed and closed before the model opens (the module's traps).
    async with database.session() as session:
        claim = await chat.claim_answer(
            session,
            runtime,
            principal,
            meeting_id,
            message_id=body.message_id,
            text=body.text,
            max_input_tokens=settings.notes_max_input_tokens,
        )
        await session.commit()
    return await chat.start_answer(runtime, claim)


@router.post(
    "/{meeting_id}/chat",
    response_class=EventSourceResponse,
    responses={
        **NOT_FOUND,
        409: {
            "model": ErrorEnvelope,
            "description": "message_id is stored under another meeting or workspace, or its "
            "answer is being written by another API process",
        },
        422: {
            "model": ErrorEnvelope,
            "description": "Body failed validation (validation_error), or the meeting is over "
            "the chat budget (meeting_too_long)",
        },
        502: {
            "model": ErrorEnvelope,
            "description": "The model's vendor refused before the stream started",
        },
    },
)
async def ask(
    answer: Annotated[chat.AnswerStream, Depends(_answer_stream, scope="function")],
) -> AsyncIterator[ServerSentEvent]:
    async with aclosing(answer.events()) as events:
        async for event in events:
            yield ServerSentEvent(event=event.name, data=dict(event.data))
