"""Typed application errors. Each maps to one HTTP status and one envelope `code`."""

from typing import ClassVar


class AppError(Exception):
    status_code: ClassVar[int] = 500
    code: ClassVar[str] = "internal_error"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class UnauthorizedError(AppError):
    status_code = 401
    code = "unauthorized"


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"


class ConflictError(AppError):
    status_code = 409
    code = "conflict"


class SttProviderError(AppError):
    """The speech-to-text vendor failed or answered with something we cannot use."""

    status_code = 502
    code = "stt_provider_error"


# Phase 2 errors, added together before their features (phase-2-build-order.md, section 1) so
# parallel tasks never edit this file. Each code has its row in docs/api-contract.md's error table;
# tests/test_errors.py fails without it.


class LlmProviderError(AppError):
    """The notes model's vendor refused, failed or answered with something we cannot use (M4-T2)."""

    status_code = 502
    code = "llm_provider_error"


class EmptyMeetingError(AppError):
    """Notes were asked for a meeting with no transcript lines and no user notes (M4-T8)."""

    status_code = 422
    code = "empty_meeting"


class MeetingTooLongError(AppError):
    """The meeting is over the chat model's input budget (M4-T10)."""

    status_code = 422
    code = "meeting_too_long"


class CalendarProviderError(AppError):
    """Google Calendar is unreachable or answered with an error we cannot use (M5-T2)."""

    status_code = 502
    code = "calendar_provider_error"


class CalendarReconnectRequiredError(AppError):
    """Google refused the stored refresh token, or calendar access was not granted (M5-T2).

    The message says what to do: the user reconnects the calendar.
    """

    status_code = 424
    code = "calendar_reconnect_required"


class CalendarNotConfiguredError(AppError):
    """The API has no calendar provider: no Google client is set and `CALENDAR_PROVIDER` is not
    `fake` (the calendar-provider honesty change). Nothing the user does in the app fixes it, so
    the message says the server is not set up; 503 is the "not available here" status."""

    status_code = 503
    code = "calendar_not_configured"
