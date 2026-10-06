"""Notes runs through the routes: `POST /v1/meetings/{id}/notes/generate` and the run history.

`httpx.ASGITransport` buffers a whole response, so a test here sees a stream once it has ended,
and never a disconnect (M4 plan, Traps). A run held mid-answer by a `ScriptedNotesModel` step is
read from a second session or request while its first request is still waiting. Disconnects and
cancels mid-answer are tested at the service, in test_llm_runs.py.
"""

import asyncio
import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select

from roger_api.auth import default_principal
from roger_api.config import Settings
from roger_api.db.engine import Database
from roger_api.db.models import Meeting
from roger_api.db.models_notes import LlmRun
from roger_api.errors import LlmProviderError
from roger_api.services.llm_runs import LiveRun, LlmRuntime
from roger_api.services.notes_model import ModelDone, ModelUsage
from roger_api.services.notes_model_fake import ModelScript, ScriptedNotesModel
from tests.helpers import Json, append_segments, assert_error, create_meeting, segment_payload

# Bounds every wait below: a bug fails the test instead of hanging `make check`.
WAIT_S = 5.0
POLL_S = 0.02

ANSWER = "## Summary\n- Hello everyone [L1]\n"
SUMMARY_FIELDS = {
    "id",
    "meeting_id",
    "kind",
    "status",
    "model",
    "prompt_version",
    "template_id",
    "line_count",
    "user_notes_version",
    "ai_base_version",
    "error_code",
    "error",
    "dropped",
    "flagged_count",
    "from_notes_count",
    "input_tokens",
    "output_tokens",
    "cached_tokens",
    "cost_usd",
    "started_at",
    "heartbeat_at",
    "finished_at",
}


@dataclass(frozen=True, slots=True)
class Sse:
    event: str
    data: Json


def sse_events(response: httpx.Response) -> list[Sse]:
    """The events of a finished stream, keep-alive comments skipped."""
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    events: list[Sse] = []
    for block in response.text.split("\n\n"):
        fields = dict(
            line.split(": ", 1) for line in block.split("\n") if line and not line.startswith(":")
        )
        if fields:
            events.append(Sse(fields["event"], json.loads(fields["data"])))
    return events


def names(events: list[Sse]) -> list[str]:
    return [event.event for event in events]


def database_of(app: FastAPI) -> Database:
    database = app.state.database
    assert isinstance(database, Database)
    return database


def use_model(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch, *scripts: ModelScript
) -> ScriptedNotesModel:
    """Every notes run of the app answers with `scripts`, in order."""
    model = ScriptedNotesModel(*scripts, model_id="vendor/model")
    monkeypatch.setattr(runtime_of(app), "notes_model", model)
    return model


def runtime_of(app: FastAPI) -> LlmRuntime:
    runtime = app.state.llm_runtime
    assert isinstance(runtime, LlmRuntime)
    return runtime


async def until(condition: Callable[[], bool]) -> None:
    """Polls `condition` until it holds, for at most WAIT_S."""
    async with asyncio.timeout(WAIT_S):
        while True:
            if condition():
                return
            await asyncio.sleep(POLL_S)


async def meeting_with_lines(client: httpx.AsyncClient, *texts: str) -> Json:
    meeting = await create_meeting(client)
    lines = texts or ("Hello everyone.",)
    await append_segments(
        client,
        meeting["id"],
        *(
            segment_payload(text=text, start_ms=1_000 * number, end_ms=1_000 * number + 500)
            for number, text in enumerate(lines, start=1)
        ),
    )
    return meeting


def generate_body(
    run_id: UUID | None = None,
    *,
    template_id: str = "general",
    user_notes_version: int = 0,
    ai_base_version: int = 0,
) -> Json:
    return {
        "run_id": str(run_id or uuid4()),
        "template_id": template_id,
        "user_notes_version": user_notes_version,
        "ai_base_version": ai_base_version,
    }


async def post_generate(
    client: httpx.AsyncClient, meeting_id: object, body: Json | None = None
) -> httpx.Response:
    return await client.post(
        f"/v1/meetings/{meeting_id}/notes/generate", json=body or generate_body()
    )


async def generate(client: httpx.AsyncClient, meeting_id: object, body: Json) -> list[Sse]:
    return sse_events(await post_generate(client, meeting_id, body))


def doc_saying(*paragraphs: str) -> Json:
    return {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]}
            for text in paragraphs
        ],
    }


async def save_note(
    client: httpx.AsyncClient, meeting_id: object, kind: str, doc: Json, *, base_version: int = 0
) -> Json:
    response = await client.put(
        f"/v1/meetings/{meeting_id}/notes/{kind}",
        json={"doc": doc, "base_version": base_version, "revision_id": str(uuid4())},
    )
    assert response.status_code == 200, response.text
    note: Json = response.json()
    return note


async def get_ai_note(client: httpx.AsyncClient, meeting_id: object) -> Json | None:
    response = await client.get(f"/v1/meetings/{meeting_id}/notes")
    assert response.status_code == 200, response.text
    note: Json | None = response.json()["ai"]
    return note


async def get_run(client: httpx.AsyncClient, meeting_id: object, run_id: object) -> Json:
    response = await client.get(f"/v1/meetings/{meeting_id}/runs/{run_id}")
    assert response.status_code == 200, response.text
    run: Json = response.json()
    assert set(run) == SUMMARY_FIELDS | {"output_doc", "replaced_doc"}
    return run


async def count_runs(app: FastAPI) -> int:
    async with database_of(app).session() as session:
        count = await session.scalar(select(func.count()).select_from(LlmRun))
    return count or 0


async def add_run_row(
    app: FastAPI, *, workspace_id: UUID, meeting_id: UUID, status: str = "succeeded"
) -> UUID:
    run_id = uuid4()
    async with database_of(app).session() as session:
        session.add(
            LlmRun(
                id=run_id,
                workspace_id=workspace_id,
                meeting_id=meeting_id,
                kind="notes",
                status=status,
                model="vendor/model",
                prompt_version="notes-test",
                template_id="general",
                line_count=1,
                ref_map={},
            )
        )
        await session.commit()
    return run_id


async def workspace_of(app: FastAPI, meeting_id: UUID) -> UUID:
    async with database_of(app).session() as session:
        meeting = await session.get(Meeting, meeting_id)
    assert meeting is not None
    return meeting.workspace_id


# --- Generate ----------------------------------------------------------------------------------


async def test_claimed_run_is_visible_from_a_second_session_before_the_first_event(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The claim commits in its own session before the stream starts. Claimed through the request's
    # session instead, the row would stay invisible to every other session (the registry's
    # heartbeat and save among them) until the stream ended.
    meeting = await meeting_with_lines(client)
    hold = asyncio.Event()
    model = use_model(app, monkeypatch, ModelScript(steps=(hold, ANSWER)))
    run_id = uuid4()
    request = asyncio.create_task(post_generate(client, meeting["id"], generate_body(run_id)))

    await until(lambda: model.open_streams == 1)
    async with database_of(app).session() as session:
        run = await session.get(LlmRun, run_id)
    assert run is not None
    assert run.status == "running"
    assert not request.done()

    hold.set()
    events = sse_events(await request)
    assert names(events) == ["run", "section", "item", "done"]


async def test_vendor_refusal_before_streaming_is_a_502_envelope(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    meeting = await meeting_with_lines(client)
    use_model(
        app,
        monkeypatch,
        ModelScript(refuse=LlmProviderError("The notes model's provider refused the request")),
    )
    run_id = uuid4()

    response = await post_generate(client, meeting["id"], generate_body(run_id))

    message = assert_error(response, 502, "llm_provider_error")
    assert message == "The notes model's provider refused the request"
    run = await get_run(client, meeting["id"], run_id)
    assert (run["status"], run["error_code"]) == ("failed", "llm_provider_error")


async def test_resent_run_id_of_a_refused_run_replays_the_failure(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    meeting = await meeting_with_lines(client)
    model = use_model(app, monkeypatch, ModelScript(refuse=LlmProviderError("Refused")))
    body = generate_body()
    assert_error(await post_generate(client, meeting["id"], body), 502, "llm_provider_error")

    events = await generate(client, meeting["id"], body)

    assert names(events) == ["run", "error"]
    assert events[1].data == {"code": "llm_provider_error", "message": "Refused"}
    assert len(model.requests) == 1


async def test_vendor_error_mid_stream_is_an_error_event_and_a_failed_run(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    meeting = await meeting_with_lines(client)
    use_model(
        app,
        monkeypatch,
        ModelScript(steps=(ANSWER,), end=LlmProviderError("The provider dropped the stream")),
    )
    run_id = uuid4()

    events = await generate(client, meeting["id"], generate_body(run_id))

    assert names(events) == ["run", "section", "item", "error"]
    assert events[-1].data == {
        "code": "llm_provider_error",
        "message": "The provider dropped the stream",
    }
    run = await get_run(client, meeting["id"], run_id)
    assert (run["status"], run["error_code"], run["output_doc"]) == (
        "failed",
        "llm_provider_error",
        None,
    )
    assert await get_ai_note(client, meeting["id"]) is None


async def test_events_carry_the_contract_fields(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    meeting = await meeting_with_lines(client)
    await save_note(client, meeting["id"], "user", doc_saying("Ask about pricing"))
    use_model(
        app,
        monkeypatch,
        ModelScript(steps=(ANSWER + "- No source here\n- Ask about pricing [N1]\n",)),
    )
    run_id = uuid4()

    events = await generate(client, meeting["id"], generate_body(run_id, user_notes_version=1))

    assert names(events) == ["run", "section", "item", "dropped", "from_notes", "done"]
    run, section, item, dropped, from_notes, done = (event.data for event in events)
    assert run == {
        "run_id": str(run_id),
        "model": "vendor/model",
        "template_id": "general",
        "line_count": 1,
    }
    assert section == {"index": 0, "heading": "Summary"}
    assert set(item) == {"section", "text", "citations", "support"}
    assert [set(citation) for citation in item["citations"]] == [{"ref", "segment_id", "start_ms"}]
    assert dropped == {"text": "No source here", "reason": "no_refs"}
    assert from_notes == {"text": "Ask about pricing"}
    assert done["run_id"] == str(run_id)
    assert done["note"] == await get_ai_note(client, meeting["id"])


async def test_second_run_while_one_is_running_is_a_conflict(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    meeting = await meeting_with_lines(client)
    hold = asyncio.Event()
    model = use_model(app, monkeypatch, ModelScript(steps=(hold, ANSWER)))
    first = asyncio.create_task(post_generate(client, meeting["id"]))
    await until(lambda: model.open_streams == 1)

    response = await post_generate(client, meeting["id"])

    assert_error(response, 409, "conflict")
    hold.set()
    assert names(sse_events(await first))[-1] == "done"
    assert await count_runs(app) == 1


async def test_stale_ai_base_version_is_a_conflict(app: FastAPI, client: httpx.AsyncClient) -> None:
    meeting = await meeting_with_lines(client)
    await save_note(client, meeting["id"], "ai", doc_saying("Edited on another Mac"))

    response = await post_generate(client, meeting["id"], generate_body(ai_base_version=0))

    assert_error(response, 409, "conflict")
    assert await count_runs(app) == 0


async def test_stale_user_notes_version_is_a_conflict(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    meeting = await meeting_with_lines(client)
    note = await save_note(client, meeting["id"], "user", doc_saying("First"))
    await save_note(client, meeting["id"], "user", doc_saying("Second"), base_version=1)

    response = await post_generate(
        client, meeting["id"], generate_body(user_notes_version=note["version"])
    )

    assert_error(response, 409, "conflict")
    assert await count_runs(app) == 0


async def test_versions_are_stored_on_the_run(app: FastAPI, client: httpx.AsyncClient) -> None:
    meeting = await meeting_with_lines(client)
    await save_note(client, meeting["id"], "user", doc_saying("Pricing"))
    await save_note(client, meeting["id"], "user", doc_saying("Pricing, renewal"), base_version=1)
    await save_note(client, meeting["id"], "ai", doc_saying("Older notes"))
    run_id = uuid4()

    events = await generate(
        client, meeting["id"], generate_body(run_id, user_notes_version=2, ai_base_version=1)
    )

    assert names(events)[-1] == "done"
    run = await get_run(client, meeting["id"], run_id)
    assert (run["user_notes_version"], run["ai_base_version"]) == (2, 1)
    note = await get_ai_note(client, meeting["id"])
    assert note is not None
    assert (note["version"], note["generated_version"], note["last_run_id"]) == (2, 2, str(run_id))


async def test_resent_run_id_of_a_running_run_attaches(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    meeting = await meeting_with_lines(client)
    hold = asyncio.Event()
    model = use_model(app, monkeypatch, ModelScript(steps=("## Summary\n", hold, ANSWER)))
    body = generate_body()
    first = asyncio.create_task(post_generate(client, meeting["id"], body))
    await until(lambda: model.open_streams == 1)

    # Released only once the re-send has found the live run: from then on its stream gets every
    # event, buffered or not, whenever it subscribes.
    runtime = runtime_of(app)
    found = asyncio.Event()
    find = runtime.find

    def find_and_tell(workspace_id: UUID, run_id: UUID) -> LiveRun | None:
        live = find(workspace_id, run_id)
        if live is not None:
            found.set()
        return live

    monkeypatch.setattr(runtime, "find", find_and_tell)
    second = asyncio.create_task(post_generate(client, meeting["id"], body))
    async with asyncio.timeout(WAIT_S):
        await found.wait()
    hold.set()

    first_events, second_events = sse_events(await first), sse_events(await second)
    assert names(second_events) == ["run", "section", "item", "done"]
    assert second_events == first_events
    assert len(model.requests) == 1


async def test_resent_run_id_replays_the_stored_result(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    meeting = await meeting_with_lines(client)
    model = use_model(app, monkeypatch, ModelScript(steps=(ANSWER + "- Unsourced\n",)))
    body = generate_body()
    first = await generate(client, meeting["id"], body)

    replayed = await generate(client, meeting["id"], body)

    assert names(replayed) == ["run", "dropped", "done"]
    assert [replayed[0], replayed[1]] == [first[0], first[3]]
    assert replayed[-1].data["note"] == await get_ai_note(client, meeting["id"])
    assert len(model.requests) == 1


async def test_run_id_of_another_meeting_is_a_conflict_and_replays_nothing(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = await meeting_with_lines(client)
    second = await meeting_with_lines(client)
    use_model(app, monkeypatch, ModelScript(steps=(ANSWER,)))
    body = generate_body()
    await generate(client, first["id"], body)

    response = await post_generate(client, second["id"], body)

    assert_error(response, 409, "conflict")
    assert await get_ai_note(client, second["id"]) is None


async def test_run_id_of_another_workspace_is_a_conflict_and_replays_nothing(
    app: FastAPI, client: httpx.AsyncClient, foreign_meeting_id: UUID
) -> None:
    meeting = await meeting_with_lines(client)
    foreign_run = await add_run_row(
        app,
        workspace_id=await workspace_of(app, foreign_meeting_id),
        meeting_id=foreign_meeting_id,
    )

    response = await post_generate(client, meeting["id"], generate_body(foreign_run))

    message = assert_error(response, 409, "conflict")
    assert str(foreign_meeting_id) not in message
    assert await get_ai_note(client, meeting["id"]) is None


async def test_unknown_template_is_a_validation_error(client: httpx.AsyncClient) -> None:
    meeting = await meeting_with_lines(client)

    response = await post_generate(client, meeting["id"], generate_body(template_id="retro"))

    message = assert_error(response, 422, "validation_error")
    assert "body.template_id" in message


async def test_meeting_with_no_lines_and_no_notes_is_empty_meeting(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    meeting = await create_meeting(client)
    # A user note with no words in it counts as no notes.
    await save_note(
        client, meeting["id"], "user", {"type": "doc", "content": [{"type": "paragraph"}]}
    )

    response = await post_generate(client, meeting["id"], generate_body(user_notes_version=1))

    assert_error(response, 422, "empty_meeting")
    assert await count_runs(app) == 0


async def test_notes_only_meeting_generates_from_notes(client: httpx.AsyncClient) -> None:
    # The default fake model answers every note block as a bullet citing it (notes_model_fake.py).
    meeting = await create_meeting(client)
    await save_note(
        client, meeting["id"], "user", doc_saying("Ask Acme about the Q3 renewal", "Book a demo")
    )

    events = await generate(client, meeting["id"], generate_body(user_notes_version=1))

    assert names(events) == ["run", "from_notes", "from_notes", "done"]
    assert events[0].data["line_count"] == 0
    doc = events[-1].data["note"]["doc"]
    headings = [node for node in doc["content"] if node["type"] == "heading"]
    assert [heading["content"][0]["text"] for heading in headings] == ["From your notes"]


async def test_generate_for_a_meeting_in_another_workspace_is_not_found(
    client: httpx.AsyncClient, foreign_meeting_id: UUID
) -> None:
    assert_error(await post_generate(client, foreign_meeting_id), 404, "not_found")


# --- Runs --------------------------------------------------------------------------------------


async def test_get_run_returns_the_replaced_doc(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    meeting = await meeting_with_lines(client)
    previous = doc_saying("The notes before this run")
    await save_note(client, meeting["id"], "ai", previous)
    use_model(app, monkeypatch, ModelScript(steps=(ANSWER,)))
    run_id = uuid4()
    await generate(client, meeting["id"], generate_body(run_id, ai_base_version=1))

    run = await get_run(client, meeting["id"], run_id)

    assert run["replaced_doc"] == previous
    note = await get_ai_note(client, meeting["id"])
    assert note is not None
    assert run["output_doc"] == note["doc"]


async def test_get_run_of_a_first_run_has_both_doc_keys(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The desktop refuses a run read without them (notesClient.ts, `runDocFromWire`).
    meeting = await meeting_with_lines(client)
    use_model(
        app,
        monkeypatch,
        ModelScript(
            steps=(ANSWER,),
            end=ModelDone(
                usage=ModelUsage(
                    input_tokens=900,
                    output_tokens=120,
                    cached_tokens=0,
                    reasoning_tokens=0,
                    cost_usd=None,
                )
            ),
        ),
    )
    run_id = uuid4()
    await generate(client, meeting["id"], generate_body(run_id))

    run = await get_run(client, meeting["id"], run_id)

    assert run["replaced_doc"] is None
    assert run["output_doc"] is not None
    assert (run["input_tokens"], run["output_tokens"], run["cost_usd"]) == (900, 120, None)
    assert (run["dropped"], run["flagged_count"], run["from_notes_count"]) == ([], 0, 0)


async def test_runs_are_listed_newest_first_by_kind_with_a_limit(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    meeting = await meeting_with_lines(client)
    use_model(app, monkeypatch, ModelScript(steps=(ANSWER,)), ModelScript(steps=(ANSWER,)))
    first, second = uuid4(), uuid4()
    await generate(client, meeting["id"], generate_body(first))
    await generate(client, meeting["id"], generate_body(second, ai_base_version=1))

    response = await client.get(f"/v1/meetings/{meeting['id']}/runs", params={"kind": "notes"})
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert [item["id"] for item in items] == [str(second), str(first)]
    assert all(set(item) == SUMMARY_FIELDS for item in items)

    limited = await client.get(f"/v1/meetings/{meeting['id']}/runs", params={"limit": 1})
    assert [item["id"] for item in limited.json()["items"]] == [str(second)]
    chats = await client.get(f"/v1/meetings/{meeting['id']}/runs", params={"kind": "chat"})
    assert chats.json() == {"items": []}


async def test_cost_is_a_decimal_string(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    meeting = await meeting_with_lines(client)
    usage = ModelUsage(
        input_tokens=1, output_tokens=1, cached_tokens=None, reasoning_tokens=None, cost_usd=None
    )
    use_model(app, monkeypatch, ModelScript(steps=(ANSWER,), end=ModelDone(usage=usage)))
    run_id = uuid4()
    await generate(client, meeting["id"], generate_body(run_id))
    async with database_of(app).session() as session:
        run = await session.get(LlmRun, run_id)
        assert run is not None
        run.cost_usd = Decimal("0.00083")
        await session.commit()

    fetched = await get_run(client, meeting["id"], run_id)

    assert fetched["cost_usd"] == "0.00083"


async def test_cancel_stops_a_running_run(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    meeting = await meeting_with_lines(client)
    hold = asyncio.Event()
    model = use_model(app, monkeypatch, ModelScript(steps=("## Summary\n", hold, ANSWER)))
    run_id = uuid4()
    request = asyncio.create_task(post_generate(client, meeting["id"], generate_body(run_id)))
    await until(lambda: model.open_streams == 1)

    response = await client.post(f"/v1/meetings/{meeting['id']}/runs/{run_id}/cancel")

    assert response.status_code == 200, response.text
    cancelled = response.json()
    assert set(cancelled) == SUMMARY_FIELDS
    assert (cancelled["status"], cancelled["error_code"]) == ("cancelled", "cancelled")
    events = sse_events(await request)
    assert names(events)[-1] == "error"
    assert events[-1].data["code"] == "cancelled"
    assert model.open_streams == 0
    assert await get_ai_note(client, meeting["id"]) is None


async def test_cancel_of_a_finished_run_returns_it_as_it_ended(
    app: FastAPI, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    meeting = await meeting_with_lines(client)
    use_model(app, monkeypatch, ModelScript(steps=(ANSWER,)))
    run_id = uuid4()
    await generate(client, meeting["id"], generate_body(run_id))

    response = await client.post(f"/v1/meetings/{meeting['id']}/runs/{run_id}/cancel")

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "succeeded"


async def test_cancel_with_a_foreign_run_id_is_not_found(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings, foreign_meeting_id: UUID
) -> None:
    meeting = await meeting_with_lines(client)
    other = await meeting_with_lines(client)
    workspace_id = default_principal(settings).workspace_id
    other_meetings_run = await add_run_row(
        app, workspace_id=workspace_id, meeting_id=UUID(other["id"]), status="running"
    )
    foreign_run = await add_run_row(
        app,
        workspace_id=await workspace_of(app, foreign_meeting_id),
        meeting_id=foreign_meeting_id,
        status="running",
    )

    for run_id in (other_meetings_run, foreign_run, uuid4()):
        response = await client.post(f"/v1/meetings/{meeting['id']}/runs/{run_id}/cancel")
        assert_error(response, 404, "not_found")
    async with database_of(app).session() as session:
        statuses = await session.scalars(
            select(LlmRun.status).where(LlmRun.id.in_([other_meetings_run, foreign_run]))
        )
        assert set(statuses) == {"running"}


async def test_runs_of_a_meeting_in_another_workspace_are_not_found(
    app: FastAPI, client: httpx.AsyncClient, foreign_meeting_id: UUID
) -> None:
    foreign_run = await add_run_row(
        app,
        workspace_id=await workspace_of(app, foreign_meeting_id),
        meeting_id=foreign_meeting_id,
    )

    assert_error(await client.get(f"/v1/meetings/{foreign_meeting_id}/runs"), 404, "not_found")
    assert_error(
        await client.get(f"/v1/meetings/{foreign_meeting_id}/runs/{foreign_run}"), 404, "not_found"
    )


async def test_a_run_of_another_meeting_is_not_found_under_this_one(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings
) -> None:
    meeting = await meeting_with_lines(client)
    other = await meeting_with_lines(client)
    run_id = await add_run_row(
        app,
        workspace_id=default_principal(settings).workspace_id,
        meeting_id=UUID(other["id"]),
    )

    assert_error(await client.get(f"/v1/meetings/{meeting['id']}/runs/{run_id}"), 404, "not_found")


async def test_a_run_started_long_ago_lists_its_times_in_utc(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings
) -> None:
    meeting = await meeting_with_lines(client)
    run_id = await add_run_row(
        app, workspace_id=default_principal(settings).workspace_id, meeting_id=UUID(meeting["id"])
    )
    async with database_of(app).session() as session:
        run = await session.get(LlmRun, run_id)
        assert run is not None
        run.started_at = datetime(2026, 10, 6, 9, 30, tzinfo=UTC)
        await session.commit()

    fetched = await get_run(client, meeting["id"], run_id)

    assert fetched["started_at"] == "2026-10-06T09:30:00Z"
