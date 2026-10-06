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
