import re
import time
from uuid import uuid4

import structlog
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from roger_api.error_handlers import internal_error_response
from roger_api.log import get_logger

REQUEST_ID_HEADER = "X-Request-ID"
# Accept a caller's id only if it is safe to echo and to write into logs.
_VALID_REQUEST_ID = re.compile(r"[A-Za-z0-9._:=+/-]{1,128}")

logger = get_logger("roger_api.access")


class RequestContextMiddleware:
    """Request id in and out, one structured access line per request, and the 500 envelope.

    Unexpected exceptions are handled here rather than in a FastAPI exception handler so that
    the 500 response still carries `X-Request-ID` and the access line still gets written.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming = Headers(scope=scope).get(REQUEST_ID_HEADER, "")
        request_id = incoming if _VALID_REQUEST_ID.fullmatch(incoming) else str(uuid4())
        started = time.perf_counter()
        status_code = 500
        response_started = False

        async def send_with_request_id(message: Message) -> None:
            nonlocal status_code, response_started
            if message["type"] == "http.response.start":
                response_started = True
                status_code = int(message["status"])  # some apps send an HTTPStatus
                MutableHeaders(scope=message).append(REQUEST_ID_HEADER, request_id)
            await send(message)

        with structlog.contextvars.bound_contextvars(request_id=request_id):
            try:
                await self.app(scope, receive, send_with_request_id)
            except Exception:
                logger.exception("unhandled_exception", method=scope["method"], path=scope["path"])
                if response_started:
                    raise
                await internal_error_response()(scope, receive, send_with_request_id)
            finally:
                logger.info(
                    "request",
                    method=scope["method"],
                    path=scope["path"],
                    status=status_code,
                    duration_ms=round((time.perf_counter() - started) * 1000, 1),
                )
