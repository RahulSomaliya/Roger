"""The Phase 2 value lists. Each is also a database check constraint and a desktop type, so a
change here is a change to a migration and to the contract in the same commit."""

from typing import TypeAliasType, get_args

import pytest

from roger_api.domain import NoteKind, RunKind, RunStatus, StartSource


@pytest.mark.parametrize(
    ("alias", "values"),
    [
        pytest.param(NoteKind, ("user", "ai"), id="NoteKind"),
        pytest.param(RunKind, ("notes", "chat"), id="RunKind"),
        pytest.param(RunStatus, ("running", "succeeded", "failed", "cancelled"), id="RunStatus"),
        # All five from day one: M2's call-detected offer stores `call_detected` (M5 plan, D5).
        pytest.param(
            StartSource,
            ("manual", "notification", "home", "tray", "call_detected"),
            id="StartSource",
        ),
    ],
)
def test_phase_2_value_lists(alias: TypeAliasType, values: tuple[str, ...]) -> None:
    assert get_args(alias.__value__) == values
