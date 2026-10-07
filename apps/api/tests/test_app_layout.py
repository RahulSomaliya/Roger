"""The Phase 2 seams in `create_app` (phase-2-build-order.md, section 1): every feature router is
included exactly once, and the lifespan holds the LLM and calendar runtimes beside the STT token
issuer, so their owners fill their own modules and never edit app.py."""

from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager

import pytest
from asgi_lifespan import LifespanManager
from fastapi import APIRouter, FastAPI
from fastapi.routing import iter_route_contexts

import roger_api.app as app_module
from roger_api.app import create_app
from roger_api.config import Settings
from roger_api.routers import (
    calendar,
    chat,
    note_templates,
    notes,
    notes_runs,
    stt_usage,
    vocabulary,
)
from roger_api.services.calendar.runtime import CalendarRuntime
from roger_api.services.llm_runs import LlmRuntime
from tests.conftest import make_settings

# Building the app opens no connection, so any well-formed URL will do.
DATABASE_URL = "postgresql+asyncpg://postgres@localhost:5432/roger_test"
PROBE_PATH = "/phase-2-probe"


async def _probe() -> None:
    return None


@pytest.mark.parametrize(
    "router",
    [
        pytest.param(vocabulary.router, id="vocabulary (M3-T2)"),
        pytest.param(stt_usage.router, id="stt_usage (M3-T19a)"),
        pytest.param(note_templates.router, id="note_templates (M4-T3)"),
        pytest.param(notes.router, id="notes (M4-T6)"),
        pytest.param(notes_runs.router, id="notes_runs (M4-T8)"),
        pytest.param(chat.router, id="chat (M4-T10)"),
        pytest.param(calendar.router, id="calendar (M5-T3)"),
    ],
)
def test_feature_router_is_included_once(
    router: APIRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A stub router has no routes, so inclusion is invisible; a probe route on a copy of its route
    # list (put back after the test) shows where create_app mounts it, and how many times.
    monkeypatch.setattr(router, "routes", list(router.routes))
    router.add_api_route(PROBE_PATH, _probe)

    app = create_app(make_settings(DATABASE_URL))

    paths = [route.path for route in iter_route_contexts(app.routes)]
    assert paths.count(router.prefix + PROBE_PATH) == 1


async def test_lifespan_holds_the_llm_and_calendar_runtimes(app: FastAPI) -> None:
    # Their owners' FastAPI getters (services/llm_runs.py, services/calendar/runtime.py) read
    # these two names.
    assert isinstance(app.state.llm_runtime, LlmRuntime)
    assert isinstance(app.state.calendar_runtime, CalendarRuntime)


type RuntimeOpener = Callable[[Settings], AbstractAsyncContextManager[object]]


async def test_lifespan_opens_the_runtimes_at_startup_and_closes_them_at_shutdown(
    settings: Settings, clean_database: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[str] = []

    def recording(name: str, runtime: object) -> RuntimeOpener:
        @asynccontextmanager
        async def open_runtime(_: Settings) -> AsyncIterator[object]:
            events.append(f"open {name}")
            yield runtime
            events.append(f"close {name}")

        return open_runtime

    llm_runtime, calendar_runtime = object(), object()
    monkeypatch.setattr(app_module, "open_llm_runtime", recording("llm", llm_runtime))
    monkeypatch.setattr(
        app_module, "open_calendar_runtime", recording("calendar", calendar_runtime)
    )
    application = create_app(settings)

    async with LifespanManager(application):
        assert application.state.llm_runtime is llm_runtime
        assert application.state.calendar_runtime is calendar_runtime
        assert events == ["open llm", "open calendar"]

    assert events == ["open llm", "open calendar", "close calendar", "close llm"]
