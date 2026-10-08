"""Every typed error leaves the API in the contract's envelope, and the contract lists its code."""

import httpx
import pytest
from fastapi import FastAPI

from roger_api.config import REPO_ROOT_ENV_FILE
from roger_api.errors import (
    AppError,
    CalendarNotConfiguredError,
    CalendarProviderError,
    CalendarReconnectRequiredError,
    EmptyMeetingError,
    LlmProviderError,
    MeetingTooLongError,
)
from tests.helpers import assert_error

API_CONTRACT = REPO_ROOT_ENV_FILE.parent / "docs" / "api-contract.md"


@pytest.mark.parametrize(
    ("error", "status_code", "code"),
    [
        (LlmProviderError, 502, "llm_provider_error"),
        (EmptyMeetingError, 422, "empty_meeting"),
        (MeetingTooLongError, 422, "meeting_too_long"),
        (CalendarProviderError, 502, "calendar_provider_error"),
        (CalendarReconnectRequiredError, 424, "calendar_reconnect_required"),
        (CalendarNotConfiguredError, 503, "calendar_not_configured"),
    ],
)
async def test_phase_2_error_uses_the_envelope(
    app: FastAPI, client: httpx.AsyncClient, error: type[AppError], status_code: int, code: str
) -> None:
    async def fail() -> None:
        raise error("Reconnect Google Calendar in Settings.")

    app.add_api_route("/fail", fail)

    message = assert_error(await client.get("/fail"), status_code, code)
    assert message == "Reconnect Google Calendar in Settings."


def _error_classes(base: type[AppError]) -> list[type[AppError]]:
    found = [base]
    for subclass in base.__subclasses__():
        found += _error_classes(subclass)
    return found


@pytest.mark.parametrize("error", _error_classes(AppError), ids=lambda error: error.__name__)
def test_the_contract_lists_every_error_code(error: type[AppError]) -> None:
    # House rule 8: the contract is a document first. An error class without its row in the
    # error table is a status the desktop has never heard of.
    row = f"| {error.status_code} | `{error.code}` |"

    assert row in API_CONTRACT.read_text(), f"docs/api-contract.md has no row starting {row!r}"
