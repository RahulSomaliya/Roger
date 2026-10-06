"""The LLM run registry (services/llm_runs.py), driven at the service level.

`httpx.ASGITransport` buffers a whole response, so a test through the routes sees a finished stream
and never a subscriber that leaves or a cancel mid-answer (M4 plan, Traps). These start runs on the
registry directly, with `ScriptedNotesModel` holding a run mid-answer on an `asyncio.Event`.
"""

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Sequence
from contextlib import aclosing, asynccontextmanager, contextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI, Request
from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession

from roger_api.config import Settings
from roger_api.db.engine import Database
from roger_api.db.models import Meeting, Workspace
from roger_api.db.models_notes import ChatMessage, ChatMessageStatus, LlmRun
from roger_api.domain import RunKind
from roger_api.errors import ConflictError, LlmProviderError
from roger_api.log import configure_logging
from roger_api.services.llm_runs import (
    STALE_AFTER,
    LlmRuntime,
    RunContext,
    RunEvent,
    RunSave,
    claim_run,
    get_llm_runtime,
    open_llm_runtime,
)
from roger_api.services.notes_model import (
    ModelCutOffError,
    ModelDone,
    ModelMessage,
    ModelRequest,
    ModelUsage,
    TextDelta,
    TextPart,
)
from roger_api.services.notes_model_fake import FakeNotesModel, ModelScript, ScriptedNotesModel

# Bounds every wait below: a registry bug fails the test instead of hanging `make check`.
WAIT_S = 5.0
POLL_S = 0.02
QUICK_HEARTBEAT_S = 0.05

REQUEST = ModelRequest(
    kind="notes", messages=(ModelMessage("user", (TextPart("Write the notes."),)),)
)
USAGE = ModelUsage(
    input_tokens=1_200,
    output_tokens=300,
    cached_tokens=1_000,
    reasoning_tokens=0,
    cost_usd=Decimal("0.0012"),
)


@pytest.fixture
async def database(database_url: str, clean_database: None) -> AsyncIterator[Database]:
    database = Database(database_url)
    yield database
    await database.dispose()


@pytest.fixture
async def meeting(database: Database) -> Meeting:
    return await add_meeting(database)


async def add_meeting(database: Database) -> Meeting:
    """A meeting in a workspace of its own."""
    workspace = Workspace(id=uuid4(), name="Linkt")
    meeting = Meeting(
        id=uuid4(),
        workspace_id=workspace.id,
        title="Standup",
        status="ended",
        started_at=datetime.now(UTC),
    )
    async with database.session() as session:
        session.add(workspace)
        await session.flush()
        session.add(meeting)
        await session.commit()
    return meeting


def new_run(meeting: Meeting, kind: RunKind = "notes") -> LlmRun:
    return LlmRun(
        id=uuid4(),
        workspace_id=meeting.workspace_id,
        meeting_id=meeting.id,
        kind=kind,
        status="running",
        model="scripted",
        prompt_version="notes-test",
        line_count=1,
        ref_map={"L1": str(uuid4())},
    )


async def claim(database: Database, run: LlmRun) -> LlmRun:
    async with database.session() as session:
        await claim_run(session, run)
        await session.commit()
    return run


async def read_run(database: Database, run_id: UUID) -> LlmRun:
    async with database.session() as session:
        run = await session.get(LlmRun, run_id)
    assert run is not None
    return run


async def message_status(database: Database, message_id: UUID) -> ChatMessageStatus:
    async with database.session() as session:
        message = await session.get(ChatMessage, message_id)
    assert message is not None
    return message.status


async def age(database: Database, run_id: UUID, by: timedelta) -> None:
    """Moves the run's heartbeat back by `by`, on the database clock the sweep reads."""
    async with database.session() as session:
        await session.execute(
            update(LlmRun).where(LlmRun.id == run_id).values(heartbeat_at=func.now() - by)
        )
        await session.commit()


async def eventually[T](read: Callable[[], Awaitable[T]], done: Callable[[T], bool]) -> T:
    """Reads until `done` holds. The caller's `asyncio.timeout` bounds it."""
    while True:
        value = await read()
        if done(value):
            return value
        await asyncio.sleep(POLL_S)


async def wait_until_ended(database: Database, run_id: UUID) -> LlmRun:
    return await eventually(lambda: read_run(database, run_id), lambda run: run.status != "running")


@asynccontextmanager
async def running(
    database: Database, model: ScriptedNotesModel, *, heartbeat_every_s: float = 60.0
) -> AsyncIterator[LlmRuntime]:
    runtime = LlmRuntime(database, model, heartbeat_every_s=heartbeat_every_s)
    try:
        yield runtime
    finally:
        await runtime.aclose()


def delta(text: str) -> RunEvent:
    return RunEvent("delta", {"text": text})


def codes(events: Sequence[RunEvent]) -> list[tuple[str, object]]:
    return [(event.name, event.data.get("code")) for event in events]


async def echo(context: RunContext) -> RunSave:
    """Streams the model, emitting each piece as `delta`; its save stores the whole answer."""
    pieces: list[str] = []
    async with context.stream(REQUEST) as events:
        async for event in events:
            if isinstance(event, TextDelta):
                pieces.append(event.text)
                context.emit(delta(event.text))
    answer = "".join(pieces)

    async def save(session: AsyncSession) -> list[RunEvent]:
        await session.execute(
            update(LlmRun).where(LlmRun.id == context.run_id).values(output_text=answer)
        )
        return [RunEvent("done", {"text": answer})]

    return save


async def test_run_finishes_and_saves_after_the_subscriber_leaves(
    database: Database, meeting: Meeting
) -> None:
    hold = asyncio.Event()
    model = ScriptedNotesModel(
        ModelScript(steps=("Beta ships ", hold, "Friday."), end=ModelDone(usage=USAGE))
    )
    async with asyncio.timeout(WAIT_S), running(database, model) as runtime:
        run = await claim(database, new_run(meeting))
        live = await runtime.start(run, echo)
        async with aclosing(live.subscribe()) as events:
            first = await anext(events)

        hold.set()
        stored = await wait_until_ended(database, run.id)

    assert first == delta("Beta ships ")
    assert stored.status == "succeeded"
    assert stored.output_text == "Beta ships Friday."
    assert stored.finished_at is not None
    assert (stored.error_code, stored.error) == (None, None)
    assert (stored.input_tokens, stored.output_tokens, stored.cached_tokens) == (1_200, 300, 1_000)
    assert stored.cost_usd == Decimal("0.0012")


async def test_late_subscriber_gets_buffered_events_then_live(
    database: Database, meeting: Meeting
) -> None:
    hold = asyncio.Event()
    model = ScriptedNotesModel(ModelScript(steps=("one ", "two ", hold, "three")))
    async with asyncio.timeout(WAIT_S), running(database, model) as runtime:
        live = await runtime.start(await claim(database, new_run(meeting)), echo)
        early = live.subscribe()
        early_seen = [await anext(early), await anext(early)]

        # The model is held after two pieces: whatever the late subscriber reads now is buffered.
        late = live.subscribe()
        late_seen = [await anext(late), await anext(late)]
        hold.set()
        early_seen += [event async for event in early]
        late_seen += [event async for event in late]

    expected = [
        delta("one "),
        delta("two "),
        delta("three"),
        RunEvent("done", {"text": "one two three"}),
    ]
    assert early_seen == expected
    assert late_seen == expected


async def test_cancel_stops_the_model_and_marks_cancelled(
    database: Database, meeting: Meeting
) -> None:
    never = asyncio.Event()
    model = ScriptedNotesModel(ModelScript(steps=("Half an ", never, "answer")))
    async with asyncio.timeout(WAIT_S), running(database, model) as runtime:
        run = await claim(database, new_run(meeting))
        live = await runtime.start(run, echo)
        events = live.subscribe()
        assert await anext(events) == delta("Half an ")
        assert model.open_streams == 1

        await runtime.cancel(meeting.workspace_id, run.id)

        assert model.open_streams == 0
        assert codes([event async for event in events]) == [("error", "cancelled")]
        assert runtime.find(meeting.workspace_id, run.id) is None

    stored = await read_run(database, run.id)
    assert (stored.status, stored.error_code) == ("cancelled", "cancelled")
    assert stored.finished_at is not None
    assert stored.output_text is None  # its save never ran


async def test_heartbeat_moves_while_running(database: Database, meeting: Meeting) -> None:
    never = asyncio.Event()
    model = ScriptedNotesModel(ModelScript(steps=(never,)))
    async with (
        asyncio.timeout(WAIT_S),
        running(database, model, heartbeat_every_s=QUICK_HEARTBEAT_S) as runtime,
    ):
        run = await claim(database, new_run(meeting))
        claimed_at = run.heartbeat_at
        await runtime.start(run, echo)

        beat = await eventually(
            lambda: read_run(database, run.id), lambda stored: stored.heartbeat_at > claimed_at
        )

    assert beat.status == "running"  # read before the runtime closed


async def test_stale_runs_are_failed_on_startup_and_before_a_new_run(
    database: Database, settings: Settings
) -> None:
    meeting, other = await add_meeting(database), await add_meeting(database)
    dead_at_startup = await claim(database, new_run(meeting))
    await age(database, dead_at_startup.id, STALE_AFTER + timedelta(minutes=1))
    # Quiet for a while, but younger than STALE_AFTER: still alive.
    quiet = await claim(database, new_run(other, kind="chat"))
    await age(database, quiet.id, STALE_AFTER - timedelta(minutes=1))

    async with asyncio.timeout(WAIT_S), open_llm_runtime(settings):
        swept = await read_run(database, dead_at_startup.id)
        assert (swept.status, swept.error_code) == ("failed", "internal_error")
        assert swept.error is not None
        assert swept.finished_at is not None
        assert (await read_run(database, quiet.id)).status == "running"

        dead_since = await claim(database, new_run(meeting))
        await age(database, dead_since.id, STALE_AFTER + timedelta(minutes=1))
        # Without the sweep, the one-running-notes-run index would refuse this claim forever.
        fresh = await claim(database, new_run(meeting))

    assert (await read_run(database, dead_since.id)).status == "failed"
    assert (await read_run(database, fresh.id)).status == "running"


async def test_stale_sweep_fails_streaming_chat_messages(
    database: Database, meeting: Meeting
) -> None:
    dead = await claim(database, new_run(meeting, kind="chat"))
    alive = await claim(database, new_run(meeting, kind="chat"))
    question = ChatMessage(
        id=uuid4(),
        workspace_id=meeting.workspace_id,
        meeting_id=meeting.id,
        role="user",
        text="What did we decide about the beta?",
        status="complete",
    )
    dead_answer, alive_answer = (
        ChatMessage(
            id=uuid4(),
            workspace_id=meeting.workspace_id,
            meeting_id=meeting.id,
            role="assistant",
            text="We decided",
            status="streaming",
            reply_to=question.id,
            run_id=run.id,
        )
        for run in (dead, alive)
    )
    async with database.session() as session:
        session.add_all([question, dead_answer, alive_answer])
        await session.commit()
    await age(database, dead.id, STALE_AFTER + timedelta(minutes=1))

    await claim(database, new_run(meeting, kind="chat"))

    assert await message_status(database, dead_answer.id) == "failed"
    assert await message_status(database, alive_answer.id) == "streaming"
    assert await message_status(database, question.id) == "complete"


async def test_a_second_notes_run_while_one_is_running_is_a_conflict(
    database: Database, meeting: Meeting
) -> None:
    await claim(database, new_run(meeting))

    with pytest.raises(ConflictError, match=str(meeting.id)):
        await claim(database, new_run(meeting))
    # Chat runs are not limited to one per meeting.
    await claim(database, new_run(meeting, kind="chat"))


async def test_start_returns_once_the_model_has_opened(
    database: Database, meeting: Meeting
) -> None:
    gate, hold = asyncio.Event(), asyncio.Event()
    model = ScriptedNotesModel(ModelScript(steps=(hold, "Notes.")))

    async def opens_late(context: RunContext) -> RunSave:
        await gate.wait()
        return await echo(context)

    async with asyncio.timeout(WAIT_S), running(database, model) as runtime:
        starting = asyncio.create_task(
            runtime.start(await claim(database, new_run(meeting)), opens_late)
        )
        await asyncio.sleep(QUICK_HEARTBEAT_S)
        assert not starting.done()

        gate.set()
        live = await starting
        # The handler returns its SSE response only now: a refusal could still be a 502.
        assert model.open_streams == 1
        hold.set()
        assert codes([event async for event in live.subscribe()]) == [
            ("delta", None),
            ("done", None),
        ]


async def test_a_refusal_at_open_raises_from_start_and_stores_a_failed_run(
    database: Database, meeting: Meeting
) -> None:
    refusal = LlmProviderError("The notes model's provider refused the request (HTTP 404)")
    model = ScriptedNotesModel(ModelScript(refuse=refusal))
    async with asyncio.timeout(WAIT_S), running(database, model) as runtime:
        run = await claim(database, new_run(meeting))

        with pytest.raises(LlmProviderError) as raised:
            await runtime.start(run, echo)

        assert raised.value is refusal
        assert runtime.find(meeting.workspace_id, run.id) is None

    # Stored, so a re-sent run id replays this failure instead of paying for a second run.
    stored = await read_run(database, run.id)
    assert (stored.status, stored.error_code) == ("failed", "llm_provider_error")
    assert stored.error == refusal.message
    assert stored.cost_usd is None


async def test_a_vendor_error_mid_stream_is_an_error_event_and_a_failed_run(
    database: Database, meeting: Meeting
) -> None:
    failure = LlmProviderError("The notes model's provider failed while answering")
    model = ScriptedNotesModel(ModelScript(steps=("Half",), end=failure))
    async with asyncio.timeout(WAIT_S), running(database, model) as runtime:
        run = await claim(database, new_run(meeting))
        live = await runtime.start(run, echo)
        events = [event async for event in live.subscribe()]

    assert events == [
        delta("Half"),
        RunEvent("error", {"code": "llm_provider_error", "message": failure.message}),
    ]
    stored = await read_run(database, run.id)
    assert (stored.status, stored.error_code, stored.error) == (
        "failed",
        "llm_provider_error",
        failure.message,
    )
    assert stored.output_text is None


async def test_a_cut_off_fails_as_cut_off_and_stores_its_usage(
    database: Database, meeting: Meeting
) -> None:
    model = ScriptedNotesModel(ModelScript(steps=("- Beta ships",), end=ModelCutOffError(USAGE)))
    async with asyncio.timeout(WAIT_S), running(database, model) as runtime:
        run = await claim(database, new_run(meeting))
        live = await runtime.start(run, echo)
        events = [event async for event in live.subscribe()]

    assert codes(events) == [("delta", None), ("error", "cut_off")]
    stored = await read_run(database, run.id)
    assert (stored.status, stored.error_code) == ("failed", "cut_off")
    # The output was billed even though it is a fragment.
    assert (stored.input_tokens, stored.output_tokens, stored.cost_usd) == (
        1_200,
        300,
        Decimal("0.0012"),
    )


async def test_a_run_without_usage_stores_null_cost_not_zero(
    database: Database, meeting: Meeting
) -> None:
    model = ScriptedNotesModel(ModelScript(steps=("Notes.",), end=ModelDone(usage=None)))
    async with asyncio.timeout(WAIT_S), running(database, model) as runtime:
        run = await claim(database, new_run(meeting))
        live = await runtime.start(run, echo)
        [event async for event in live.subscribe()]

    stored = await read_run(database, run.id)
    assert stored.status == "succeeded"
    assert (stored.input_tokens, stored.output_tokens, stored.cached_tokens) == (None, None, None)
    assert stored.cost_usd is None


async def test_usage_of_several_model_calls_is_summed_and_unknown_when_one_is_unknown(
    database: Database, meeting: Meeting
) -> None:
    model = ScriptedNotesModel(
        ModelScript(end=ModelDone(usage=USAGE)),
        ModelScript(end=ModelDone(usage=USAGE)),
        ModelScript(end=ModelDone(usage=USAGE)),
        ModelScript(end=ModelDone(usage=None)),
    )

    async def twice(context: RunContext) -> RunSave:
        """Two model calls, as map then reduce makes (M4-T9)."""
        for _ in range(2):
            async with context.stream(REQUEST) as events:
                async for _event in events:
                    pass

        async def save(session: AsyncSession) -> list[RunEvent]:
            return []

        return save

    async with asyncio.timeout(WAIT_S), running(database, model) as runtime:
        both_known = await claim(database, new_run(meeting))
        [event async for event in (await runtime.start(both_known, twice)).subscribe()]
        one_unknown = await claim(database, new_run(meeting))
        [event async for event in (await runtime.start(one_unknown, twice)).subscribe()]

    summed = await read_run(database, both_known.id)
    assert (summed.input_tokens, summed.output_tokens, summed.cached_tokens) == (2_400, 600, 2_000)
    assert summed.cost_usd == Decimal("0.0024")
    # A partial sum would under-report the run's cost without saying so.
    unknown = await read_run(database, one_unknown.id)
    assert (unknown.input_tokens, unknown.output_tokens, unknown.cost_usd) == (None, None, None)


async def test_a_run_that_fails_fails_its_streaming_chat_message(
    database: Database, meeting: Meeting
) -> None:
    failure = LlmProviderError("The notes model's provider failed while answering")
    model = ScriptedNotesModel(ModelScript(steps=("We decided",), end=failure))
    async with asyncio.timeout(WAIT_S), running(database, model) as runtime:
        run = await claim(database, new_run(meeting, kind="chat"))
        answer = ChatMessage(
            id=uuid4(),
            workspace_id=meeting.workspace_id,
            meeting_id=meeting.id,
            role="assistant",
            text="",
            status="streaming",
            run_id=run.id,
        )
        async with database.session() as session:
            session.add(answer)
            await session.commit()

        live = await runtime.start(run, echo)
        [event async for event in live.subscribe()]

    assert await message_status(database, answer.id) == "failed"


class EventRecorder(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.events: list[dict[str, Any]] = []

    def emit(self, record: logging.LogRecord) -> None:
        if isinstance(record.msg, dict):
            self.events.append(dict(record.msg))


@contextmanager
def recorded_events() -> Iterator[list[dict[str, Any]]]:
    """Events logged inside the block, read at the root logger (CLAUDE.md failure log: plain
    `structlog.testing.capture_logs()` misses a module logger cached under an earlier config)."""
    recorder = EventRecorder()
    root = logging.getLogger()
    root.addHandler(recorder)
    try:
        yield recorder.events
    finally:
        root.removeHandler(recorder)


async def test_a_crash_is_an_internal_error_that_never_carries_its_message(
    database: Database, meeting: Meeting, settings: Settings
) -> None:
    secret = "the acquisition closes at fifty million"

    async def crashes(context: RunContext) -> RunSave:
        raise ValueError(f"Them: {secret}")

    configure_logging(settings)
    with recorded_events() as logged:
        async with asyncio.timeout(WAIT_S), running(database, ScriptedNotesModel()) as runtime:
            run = await claim(database, new_run(meeting))
            live = await runtime.start(run, crashes)
            events = [event async for event in live.subscribe()]

    assert codes(events) == [("error", "internal_error")]
    stored = await read_run(database, run.id)
    assert (stored.status, stored.error_code) == ("failed", "internal_error")
    [crashed] = [event for event in logged if event.get("event") == "llm_run_crashed"]
    assert crashed["error_type"] == "ValueError"
    # Exception text can quote the transcript: it reaches neither the client nor the log.
    assert secret not in str(events[0].data)
    assert secret not in (stored.error or "")
    assert all(secret not in str(value) for event in logged for value in event.values())


async def test_closing_the_runtime_fails_a_run_still_working(
    database: Database, meeting: Meeting
) -> None:
    never = asyncio.Event()
    model = ScriptedNotesModel(ModelScript(steps=("Half", never)))
    runtime = LlmRuntime(database, model)
    async with asyncio.timeout(WAIT_S):
        run = await claim(database, new_run(meeting))
        live = await runtime.start(run, echo)
        events = live.subscribe()
        assert await anext(events) == delta("Half")

        await runtime.aclose()

        assert model.open_streams == 0
        assert codes([event async for event in events]) == [("error", "internal_error")]

    # Never left `running`: a restart within STALE_AFTER would otherwise 409 every Generate.
    stored = await read_run(database, run.id)
    assert (stored.status, stored.error_code) == ("failed", "internal_error")


async def test_a_run_ended_elsewhere_stops_at_its_next_heartbeat(
    database: Database, meeting: Meeting
) -> None:
    never = asyncio.Event()
    model = ScriptedNotesModel(ModelScript(steps=("Half", never)))
    elsewhere = "Cancelled by another API process"
    async with (
        asyncio.timeout(WAIT_S),
        running(database, model, heartbeat_every_s=QUICK_HEARTBEAT_S) as runtime,
    ):
        run = await claim(database, new_run(meeting))
        live = await runtime.start(run, echo)
        events = live.subscribe()
        assert await anext(events) == delta("Half")

        async with database.session() as session:
            await session.execute(
                update(LlmRun)
                .where(LlmRun.id == run.id)
                .values(
                    status="cancelled",
                    error_code="cancelled",
                    error=elsewhere,
                    finished_at=func.now(),
                )
            )
            await session.commit()
        rest = [event async for event in events]

        assert model.open_streams == 0

    assert rest == [RunEvent("error", {"code": "cancelled", "message": elsewhere})]
    stored = await read_run(database, run.id)
    assert (stored.status, stored.error) == ("cancelled", elsewhere)


async def test_cancel_of_a_run_no_process_drives_marks_its_row_cancelled(
    database: Database, meeting: Meeting
) -> None:
    async with asyncio.timeout(WAIT_S), running(database, ScriptedNotesModel()) as runtime:
        run = await claim(database, new_run(meeting))

        await runtime.cancel(uuid4(), run.id)
        assert (await read_run(database, run.id)).status == "running"

        await runtime.cancel(meeting.workspace_id, run.id)

    stored = await read_run(database, run.id)
    assert (stored.status, stored.error_code) == ("cancelled", "cancelled")
    assert stored.finished_at is not None


async def test_the_getter_reads_the_runtime_the_lifespan_opened(app: FastAPI) -> None:
    runtime = get_llm_runtime(Request({"type": "http", "app": app}))

    assert runtime is app.state.llm_runtime
    # NOTES_PROVIDER defaults to fake: the runtime holds the model it opened.
    assert isinstance(runtime.notes_model, FakeNotesModel)
    with pytest.raises(RuntimeError, match="llm_runtime"):
        get_llm_runtime(Request({"type": "http", "app": FastAPI()}))
