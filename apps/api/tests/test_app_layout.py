"""The Phase 2 seams in `create_app` (phase-2-build-order.md, section 1): every feature router is
included exactly once, so its owner fills its own module and never edits app.py."""

import pytest
from fastapi import APIRouter
from fastapi.routing import iter_route_contexts

from roger_api.app import create_app
from roger_api.routers import (
    calendar,
    chat,
    note_templates,
    notes,
    notes_runs,
    stt_usage,
    vocabulary,
)
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
