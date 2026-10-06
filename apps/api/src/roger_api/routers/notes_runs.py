"""Notes generation and run routes (M4-T8): generate the AI notes as a stream, read the run
history, cancel a run.

app.py includes `router` once (P2-F2); its prefix, tags and routes live here, never in app.py.
Every route resolves the `Principal` first (`PrincipalDep`, its first dependency): FastAPI solves
dependencies before it validates the body or the query, so a request without the token is a 401,
never a 422. tests/test_auth.py fails any route that answers without a token.

Traps (routers/chat.py streams the same way and says the same; change the two together):
- Anything raised inside an SSE generator arrives after the `200` headers, as no envelope at all.
  So the meeting, the preconditions, the claim and the vendor's opening are all done in the
  `claim_notes_run` dependency, before the generator runs: a `404`, `409`, `422` or `502` reaches
  the client as its envelope.
- That dependency opens its own session from `DatabaseDep` and commits before it returns
  (`notes_generation.start_notes_run`); it never takes `SessionDep`. A request-scoped `yield`
  dependency (`SessionDep`) exits only after the streaming response ends (FastAPI 0.142), so a
  claim through it would hold its transaction for the whole stream, and the run registry's own
  sessions would never see the run row. It is declared `scope="function"` so that, if it ever
  yields, it still exits before the response: a function-scoped dependency may use request-scoped
  ones (`PrincipalDep`), never the reverse (FastAPI raises `DependencyScopeError`).
- Use FastAPI's own SSE (`EventSourceResponse`, `ServerSentEvent`, a `: ping` every 15 s).
  `sse-starlette` and `httpx2` arrive with `mcp` but are undeclared: never import them.
- `httpx.ASGITransport` buffers a whole response, so a test through these routes sees a finished
  stream and never a disconnect. Test disconnects and cancels at the service (test_llm_runs.py).
"""

from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.sse import EventSourceResponse, ServerSentEvent

from roger_api.auth import PrincipalDep
from roger_api.dependencies import DatabaseDep, SessionDep, SettingsDep
from roger_api.domain import RunKind
from roger_api.routers.responses import ERROR_RESPONSES, NOT_FOUND
from roger_api.schemas.common import ErrorEnvelope
from roger_api.schemas.notes_runs import LlmRunDetail, LlmRunList, LlmRunOut, NotesGenerate
from roger_api.services import notes_generation
from roger_api.services.llm_runs import LlmRuntimeDep
from roger_api.services.notes_generation import NotesRunStream

router = APIRouter(prefix="/v1/meetings", tags=["notes"], responses=ERROR_RESPONSES)

_RUN_NOT_FOUND: dict[int | str, dict[str, Any]] = {
    404: {
        "model": ErrorEnvelope,
        "description": "Unknown meeting or run, or one of another meeting or workspace",
    }
}
_GENERATE_RESPONSES: dict[int | str, dict[str, Any]] = {
    **NOT_FOUND,
    409: {
        "model": ErrorEnvelope,
        "description": "A notes run of the meeting is running; a version is not the stored one; "
        "or the run id is stored under another meeting or workspace (nothing is replayed)",
    },
    422: {
        "model": ErrorEnvelope,
        "description": "validation_error (an unknown template among them), or empty_meeting: "
        "no transcript lines and no notes",
    },
    502: {
        "model": ErrorEnvelope,
        "description": "llm_provider_error: the notes model's vendor refused before the stream",
    },
}


async def claim_notes_run(
    principal: PrincipalDep,
    meeting_id: UUID,
    body: NotesGenerate,
    database: DatabaseDep,
    runtime: LlmRuntimeDep,
    settings: SettingsDep,
) -> NotesRunStream:
    """Claims and starts the run, or finds the one a re-sent `run_id` names (see the traps)."""
    return await notes_generation.start_notes_run(
        database,
        runtime,
        principal,
        meeting_id,
        run_id=body.run_id,
        template=body.template,
        user_notes_version=body.user_notes_version,
        ai_base_version=body.ai_base_version,
        max_input_tokens=settings.notes_max_input_tokens,
    )


@router.post(
    "/{meeting_id}/notes/generate",
    response_class=EventSourceResponse,
    responses=_GENERATE_RESPONSES,
)
async def generate_notes(
    stream: Annotated[NotesRunStream, Depends(claim_notes_run, scope="function")],
) -> AsyncIterator[ServerSentEvent]:
    # Only reads what the dependency started: nothing here can refuse the request any more.
    async with aclosing(stream.events()) as events:
        async for event in events:
            yield ServerSentEvent(event=event.name, data=event.data)


@router.get("/{meeting_id}/runs", responses=NOT_FOUND)
async def list_runs(
    principal: PrincipalDep,
    meeting_id: UUID,
    session: SessionDep,
    kind: Annotated[RunKind | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 10,
) -> LlmRunList:
    runs = await notes_generation.list_runs(session, principal, meeting_id, kind=kind, limit=limit)
    return LlmRunList(items=[LlmRunOut.from_row(run) for run in runs])


@router.get("/{meeting_id}/runs/{run_id}", responses=_RUN_NOT_FOUND)
async def get_run(
    principal: PrincipalDep, meeting_id: UUID, run_id: UUID, session: SessionDep
) -> LlmRunDetail:
    run = await notes_generation.get_run(session, principal, meeting_id, run_id)
    return LlmRunDetail.from_row(run)


@router.post("/{meeting_id}/runs/{run_id}/cancel", responses=_RUN_NOT_FOUND)
async def cancel_run(
    principal: PrincipalDep,
    meeting_id: UUID,
    run_id: UUID,
    database: DatabaseDep,
    runtime: LlmRuntimeDep,
) -> LlmRunOut:
    # Sessions of its own, never `SessionDep`: the cancel waits for the run to write its ending.
    run = await notes_generation.cancel_run(database, runtime, principal, meeting_id, run_id)
    return LlmRunOut.from_row(run)
