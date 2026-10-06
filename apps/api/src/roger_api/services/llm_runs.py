"""The LLM run registry (M4-T7): each notes or chat run is a background task this API process owns.

A run outlives the request that starts it. Closing the laptop mid-run must not throw away paid
output: the run finishes and saves, and the desktop reads it on reconnect (M4 plan, "Where
generation runs"). So a route claims the run, hands its work to the registry, and its SSE response
only subscribes:

    run = LlmRun(id=body.run_id, status="running", ...)
    await claim_run(session, run)            # the meeting's dead runs fail first; 409 if one runs
    await session.commit()                   # the claim's own session (first trap below)
    live = await runtime.start(run, work)    # LlmProviderError: the vendor refused (502 envelope)
    async for event in live.subscribe(): ... # the events so far, then live ones

`work(context)` streams the model through `context.stream` and emits events with `context.emit`.
It returns a `RunSave`, which writes what the run made into the session that also marks the run
succeeded, and returns the events to send once that commits (`done`). The registry does the rest:
the heartbeat, cancel, failures (an `error` event, the row failed with its code, the run's
streaming chat message failed), usage and cost, and the stale sweep.

app.py enters `open_llm_runtime` once in its lifespan and stores the runtime as
`app.state.llm_runtime`; `get_llm_runtime` and `LlmRuntimeDep` read it. They live here, never in
dependencies.py (phase-2-build-order.md, section 1), and app.py is not edited again.

Traps:
- Claim in a `Depends(..., scope="function")` dependency that opens its own session from
  `DatabaseDep` and commits before it returns (routers/notes_runs.py, routers/chat.py). A claim
  through `SessionDep` keeps its transaction open until the stream ends (FastAPI 0.142 exits
  request-scoped `yield` dependencies after the response), and this registry's own sessions never
  see the row: no heartbeat lands, and the final write finds no running run to end.
- `start` returns only once the model stream has opened, so a vendor refusal still reaches the
  client as the 502 envelope; after the SSE `200` it could only be an `error` event.
- Every write here ends a run only `WHERE status = 'running'`. A run the sweep or another API
  process ended keeps that ending, and its heartbeat stops the work here.
- `httpx.ASGITransport` buffers whole responses: test disconnects and cancels here, at the service
  (tests/test_llm_runs.py), never through the routes.
"""

import asyncio
import traceback
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Awaitable,
    Callable,
    Coroutine,
    Mapping,
    Sequence,
)
from contextlib import aclosing, asynccontextmanager
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import Depends, Request
from sqlalchemy import ColumnElement, func, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from roger_api.config import Settings
from roger_api.db.engine import Database
from roger_api.db.models_notes import ONE_RUNNING_NOTES_RUN_INDEX, ChatMessage, LlmRun
from roger_api.domain import RunKind
from roger_api.errors import ConflictError, LlmProviderError
from roger_api.log import get_logger
from roger_api.services.notes_model import (
    ModelCutOffError,
    ModelDone,
    ModelEvent,
    ModelRequest,
    ModelUsage,
    NotesModel,
    open_notes_model,
)

logger = get_logger(__name__)

# A `running` run whose heartbeat is older than this is dead: the API process driving it stopped.
# The desktop polls a dropped run until it ends or its heartbeat is this old (M4 plan, Streaming).
STALE_AFTER = timedelta(minutes=2)
# Six beats inside STALE_AFTER, so a slow write or two never gets a live run swept.
HEARTBEAT_EVERY_S = 20.0

# The `error` event's codes (M4 plan, Notes SSE events), also stored as `llm_runs.error_code`.
type RunErrorCode = Literal["llm_provider_error", "cut_off", "cancelled", "internal_error"]

# What the client reads in the `error` event and the run row keeps. Never an exception's own text:
# that can quote the transcript (see `_log_failure`).
_CANCELLED_MESSAGE = "The run was cancelled."
_INTERRUPTED_MESSAGE = "The API stopped before the run finished. Try again."
_STALE_MESSAGE = "The run stopped without finishing: the API restarted or went offline. Try again."
_CRASHED_MESSAGE = "Something went wrong while the run was writing. Try again."
_GONE_MESSAGE = "The run no longer exists: its meeting was deleted."


@dataclass(frozen=True, slots=True)
class RunEvent:
    """One server-sent event of a run: `name` is its `event:` field, `data` its JSON object."""

    name: str
    data: Mapping[str, object]


def error_event(code: RunErrorCode, message: str) -> RunEvent:
    """The event a run's stream ends with when the run does not succeed."""
    return RunEvent("error", {"code": code, "message": message})


# Writes what a finished run made, in the transaction that also marks the run succeeded (neither
# commits without the other), and returns the events to send once it has committed (`done`).
type RunSave = Callable[[AsyncSession], Awaitable[Sequence[RunEvent]]]
# What a run does. It reaches the model through `context.stream`, never `NotesModel.stream`: that
# is how `start` learns the stream opened and how the usage reaches the run row.
type RunWork = Callable[[RunContext], Coroutine[Any, Any, RunSave]]
# Why the work was stopped: `cancelled` by the user; `interrupted` by the API shutting down, or by
# the row ending elsewhere (the outcome write then finds it ended and reports that ending instead).
type _StopReason = Literal["cancelled", "interrupted"]
type _EndStatus = Literal["succeeded", "failed", "cancelled"]


class LiveRun:
    """A run this process drives. `subscribe` reads its events; only the registry writes them."""

    def __init__(self, run: LlmRun, work: RunWork, model: NotesModel) -> None:
        self.run_id = run.id
        self.workspace_id = run.workspace_id
        self.meeting_id = run.meeting_id
        self.kind: RunKind = run.kind
        self._events: list[RunEvent] = []
        # Replaced on every change, so a subscriber waits for exactly the next one.
        self._changed = asyncio.Event()
        # Set once the model stream opened, or the run ended without one: `start` waits for it.
        self._opened = asyncio.Event()
        self._ended = asyncio.Event()
        # True once the work is done and its outcome is being written: a stop no longer applies.
        self._ending = False
        self._stop_reason: _StopReason | None = None
        self._refusal: LlmProviderError | None = None
        self._usage: ModelUsage | None = None
        self._model_calls = 0
        # Last, so the task starts on a fully built run (it first runs at the caller's next await).
        self._work: asyncio.Task[RunSave] = asyncio.create_task(
            work(RunContext(self, model)), name=f"llm-run-work-{run.id}"
        )

    async def subscribe(self) -> AsyncGenerator[RunEvent, None]:
        """Every event so far, then each new one as it comes, until the run's last.

        A subscriber that leaves early (a dropped client closes this generator) never touches the
        run: it finishes and saves without anyone listening.
        """
        sent = 0
        while True:
            changed = self._changed
            while sent < len(self._events):
                yield self._events[sent]
                sent += 1
            if self._ended.is_set():
                return
            await changed.wait()

    def _emit(self, event: RunEvent) -> None:
        self._events.append(event)
        self._notify()

    def _notify(self) -> None:
        changed, self._changed = self._changed, asyncio.Event()
        changed.set()

    def _close(self) -> None:
        self._ended.set()
        self._opened.set()
        self._notify()

    def _stop(self, reason: _StopReason) -> None:
        """Cancels the work while it works; a run already writing its outcome ends as it would."""
        if self._ending or self._stop_reason is not None:
            return
        if self._work.cancel():
            self._stop_reason = reason

    def _record_usage(self, usage: ModelUsage | None) -> None:
        self._usage = usage if self._model_calls == 0 else _sum_usage(self._usage, usage)
        self._model_calls += 1


class RunContext:
    """What a run's work may do: stream the model and emit events."""

    def __init__(self, live: LiveRun, model: NotesModel) -> None:
        self._live = live
        self._model = model

    @property
    def run_id(self) -> UUID:
        return self._live.run_id

    def emit(self, event: RunEvent) -> None:
        """Sends `event` to every subscriber, and buffers it for those who come later."""
        self._live._emit(event)

    @asynccontextmanager
    async def stream(self, request: ModelRequest) -> AsyncIterator[AsyncIterator[ModelEvent]]:
        """`NotesModel.stream` (same contract), metered for the run.

        Opening it lets `start` return. Its usage is added to the run's: a `ModelDone`'s, or a
        cut-off's (billed, though the run fails); unknown when the stream ended without one.
        """
        async with self._model.stream(request) as events:
            self._live._opened.set()
            seen = _StreamUsage()
            async with aclosing(_metered(events, seen)) as metered:
                try:
                    yield metered
                finally:
                    self._live._record_usage(seen.usage)


@dataclass(slots=True)
class _StreamUsage:
    usage: ModelUsage | None = None


async def _metered(
    events: AsyncIterator[ModelEvent], seen: _StreamUsage
) -> AsyncGenerator[ModelEvent, None]:
    try:
        async for event in events:
            if isinstance(event, ModelDone):
                seen.usage = event.usage
            yield event
    except ModelCutOffError as error:
        seen.usage = error.usage
        raise


def _sum_usage(total: ModelUsage | None, usage: ModelUsage | None) -> ModelUsage | None:
    """Two model calls' usage added up (map then reduce, M4-T9). Unknown when either is: a partial
    sum would store a lower cost than the run had, as if it were the whole (`cost_usd` is null
    when unknown, never a guess)."""
    if total is None or usage is None:
        return None
    return ModelUsage(
        input_tokens=_sum(total.input_tokens, usage.input_tokens),
        output_tokens=_sum(total.output_tokens, usage.output_tokens),
        cached_tokens=_sum(total.cached_tokens, usage.cached_tokens),
        reasoning_tokens=_sum(total.reasoning_tokens, usage.reasoning_tokens),
        cost_usd=_sum(total.cost_usd, usage.cost_usd),
    )


def _sum[N: (int, Decimal)](a: N | None, b: N | None) -> N | None:
    return None if a is None or b is None else a + b


class LlmRuntime:
    """What the app holds for its lifetime as `app.state.llm_runtime`: the notes model, and the
    runs this process drives."""

    def __init__(
        self,
        database: Database,
        notes_model: NotesModel,
        *,
        heartbeat_every_s: float = HEARTBEAT_EVERY_S,
    ) -> None:
        self.database = database
        # Routes read `notes_model.model_id(kind)` for the run row they claim.
        self.notes_model = notes_model
        self._heartbeat_every_s = heartbeat_every_s
        self._runs: dict[UUID, LiveRun] = {}
        # Strong references: the event loop keeps only weak ones to tasks.
        self._drivers: set[asyncio.Task[None]] = set()
        self._closed = False

    def find(self, workspace_id: UUID, run_id: UUID) -> LiveRun | None:
        """The run if this process drives it; subscribe to attach to it.

        None for a run that has ended (replay it from its row) and for a `running` row nobody here
        drives: dead, or claimed a moment ago and about to start.
        """
        live = self._runs.get(run_id)
        return live if live is not None and live.workspace_id == workspace_id else None

    async def start(self, run: LlmRun, work: RunWork) -> LiveRun:
        """Drives the claimed `run` in the background; returns once its model stream has opened.

        Raises the `LlmProviderError` of a vendor that refused before the stream opened. The run is
        already stored failed by then, so a re-sent run id replays the failure instead of paying
        for a second run.
        """
        if self._closed:
            raise RuntimeError(f"The LLM runtime is closed; run {run.id} cannot start")
        if run.id in self._runs:
            raise RuntimeError(f"Run {run.id} is already driven here")
        live = LiveRun(run, work, self.notes_model)
        self._runs[run.id] = live
        driver = asyncio.create_task(self._drive(live), name=f"llm-run-{run.id}")
        self._drivers.add(driver)
        driver.add_done_callback(self._drivers.discard)
        # An event, not the task: a client that leaves now cancels this wait, never the run.
        await live._opened.wait()
        if live._refusal is not None:
            raise live._refusal
        return live

    async def cancel(self, workspace_id: UUID, run_id: UUID) -> None:
        """Stops a run; returns once its row says how it ended. The route checks first that the run
        belongs to the meeting and workspace (404).

        A run driven here stops its model and ends `cancelled`; one already saving ends as it would
        have. A `running` row nobody here drives is marked `cancelled` directly: a dead run, or one
        another API process drives, whose next heartbeat then stops it. An ended run is left as is.
        """
        live = self.find(workspace_id, run_id)
        if live is not None:
            live._stop("cancelled")
            await live._ended.wait()
            return
        async with self.database.session() as session:
            ended = await _end_running_row(
                session,
                workspace_id,
                run_id,
                "cancelled",
                error_code="cancelled",
                error=_CANCELLED_MESSAGE,
                usage=None,
            )
            await session.commit()
        if ended:
            logger.info("llm_run_cancelled_undriven", run_id=str(run_id))

    async def aclose(self) -> None:
        """Stops every run still working (stored failed) and waits until all have ended.

        A row left `running` would make every Generate for its meeting a 409 until the sweep, which
        fails it only once its heartbeat is STALE_AFTER old.
        """
        self._closed = True
        for live in list(self._runs.values()):
            live._stop("interrupted")
        if self._drivers:
            await asyncio.wait(set(self._drivers))

    async def _drive(self, live: LiveRun) -> None:
        try:
            await self._wait_for_work(live)
            live._ending = True
            await self._write_outcome(live)
        except Exception as error:
            # Nothing could be stored (the database is away). The row stays `running` until the
            # sweep fails it, which is what a desktop polling the run waits for.
            _log_failure("llm_run_outcome_not_stored", live, error)
            live._emit(error_event("internal_error", _CRASHED_MESSAGE))
        finally:
            # Always, even when this driver is torn down: `start`, `cancel` and every subscriber
            # wait for the run to end.
            live._close()
            self._runs.pop(live.run_id, None)

    async def _wait_for_work(self, live: LiveRun) -> None:
        beat = asyncio.create_task(self._beat(live), name=f"llm-run-heartbeat-{live.run_id}")
        try:
            await asyncio.wait({live._work})
        finally:
            beat.cancel()
            # A no-op once the work is done; stops it if this driver is itself torn down.
            live._work.cancel()
            await asyncio.wait({beat})

    async def _beat(self, live: LiveRun) -> None:
        """Moves the row's heartbeat, on the database clock, while the work runs.

        A row no longer `running` (cancelled or swept by another API process, or its meeting
        deleted) stops the work: nobody keeps paying for an answer that cannot be saved.
        """
        while True:
            await asyncio.sleep(self._heartbeat_every_s)
            try:
                async with self.database.session() as session:
                    beat = await session.scalar(
                        update(LlmRun)
                        .where(*_this_run(live), LlmRun.status == "running")
                        .values(heartbeat_at=func.now())
                        .returning(LlmRun.id)
                    )
                    await session.commit()
            except (SQLAlchemyError, OSError) as error:
                # Retried at the next beat. A database away for STALE_AFTER gets the run swept,
                # the right end for a run that could not save anyway.
                logger.warning(
                    "llm_run_heartbeat_failed", run_id=str(live.run_id), error=repr(error)
                )
                continue
            if beat is None:
                live._stop("interrupted")
                return

    async def _write_outcome(self, live: LiveRun) -> None:
        work = live._work
        if work.cancelled():
            if live._stop_reason == "cancelled":
                await self._fail(live, "cancelled", "cancelled", _CANCELLED_MESSAGE)
            else:
                await self._fail(live, "failed", "internal_error", _INTERRUPTED_MESSAGE)
            return
        error = work.exception()
        if error is None:
            await self._succeed(live, work.result())
        elif isinstance(error, LlmProviderError):
            if not live._opened.is_set():
                live._refusal = error
            await self._fail(live, "failed", "llm_provider_error", error.message)
        elif isinstance(error, ModelCutOffError):
            await self._fail(live, "failed", "cut_off", str(error))
        else:
            _log_failure("llm_run_crashed", live, error)
            await self._fail(live, "failed", "internal_error", _CRASHED_MESSAGE)

    async def _succeed(self, live: LiveRun, save: RunSave) -> None:
        try:
            async with self.database.session() as session:
                events = await save(session)
                ended = await _end_running_row(
                    session,
                    live.workspace_id,
                    live.run_id,
                    "succeeded",
                    error_code=None,
                    error=None,
                    usage=live._usage,
                )
                # Not ended: leaving the block without a commit rolls the save back too.
                if ended:
                    await session.commit()
        except Exception as error:
            # Whatever broke the save (a deleted meeting, a bug in it), the run must still end. A
            # commit that landed and then raised ends as stored (`_emit_stored_ending`).
            _log_failure("llm_run_save_failed", live, error)
            await self._fail(live, "failed", "internal_error", _CRASHED_MESSAGE)
            return
        if not ended:
            await self._emit_stored_ending(live)
            return
        _log_ended(live, "succeeded", None)
        for event in events:
            live._emit(event)

    async def _fail(
        self, live: LiveRun, status: _EndStatus, code: RunErrorCode, message: str
    ) -> None:
        async with self.database.session() as session:
            ended = await _end_running_row(
                session,
                live.workspace_id,
                live.run_id,
                status,
                error_code=code,
                error=message,
                usage=live._usage,
            )
            await session.commit()
        if not ended:
            await self._emit_stored_ending(live)
            return
        _log_ended(live, status, code)
        live._emit(error_event(code, message))

    async def _emit_stored_ending(self, live: LiveRun) -> None:
        """The row had already ended (swept, cancelled by another API process, or saved here by a
        commit that raised): subscribers are told that ending, never one this process made up."""
        async with self.database.session() as session:
            row = (
                await session.execute(
                    select(LlmRun.status, LlmRun.error_code, LlmRun.error).where(*_this_run(live))
                )
            ).one_or_none()
        if row is None:
            ending = error_event("internal_error", _GONE_MESSAGE)
        else:
            status, code, message = row
            if status == "succeeded":
                # Only `_succeed` writes `succeeded`: its commit reached Postgres, then raised (the
                # connection dropped before the acknowledgement). Never an `error` for notes that
                # were paid for and saved, whose Retry would pay again. The save's `done` events
                # stayed in `_succeed`: a stream ending with no `done` or `error` makes the desktop
                # load the stored run (M4 plan, Streaming).
                _log_ended(live, "succeeded", None)
                return
            ending = error_event(_stored_error_code(code), message or _CRASHED_MESSAGE)
        logger.warning("llm_run_ended_elsewhere", run_id=str(live.run_id), kind=live.kind)
        live._emit(ending)


def _this_run(live: LiveRun) -> tuple[ColumnElement[bool], ColumnElement[bool]]:
    return LlmRun.id == live.run_id, LlmRun.workspace_id == live.workspace_id


def _stored_error_code(code: str | None) -> RunErrorCode:
    match code:
        case "llm_provider_error" | "cut_off" | "cancelled" | "internal_error":
            return code
        case _:
            return "internal_error"


async def _end_running_row(
    session: AsyncSession,
    workspace_id: UUID,
    run_id: UUID,
    status: _EndStatus,
    *,
    error_code: RunErrorCode | None,
    error: str | None,
    usage: ModelUsage | None,
) -> bool:
    """Ends the run if it is still `running`, with its usage. False when it had already ended.

    A run that does not succeed also fails its streaming chat answer, so no message is left
    `streaming` for a run that is over.
    """
    ended = await session.scalar(
        update(LlmRun)
        .where(LlmRun.id == run_id, LlmRun.workspace_id == workspace_id, LlmRun.status == "running")
        .values(
            status=status,
            error_code=error_code,
            error=error,
            finished_at=func.now(),
            input_tokens=usage.input_tokens if usage else None,
            output_tokens=usage.output_tokens if usage else None,
            cached_tokens=usage.cached_tokens if usage else None,
            cost_usd=usage.cost_usd if usage else None,
        )
        .returning(LlmRun.id)
    )
    if ended is None:
        return False
    if status != "succeeded":
        await session.execute(
            update(ChatMessage)
            .where(
                ChatMessage.run_id == run_id,
                ChatMessage.workspace_id == workspace_id,
                ChatMessage.status == "streaming",
            )
            .values(status="failed")
        )
    return True


async def _fail_stale_runs(session: AsyncSession, *scope: ColumnElement[bool]) -> Sequence[UUID]:
    """Fails `running` runs whose heartbeat is older than STALE_AFTER, and their streaming chat
    answers. Both sides of the age check are the database clock, so a skewed API host clock never
    fails a live run (`LlmRun.heartbeat_at`)."""
    stale = (
        await session.scalars(
            update(LlmRun)
            .where(
                LlmRun.status == "running",
                LlmRun.heartbeat_at < func.now() - STALE_AFTER,
                *scope,
            )
            .values(
                status="failed",
                error_code="internal_error",
                error=_STALE_MESSAGE,
                finished_at=func.now(),
            )
            .returning(LlmRun.id)
        )
    ).all()
    if stale:
        # By run id alone: the ids come from the scoped update above, so its scope holds here.
        await session.execute(
            update(ChatMessage)
            .where(ChatMessage.run_id.in_(stale), ChatMessage.status == "streaming")
            .values(status="failed")
        )
    return stale


async def claim_run(session: AsyncSession, run: LlmRun) -> None:
    """Inserts the new `run` (status `running`) after failing its meeting's dead runs. Does not
    commit: the caller commits before `start` (see the module's first trap).

    The sweep runs before every claim, not only at startup: a dead `running` row holds the
    one-running-notes-run index for good, and every later Generate for its meeting would be a 409.
    Raises ConflictError when the meeting has a notes run that is alive.
    """
    stale = await _fail_stale_runs(
        session, LlmRun.workspace_id == run.workspace_id, LlmRun.meeting_id == run.meeting_id
    )
    if stale:
        logger.warning("llm_runs_failed_as_stale", count=len(stale), meeting_id=str(run.meeting_id))
    session.add(run)
    try:
        await session.flush()
    except IntegrityError as error:
        if ONE_RUNNING_NOTES_RUN_INDEX not in str(error.orig):
            raise
        raise ConflictError(
            f"A notes run is already running for meeting {run.meeting_id}"
        ) from error


@asynccontextmanager
async def open_llm_runtime(settings: Settings) -> AsyncIterator[LlmRuntime]:
    """Entered by the app lifespan. Fails the runs a stopped API process left `running`, opens the
    notes model, and on exit stops the runs still working (stored failed) before closing both.

    The runtime has a `Database` (and pool) of its own: its runs write long after the request that
    started them, and app.py hands the runtimes it opens only `settings`.
    """
    database = Database(settings.database_url)
    try:
        await _fail_stale_runs_at_startup(database)
        async with open_notes_model(settings) as notes_model:
            runtime = LlmRuntime(database, notes_model)
            try:
                yield runtime
            finally:
                await runtime.aclose()
    finally:
        await database.dispose()


async def _fail_stale_runs_at_startup(database: Database) -> None:
    # Every workspace's: this is the API's own upkeep, run before any principal exists. The
    # update writes only status columns, and each row keeps its workspace_id.
    try:
        async with database.session() as session:
            stale = await _fail_stale_runs(session)
            await session.commit()
    except (SQLAlchemyError, OSError):
        logger.error(
            "llm_runs_sweep_failed",
            hint="Is the database migrated to head (llm_runs, revision 0003)? Try: make migrate",
        )
        raise
    if stale:
        logger.warning("llm_runs_failed_as_stale", count=len(stale), during="startup")


def _log_ended(live: LiveRun, status: _EndStatus, code: RunErrorCode | None) -> None:
    usage = live._usage
    logger.info(
        "llm_run_ended",
        run_id=str(live.run_id),
        meeting_id=str(live.meeting_id),
        kind=live.kind,
        status=status,
        error_code=code,
        model_calls=live._model_calls,
        input_tokens=usage.input_tokens if usage else None,
        output_tokens=usage.output_tokens if usage else None,
        cached_tokens=usage.cached_tokens if usage else None,
        cost_usd=str(usage.cost_usd) if usage and usage.cost_usd is not None else None,
    )


def _log_failure(event: str, live: LiveRun, error: BaseException) -> None:
    """Logs what failed and where, never the exception's text or traceback.

    In production `dict_tracebacks` renders every frame's locals (structlog's default) and the
    exception's text. A run's frames hold the transcript, and its exceptions can quote it, and
    transcript text never goes to the log. The type and the innermost frame locate the bug.
    """
    frames = traceback.extract_tb(error.__traceback__)
    where = (
        f"{Path(frames[-1].filename).name}:{frames[-1].lineno} in {frames[-1].name}"
        if frames
        else None
    )
    logger.error(
        event,
        run_id=str(live.run_id),
        meeting_id=str(live.meeting_id),
        kind=live.kind,
        error_type=type(error).__name__,
        where=where,
    )


def get_llm_runtime(request: Request) -> LlmRuntime:
    runtime = getattr(request.app.state, "llm_runtime", None)
    if not isinstance(runtime, LlmRuntime):
        raise RuntimeError("app.state.llm_runtime is not set; build the app with create_app()")
    return runtime


LlmRuntimeDep = Annotated[LlmRuntime, Depends(get_llm_runtime)]
