"""Every error leaves the API in the contract's envelope: {"error": {"code", "message"}}."""

from collections.abc import Mapping, Sequence
from http import HTTPStatus

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from roger_api.errors import AppError, UnauthorizedError
from roger_api.schemas.common import ErrorBody, ErrorEnvelope

MAX_LISTED_VALIDATION_ERRORS = 10
WWW_AUTHENTICATE = {"WWW-Authenticate": "Bearer"}

_CODES_BY_STATUS = {
    401: "unauthorized",
    404: "not_found",
    409: "conflict",
    422: "validation_error",
    500: "internal_error",
}


def error_response(
    status_code: int, code: str, message: str, headers: Mapping[str, str] | None = None
) -> JSONResponse:
    envelope = ErrorEnvelope(error=ErrorBody(code=code, message=message))
    return JSONResponse(envelope.model_dump(), status_code=status_code, headers=headers)


def unauthorized_response(message: str) -> JSONResponse:
    return error_response(401, UnauthorizedError.code, message, WWW_AUTHENTICATE)


def internal_error_response() -> JSONResponse:
    return error_response(500, "internal_error", "Internal server error")


def code_for_status(status_code: int) -> str:
    """Contract codes for the statuses it names; snake_case of the reason phrase otherwise."""
    if status_code in _CODES_BY_STATUS:
        return _CODES_BY_STATUS[status_code]
    return HTTPStatus(status_code).phrase.lower().replace(" ", "_").replace("-", "_")


def describe_validation_errors(errors: Sequence[Mapping[str, object]]) -> str:
    """`body.segments[0].text: String should have at least 1 character; ...`"""
    described = [
        f"{_location(error.get('loc'))}: {_reason(error.get('msg'))}"
        for error in errors[:MAX_LISTED_VALIDATION_ERRORS]
    ]
    if len(errors) > MAX_LISTED_VALIDATION_ERRORS:
        described.append(f"and {len(errors) - MAX_LISTED_VALIDATION_ERRORS} more")
    return "Invalid request: " + "; ".join(described)


def _location(loc: object) -> str:
    if not isinstance(loc, tuple | list):
        return "request"
    path = ""
    for part in loc:
        path += f"[{part}]" if isinstance(part, int) else f".{part}" if path else str(part)
    return path or "request"


def _reason(msg: object) -> str:
    return str(msg).removeprefix("Value error, ")


async def _handle_app_error(_: Request, exc: AppError) -> JSONResponse:
    headers = WWW_AUTHENTICATE if isinstance(exc, UnauthorizedError) else None
    return error_response(exc.status_code, exc.code, exc.message, headers)


async def _handle_http_exception(_: Request, exc: HTTPException) -> JSONResponse:
    return error_response(
        exc.status_code, code_for_status(exc.status_code), str(exc.detail), exc.headers
    )


async def _handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    return error_response(422, "validation_error", describe_validation_errors(exc.errors()))


def register_error_handlers(app: FastAPI) -> None:
    """Unexpected exceptions become a 500 envelope in `RequestContextMiddleware`."""
    app.exception_handler(AppError)(_handle_app_error)
    app.exception_handler(HTTPException)(_handle_http_exception)
    app.exception_handler(RequestValidationError)(_handle_validation_error)
