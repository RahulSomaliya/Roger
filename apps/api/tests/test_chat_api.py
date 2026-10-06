"""Chat with one meeting: `GET /v1/meetings/{id}/chat` and `POST .../chat` (M4-T10).

`httpx.ASGITransport` buffers a whole response, so a POST here returns once its stream has ended;
a test that needs a run mid-answer starts the POST as a task and holds the model on an
`asyncio.Event` (`ScriptedNotesModel`). Disconnects and cancels are the run registry's, tested at
the service in test_llm_runs.py.
"""

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from asgi_lifespan import LifespanManager
from fastapi import FastAPI
from sqlalchemy import func, select, update

from roger_api.app import create_app
from roger_api.auth import default_principal
from roger_api.config_notes import NotesSettings
from roger_api.db.engine import Database
from roger_api.db.models import Meeting
from roger_api.db.models_notes import ChatMessage, ChatMessageStatus, ChatRole, LlmRun
from roger_api.errors import LlmProviderError
from roger_api.services import chat, llm_runs
from roger_api.services.chat_prompt import CHAT_HISTORY_EXCHANGES, CHAT_PROMPT_VERSION
from roger_api.services.llm_runs import STALE_AFTER
from roger_api.services.notes_model import ModelDone, ModelUsage, NotesModel
from roger_api.services.notes_model_fake import ModelScript, ScriptedNotesModel
from tests.conftest import make_settings
from tests.helpers import (
    AUTH_HEADERS,
    BASE_URL,
    Json,
    append_segments,
    assert_error,
    create_meeting,
    segment_payload,
)

# Bounds every wait below: a bug fails the test instead of hanging `make check`.
WAIT_S = 5.0
POLL_S = 0.02

MESSAGE_FIELDS = {"id", "role", "text", "citations", "reply_to", "run_id", "status", "created_at"}
LINES = [
    ("mic", "me", 3_000, "Beta ships Friday."),
    ("system", "them", 7_000, "Pricing stays at fifty thousand."),
    ("mic", "me", 12_000, "Let's wrap up."),
]

type Events = list[tuple[str, Json]]


@dataclass(frozen=True, slots=True)
class SeededMeeting:
    id: str
    segment_ids: list[str]


@dataclass(frozen=True, slots=True)
class ChatApi:
    app: FastAPI
    client: httpx.AsyncClient

    @property
    def database(self) -> Database:
        database = self.app.state.database
        assert isinstance(database, Database)
        return database


type OpenApi = Callable[..., AbstractAsyncContextManager[ChatApi]]


@pytest.fixture
def open_api(database_url: str, clean_database: None, monkeypatch: pytest.MonkeyPatch) -> OpenApi:
    """An app whose runs use `model` (section 10: tests inject the model through
    `services.llm_runs.open_notes_model`), with settings `overrides`."""

    @asynccontextmanager
    async def open_api(model: NotesModel, **overrides: object) -> AsyncIterator[ChatApi]:
        @asynccontextmanager
        async def open_model(_settings: NotesSettings) -> AsyncIterator[NotesModel]:
            yield model

        monkeypatch.setattr(llm_runs, "open_notes_model", open_model)
        app = create_app(make_settings(database_url, **overrides))
        async with (
            LifespanManager(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url=BASE_URL, headers=AUTH_HEADERS
            ) as client,
        ):
            yield ChatApi(app, client)

    return open_api


async def add_meeting(
    client: httpx.AsyncClient, lines: list[tuple[str, str, int, str]]
) -> SeededMeeting:
    meeting = await create_meeting(client)
    segments = [
        segment_payload(
            source=source, speaker=speaker, start_ms=start, end_ms=start + 900, text=text
        )
        for source, speaker, start, text in lines
    ]
    if segments:
        await append_segments(client, meeting["id"], *segments)
    return SeededMeeting(id=meeting["id"], segment_ids=[segment["id"] for segment in segments])


def get_llm_runtime_of(app: FastAPI) -> llm_runs.LlmRuntime:
    runtime = app.state.llm_runtime
    assert isinstance(runtime, llm_runs.LlmRuntime)
    return runtime


def chat_path(meeting_id: object) -> str:
    return f"/v1/meetings/{meeting_id}/chat"


async def ask(
    client: httpx.AsyncClient, meeting_id: object, text: str, message_id: UUID | None = None
) -> httpx.Response:
    body = {"message_id": str(message_id or uuid4()), "text": text}
    return await client.post(chat_path(meeting_id), json=body)


def events_of(response: httpx.Response) -> Events:
    """The SSE events of a finished stream, as (event, data) pairs; `: ping` comments skipped."""
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    events: Events = []
    for block in response.text.split("\n\n"):
        name = None
        data: list[str] = []
        for line in block.split("\n"):
            if line.startswith("event: "):
                name = line.removeprefix("event: ")
            elif line.startswith("data: "):
                data.append(line.removeprefix("data: "))
        if name is not None:
            events.append((name, json.loads("\n".join(data))))
    return events


def names(events: Events) -> list[str]:
    return [name for name, _ in events]


def text_of(events: Events) -> str:
    return "".join(data["text"] for name, data in events if name == "delta")


def done_message(events: Events) -> Json:
    assert events[-1][0] == "done", events
    message: Json = events[-1][1]["message"]
    assert set(message) == MESSAGE_FIELDS
    return message


async def thread(
    client: httpx.AsyncClient, meeting_id: object, limit: int | None = None
) -> list[Json]:
    query = "" if limit is None else f"?limit={limit}"
    response = await client.get(chat_path(meeting_id) + query)
    assert response.status_code == 200, response.text
    body: Json = response.json()
    assert set(body) == {"items"}
    items: list[Json] = body["items"]
    for item in items:
        assert set(item) == MESSAGE_FIELDS
    return items


async def chat_runs(database: Database) -> list[LlmRun]:
    async with database.session() as session:
        runs = await session.scalars(
            select(LlmRun).where(LlmRun.kind == "chat").order_by(LlmRun.started_at)
        )
        return list(runs)


async def stored_messages(database: Database) -> list[ChatMessage]:
    async with database.session() as session:
        return list(await session.scalars(select(ChatMessage).order_by(ChatMessage.created_at)))


async def eventually[T](read: Callable[[], Awaitable[T]], done: Callable[[T], bool]) -> T:
    """Reads until `done` holds. The caller's `asyncio.timeout` bounds it."""
    while True:
        value = await read()
        if done(value):
            return value
        await asyncio.sleep(POLL_S)


async def requests_of(model: ScriptedNotesModel) -> int:
    return len(model.requests)


async def streaming_answer(database: Database) -> ChatMessage:
    """The answer row once a POST has claimed it."""
    messages = await eventually(
        lambda: stored_messages(database),
        lambda rows: any(row.role == "assistant" and row.status == "streaming" for row in rows),
    )
    return next(row for row in messages if row.role == "assistant")


# ---------------------------------------------------------------------------- answering


async def test_answer_streams_with_citations_mapped_to_segments(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    meeting = await add_meeting(client, LINES)
    question_id = uuid4()

    events = events_of(await ask(client, meeting.id, "When does the beta ship?", question_id))

    # NOTES_PROVIDER=fake: it answers with the first words of the first two lines, citing each.
    run_name, run = events[0]
    assert run_name == "run"
    assert set(run) == {"run_id", "model"}
    assert run["model"] == "fake"
    assert text_of(events) == ("Beta ships Friday. [L1] Pricing stays at fifty thousand. [L2]")
    citations = [data for name, data in events if name == "citation"]
    assert citations == [
        {"ref": "L1", "segment_id": meeting.segment_ids[0], "start_ms": 3_000},
        {"ref": "L2", "segment_id": meeting.segment_ids[1], "start_ms": 7_000},
    ]
    # A citation arrives once the delta that closes its bracket has been sent.
    first_citation = names(events).index("citation")
    assert "[L1]" in text_of(events[:first_citation])
    answer = done_message(events)
    assert answer["role"] == "assistant"
    assert answer["text"] == "Beta ships Friday. [L1] Pricing stays at fifty thousand. [L2]"
    assert answer["citations"] == citations
    assert answer["reply_to"] == str(question_id)
    assert answer["run_id"] == run["run_id"]
    assert answer["status"] == "complete"
    assert answer["created_at"].endswith("Z")

    question, stored_answer = await thread(client, meeting.id)
    assert question == {
        "id": str(question_id),
        "role": "user",
        "text": "When does the beta ship?",
        "citations": None,
        "reply_to": None,
        "run_id": None,
        "status": "complete",
        "created_at": question["created_at"],
    }
    assert stored_answer == answer

    [stored_run] = await chat_runs(app.state.database)
    assert str(stored_run.id) == run["run_id"]
    assert (stored_run.status, stored_run.model) == ("succeeded", "fake")
    assert (stored_run.prompt_version, stored_run.line_count) == (CHAT_PROMPT_VERSION, 3)
    assert stored_run.template_id is None
    assert stored_run.ref_map == {
        f"L{number}": segment_id for number, segment_id in enumerate(meeting.segment_ids, 1)
    }
    assert stored_run.output_text == answer["text"]
    # The fake model reports no usage: a null cost, never 0.
    assert stored_run.cost_usd is None


async def test_claimed_message_is_visible_from_a_second_session_before_the_first_event(
    open_api: OpenApi,
) -> None:
    hold = asyncio.Event()
    model = ScriptedNotesModel(ModelScript(steps=(hold, "Friday [L1].")))
    async with asyncio.timeout(WAIT_S), open_api(model) as api:
        meeting = await add_meeting(api.client, LINES)
        question_id = uuid4()
        posting = asyncio.create_task(ask(api.client, meeting.id, "When?", question_id))

        # A session of its own, as the run registry's are: it sees the claim while the model has
        # written nothing yet, so the claim was committed before the stream began.
        answer = await streaming_answer(api.database)
        messages = await stored_messages(api.database)
        [run] = await chat_runs(api.database)
        assert [(row.id, row.role, row.status) for row in messages] == [
            (question_id, "user", "complete"),
            (answer.id, "assistant", "streaming"),
        ]
        assert (answer.text, answer.reply_to, answer.run_id) == ("", question_id, run.id)
        assert run.status == "running"
        assert len(model.requests) == 1

        hold.set()
        events = events_of(await posting)

    assert done_message(events)["text"] == "Friday [L1]."


async def test_unknown_refs_are_removed_from_the_stored_answer(open_api: OpenApi) -> None:
    raw = "Beta ships Friday [L1, L9]. Pricing [L42] is set [N1]."
    model = ScriptedNotesModel(
        ModelScript(steps=("Beta ships Friday [L1, ", "L9]. Pricing [L4", "2] is set [N1]."))
    )
    async with open_api(model) as api:
        meeting = await add_meeting(api.client, LINES)
        events = events_of(await ask(api.client, meeting.id, "When?"))
        [run] = await chat_runs(api.database)

    # The stream shows the model's text as written: the desktop keeps a ref without a citation as
    # text until `done` brings the stored answer.
    assert text_of(events) == raw
    assert [data["ref"] for name, data in events if name == "citation"] == ["L1"]
    answer = done_message(events)
    assert answer["text"] == "Beta ships Friday [L1]. Pricing is set."
    assert [citation["ref"] for citation in answer["citations"]] == ["L1"]
    assert run.output_text == raw


async def test_text_postgres_cannot_store_is_dropped_from_the_stored_answer(
    open_api: OpenApi,
) -> None:
    model = ScriptedNotesModel(ModelScript(steps=("Beta\x00 ships \ud800Friday [L1].",)))
    async with open_api(model) as api:
        meeting = await add_meeting(api.client, LINES)
        events = events_of(await ask(api.client, meeting.id, "When\x00 does it ship?"))
        question, answer = await thread(api.client, meeting.id)

    assert done_message(events)["text"] == "Beta ships \ufffdFriday [L1]."
    assert answer["text"] == "Beta ships \ufffdFriday [L1]."
    assert question["text"] == "When does it ship?"


async def test_answer_ends_with_an_error_event_when_the_model_fails_mid_stream(
    open_api: OpenApi,
) -> None:
    failure = LlmProviderError("The notes model's provider stopped answering")
    model = ScriptedNotesModel(ModelScript(steps=("We decided",), end=failure))
    async with open_api(model) as api:
        meeting = await add_meeting(api.client, LINES)
        events = events_of(await ask(api.client, meeting.id, "What did we decide?"))
        _, answer = await thread(api.client, meeting.id)
        [run] = await chat_runs(api.database)

    assert names(events) == ["run", "delta", "error"]
    assert events[-1][1] == {"code": "llm_provider_error", "message": failure.message}
    assert (answer["status"], answer["text"]) == ("failed", "")
    assert (run.status, run.error_code) == ("failed", "llm_provider_error")


async def test_vendor_refusal_before_streaming_is_a_502_envelope(open_api: OpenApi) -> None:
    refusal = LlmProviderError("The notes model's provider refused the request (HTTP 402)")
    model = ScriptedNotesModel(ModelScript(refuse=refusal))
    async with open_api(model) as api:
        meeting = await add_meeting(api.client, LINES)
        response = await ask(api.client, meeting.id, "When?")
        _, answer = await thread(api.client, meeting.id)
        [run] = await chat_runs(api.database)

    assert assert_error(response, 502, "llm_provider_error") == refusal.message
    # Stored as failed, so the same message id sent again answers it anew.
    assert answer["status"] == "failed"
    assert (run.status, run.error_code) == ("failed", "llm_provider_error")


async def test_usage_is_stored_on_the_chat_run(open_api: OpenApi) -> None:
    usage = ModelUsage(
        input_tokens=4_000, output_tokens=60, cached_tokens=3_500, reasoning_tokens=0, cost_usd=None
    )
    model = ScriptedNotesModel(ModelScript(steps=("Friday [L1].",), end=ModelDone(usage=usage)))
    async with open_api(model) as api:
        meeting = await add_meeting(api.client, LINES)
        events_of(await ask(api.client, meeting.id, "When?"))
        [run] = await chat_runs(api.database)

    assert (run.input_tokens, run.output_tokens, run.cached_tokens) == (4_000, 60, 3_500)


# ---------------------------------------------------------------------------- the prompt


async def add_exchange(
    database: Database,
    meeting_id: str,
    number: int,
    at: datetime,
    *,
    answer_status: ChatMessageStatus = "complete",
) -> None:
    """A question and its answer, stored as the claim and the run's save store them: both at the
    same instant, as Postgres's now() is the claim transaction's start."""
    async with database.session() as session:
        meeting = await session.get_one(Meeting, UUID(meeting_id))
        question_id = uuid4()
        rows: list[tuple[UUID, ChatRole, str, UUID | None, ChatMessageStatus]] = [
            (question_id, "user", f"Question {number}?", None, "complete"),
            (uuid4(), "assistant", f"Answer {number} [L1].", question_id, answer_status),
        ]
        for row_id, role, text, reply_to, status in rows:
            session.add(
                ChatMessage(
                    id=row_id,
                    workspace_id=meeting.workspace_id,
                    meeting_id=meeting.id,
                    role=role,
                    text=text,
                    reply_to=reply_to,
                    status=status,
                    created_at=at,
                )
            )
        await session.commit()


async def test_history_is_oldest_first_and_capped_in_the_prompt(open_api: OpenApi) -> None:
    model = ScriptedNotesModel(ModelScript(steps=("Friday [L1].",)))
    async with open_api(model) as api:
        meeting = await add_meeting(api.client, LINES)
        start = datetime.now(UTC) - timedelta(hours=1)
        for number in range(1, 13):
            await add_exchange(api.database, meeting.id, number, start + timedelta(minutes=number))
        # An answer that failed is no part of the thread the model reads.
        await add_exchange(
            api.database, meeting.id, 99, start + timedelta(minutes=30), answer_status="failed"
        )
        events_of(await ask(api.client, meeting.id, "And now?"))

    [request] = model.requests
    turns = [(message.role, message.parts[0].text) for message in request.messages[2:]]
    first = 12 - CHAT_HISTORY_EXCHANGES + 1
    expected: list[tuple[str, str]] = []
    for number in range(first, 13):
        # Refs out: they were numbered against the transcript of that time.
        expected += [("user", f"Question {number}?"), ("assistant", f"Answer {number}.")]
    assert turns == [*expected, ("user", "And now?")]


async def test_thread_is_the_latest_messages_oldest_first(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    meeting = await add_meeting(client, LINES)
    start = datetime.now(UTC) - timedelta(hours=1)
    for number in range(1, 4):
        await add_exchange(
            app.state.database, meeting.id, number, start + timedelta(minutes=number)
        )

    everything = await thread(client, meeting.id)
    latest = await thread(client, meeting.id, limit=3)

    assert [item["text"] for item in everything] == [
        "Question 1?",
        "Answer 1 [L1].",
        "Question 2?",
        "Answer 2 [L1].",
        "Question 3?",
        "Answer 3 [L1].",
    ]
    assert latest == everything[-3:]
    for bad in (0, 201):
        response = await client.get(f"{chat_path(meeting.id)}?limit={bad}")
        assert_error(response, 422, "validation_error")


# ---------------------------------------------------------------------------- re-sends


async def test_resent_message_id_stores_no_second_message(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    meeting = await add_meeting(client, LINES)
    question_id = uuid4()
    first = events_of(await ask(client, meeting.id, "When does the beta ship?", question_id))

    again = events_of(await ask(client, meeting.id, "Matched by id, not by text", question_id))

    # The stored answer, replayed: no second question, no second run, nothing paid twice.
    assert names(again) == ["done"]
    assert done_message(again) == done_message(first)
    assert [item["role"] for item in await thread(client, meeting.id)] == ["user", "assistant"]
    assert len(await chat_runs(app.state.database)) == 1


async def test_resent_message_id_of_a_streaming_answer_attaches(open_api: OpenApi) -> None:
    hold = asyncio.Event()
    model = ScriptedNotesModel(ModelScript(steps=("Beta ships ", hold, "Friday [L1].")))
    async with asyncio.timeout(WAIT_S), open_api(model) as api:
        meeting = await add_meeting(api.client, LINES)
        question_id = uuid4()
        first = asyncio.create_task(ask(api.client, meeting.id, "When?", question_id))
        # The model was asked, so the run is driven here and held mid-answer.
        await eventually(lambda: requests_of(model), lambda asked: asked == 1)

        # The re-send, as the route's dependency makes it. Through the routes, ASGITransport would
        # hide whether it attached before the run ended (it buffers whole responses).
        runtime = get_llm_runtime_of(api.app)
        async with api.database.session() as session:
            claim = await chat.claim_answer(
                session,
                runtime,
                default_principal(api.app.state.settings),
                UUID(meeting.id),
                message_id=question_id,
                text="When?",
                max_input_tokens=api.app.state.settings.notes_max_input_tokens,
            )
            await session.commit()
        stream = await chat.start_answer(runtime, claim)
        hold.set()
        again = [(event.name, dict(event.data)) async for event in stream.events()]
        first_events = events_of(await first)

    # The events so far, then live: the same answer, and the model was asked once.
    assert again == first_events
    assert names(again)[0] == "run"
    assert done_message(again)["text"] == "Beta ships Friday [L1]."
    assert len(model.requests) == 1


async def test_resent_message_id_of_a_failed_answer_generates_again(open_api: OpenApi) -> None:
    failure = LlmProviderError("The notes model's provider stopped answering")
    model = ScriptedNotesModel(
        ModelScript(steps=("We decided",), end=failure), ModelScript(steps=("Friday [L1].",))
    )
    async with open_api(model) as api:
        meeting = await add_meeting(api.client, LINES)
        question_id = uuid4()
        failed = events_of(await ask(api.client, meeting.id, "When?", question_id))
        [_, failed_answer] = await thread(api.client, meeting.id)

        events = events_of(await ask(api.client, meeting.id, "When?", question_id))
        items = await thread(api.client, meeting.id)
        runs = await chat_runs(api.database)

    assert failed[-1][0] == "error"
    assert failed_answer["status"] == "failed"
    answer = done_message(events)
    assert names(events)[0] == "run"
    assert events[0][1]["run_id"] != failed[0][1]["run_id"]
    # One question and one answer: the failed answer is written again, by a second run.
    assert [(item["role"], item["status"]) for item in items] == [
        ("user", "complete"),
        ("assistant", "complete"),
    ]
    assert items[1] == answer
    assert answer["id"] == failed_answer["id"]
    assert answer["text"] == "Friday [L1]."
    assert [(run.status, str(run.id)) for run in runs] == [
        ("failed", failed[0][1]["run_id"]),
        ("succeeded", answer["run_id"]),
    ]


async def add_answer_being_written(
    database: Database, meeting_id: str, *, heartbeat_age: timedelta
) -> tuple[UUID, UUID, UUID]:
    """A question whose answer a run no process here drives is writing, its heartbeat
    `heartbeat_age` old: another API process's run, or a dead one. Question, answer and run ids."""
    async with database.session() as session:
        meeting = await session.get_one(Meeting, UUID(meeting_id))
        run = LlmRun(
            id=uuid4(),
            workspace_id=meeting.workspace_id,
            meeting_id=meeting.id,
            kind="chat",
            status="running",
            model="scripted",
            prompt_version=CHAT_PROMPT_VERSION,
            line_count=len(LINES),
            ref_map={},
        )
        session.add(run)
        await session.flush()
        question_id, answer_id = uuid4(), uuid4()
        for message in (
            ChatMessage(id=question_id, role="user", text="When?", status="complete"),
            ChatMessage(
                id=answer_id,
                role="assistant",
                text="",
                reply_to=question_id,
                run_id=run.id,
                status="streaming",
            ),
        ):
            message.workspace_id, message.meeting_id = meeting.workspace_id, meeting.id
            session.add(message)
        await session.execute(
            update(LlmRun)
            .where(LlmRun.id == run.id)
            .values(heartbeat_at=func.now() - heartbeat_age)
        )
        await session.commit()
    return question_id, answer_id, run.id


async def test_resent_message_id_of_an_answer_whose_run_died_generates_again(
    open_api: OpenApi,
) -> None:
    model = ScriptedNotesModel(ModelScript(steps=("Friday [L1].",)))
    async with open_api(model) as api:
        meeting = await add_meeting(api.client, LINES)
        question_id, answer_id, dead_run_id = await add_answer_being_written(
            api.database, meeting.id, heartbeat_age=STALE_AFTER + timedelta(minutes=1)
        )

        events = events_of(await ask(api.client, meeting.id, "When?", question_id))
        runs = {run.id: run for run in await chat_runs(api.database)}

    answer = done_message(events)
    assert (answer["id"], answer["status"], answer["text"]) == (
        str(answer_id),
        "complete",
        "Friday [L1].",
    )
    # The dead run is failed by the sweep before the new one is claimed.
    assert (runs[dead_run_id].status, runs[dead_run_id].error_code) == ("failed", "internal_error")
    assert runs[UUID(answer["run_id"])].status == "succeeded"


async def test_resent_message_id_of_an_answer_another_process_writes_is_a_conflict(
    open_api: OpenApi,
) -> None:
    model = ScriptedNotesModel()
    async with open_api(model) as api:
        meeting = await add_meeting(api.client, LINES)
        question_id, _, run_id = await add_answer_being_written(
            api.database, meeting.id, heartbeat_age=timedelta(0)
        )

        response = await ask(api.client, meeting.id, "When?", question_id)
        [run] = await chat_runs(api.database)
        messages = await stored_messages(api.database)

    # Its heartbeat is alive, so some API process is writing it: never a second paid answer.
    assert_error(response, 409, "conflict")
    assert (run.id, run.status) == (run_id, "running")
    assert [message.status for message in messages] == ["complete", "streaming"]
    assert model.requests == []


async def test_a_question_written_again_reads_the_thread_as_it_was_asked(
    open_api: OpenApi,
) -> None:
    failure = LlmProviderError("The notes model's provider stopped answering")
    model = ScriptedNotesModel(
        ModelScript(steps=("We",), end=failure),
        ModelScript(steps=("Later [L2].",)),
        ModelScript(steps=("Friday [L1].",)),
    )
    async with open_api(model) as api:
        meeting = await add_meeting(api.client, LINES)
        first_id = uuid4()
        events_of(await ask(api.client, meeting.id, "First?", first_id))
        events_of(await ask(api.client, meeting.id, "Second?"))
        events_of(await ask(api.client, meeting.id, "First?", first_id))

    def turns(request_index: int) -> list[tuple[str, str]]:
        request = model.requests[request_index]
        return [(message.role, message.parts[0].text) for message in request.messages[2:]]

    # The failed first answer is no part of the second question's thread, and the second exchange,
    # which came later, is no part of the first question's when it is written again.
    assert turns(1) == [("user", "Second?")]
    assert turns(2) == [("user", "First?")]


async def test_message_id_of_another_meeting_is_a_conflict(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    first = await add_meeting(client, LINES)
    other = await add_meeting(client, LINES)
    question_id = uuid4()
    events_of(await ask(client, first.id, "When?", question_id))

    response = await ask(client, other.id, "When?", question_id)

    assert_error(response, 409, "conflict")
    assert await thread(client, other.id) == []
    assert len(await chat_runs(app.state.database)) == 1


async def test_message_id_of_another_workspace_is_a_conflict(
    app: FastAPI, client: httpx.AsyncClient, foreign_meeting_id: UUID
) -> None:
    meeting = await add_meeting(client, LINES)
    foreign_question = uuid4()
    async with app.state.database.session() as session:
        meeting_row = await session.get_one(Meeting, foreign_meeting_id)
        session.add(
            ChatMessage(
                id=foreign_question,
                workspace_id=meeting_row.workspace_id,
                meeting_id=foreign_meeting_id,
                role="user",
                text="Not yours.",
                status="complete",
            )
        )
        await session.commit()

    response = await ask(client, meeting.id, "When?", foreign_question)

    message = assert_error(response, 409, "conflict")
    assert "Not yours" not in message
    assert await thread(client, meeting.id) == []
    assert await chat_runs(app.state.database) == []


async def test_a_chat_answer_never_blocks_an_ai_notes_save(open_api: OpenApi) -> None:
    hold = asyncio.Event()
    model = ScriptedNotesModel(ModelScript(steps=(hold, "Friday [L1].")))
    async with asyncio.timeout(WAIT_S), open_api(model) as api:
        meeting = await add_meeting(api.client, LINES)
        posting = asyncio.create_task(ask(api.client, meeting.id, "When?"))
        await streaming_answer(api.database)

        # Only a notes run makes an AI-doc save a 409; a chat run takes no meeting lock.
        saved = await api.client.put(
            f"/v1/meetings/{meeting.id}/notes/ai",
            json={
                "doc": {"type": "doc", "content": []},
                "base_version": 0,
                "revision_id": str(uuid4()),
            },
        )
        hold.set()
        events_of(await posting)

    assert saved.status_code == 200, saved.text


# ---------------------------------------------------------------------------- refusals


async def test_meeting_over_budget_is_meeting_too_long(open_api: OpenApi) -> None:
    # NOTES_MAX_INPUT_TOKENS at its floor, 1,000 tokens (about 4,000 characters) for the meeting.
    long_lines = [("system", "them", n * 1_000, "word " * 60) for n in range(20)]
    model = ScriptedNotesModel()
    async with open_api(model, notes_max_input_tokens=1_000) as api:
        meeting = await add_meeting(api.client, long_lines)
        response = await ask(api.client, meeting.id, "Summarise it?")
        items = await thread(api.client, meeting.id)
        runs = await chat_runs(api.database)

    message = assert_error(response, 422, "meeting_too_long")
    assert meeting.id in message
    assert "word" not in message
    assert (items, runs, model.requests) == ([], [], [])


async def test_chat_of_a_meeting_in_another_workspace_is_not_found(
    app: FastAPI, client: httpx.AsyncClient, foreign_meeting_id: UUID
) -> None:
    assert_error(await client.get(chat_path(foreign_meeting_id)), 404, "not_found")
    assert_error(await ask(client, foreign_meeting_id, "Whose call?"), 404, "not_found")
    assert_error(await ask(client, uuid4(), "Which call?"), 404, "not_found")
    assert await stored_messages(app.state.database) == []
    assert await chat_runs(app.state.database) == []


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"message_id": "nope", "text": "When?"}, id="bad-id"),
        pytest.param({"text": "When?"}, id="no-id"),
        pytest.param({"message_id": str(uuid4()), "text": "   "}, id="blank"),
        pytest.param({"message_id": str(uuid4()), "text": "x" * 4_001}, id="too-long"),
    ],
)
async def test_a_question_is_a_message_id_and_1_to_4000_characters(
    app: FastAPI, client: httpx.AsyncClient, body: Json
) -> None:
    meeting = await add_meeting(client, LINES)

    response = await client.post(chat_path(meeting.id), json=body)

    assert_error(response, 422, "validation_error")
    assert await stored_messages(app.state.database) == []


async def test_a_question_of_4000_characters_is_taken(client: httpx.AsyncClient) -> None:
    meeting = await add_meeting(client, LINES)

    events = events_of(await ask(client, meeting.id, "x" * 4_000))

    assert names(events)[-1] == "done"
