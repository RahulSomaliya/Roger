"""The Google Calendar provider (M5-T2), with Google mocked by `httpx.MockTransport`.

Never calls Google: every request goes to a handler in this file.
"""

import ast
import base64
import json
import shutil
import subprocess
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import structlog
from structlog.testing import CapturedCall, CapturingLogger

import roger_api
from roger_api.errors import AppError, CalendarProviderError, CalendarReconnectRequiredError
from roger_api.services.calendar import google
from roger_api.services.calendar.google import (
    CALENDAR_SCOPE,
    GOOGLE_AUTHORIZATION_URL,
    GOOGLE_EVENTS_URL,
    GOOGLE_REVOKE_URL,
    GOOGLE_TOKEN_URL,
    MAX_EVENT_PAGES,
    GoogleCalendarProvider,
)
from roger_api.services.calendar.provider import (
    AccessToken,
    CalendarAccessTokenRejectedError,
    CalendarGrant,
    CalendarProvider,
)

API_DIR = Path(__file__).resolve().parents[1]
BANNED_IMPORTS = ("jwt", "cryptography")


def _imported_modules(tree: ast.AST) -> list[str]:
    names: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None and node.level == 0:
            names.append(node.module)
    return names


def test_no_jwt_or_cryptography_import() -> None:
    # Both are installed only because `mcp` pulls in `pyjwt[crypto]`: importing either adds a
    # dependency uv.lock does not declare, which breaks the day `mcp` drops it.
    package = Path(roger_api.__file__).parent
    offenders = [
        f"{path.relative_to(package)}: {name}"
        for path in sorted(package.rglob("*.py"))
        for name in _imported_modules(ast.parse(path.read_text(encoding="utf-8")))
        if name.split(".")[0] in BANNED_IMPORTS
    ]
    assert offenders == []


@pytest.mark.parametrize(
    "source",
    [
        "import jwt\n",
        "from jwt import decode\n",
        "import cryptography\n",
        "import cryptography.fernet\n",
        "from cryptography.fernet import Fernet\n",
    ],
)
def test_ruff_refuses_jwt_and_cryptography(source: str) -> None:
    # The ast walk above checks today's code; this proves the ruff rule in pyproject.toml is live,
    # so `make check` refuses the import before it is ever committed.
    ruff = shutil.which("ruff")
    assert ruff is not None, "ruff is not on PATH"
    result = subprocess.run(  # noqa: S603 - fixed argv from this file, no shell.
        [ruff, "check", "--no-cache", "--select", "TID251", "--stdin-filename", "probe.py", "-"],
        cwd=API_DIR,
        input=source,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1, result.stdout + result.stderr
    assert "TID251" in result.stdout


# Fixtures and fake Google -----------------------------------------------------------------------

FIXTURES = Path(__file__).parent / "fixtures" / "calendar"
CLIENT_ID = "123456789012-roger.apps.googleusercontent.com"
CLIENT_SECRET = "GOCSPX-client-secret-value"
REDIRECT_URI = "http://127.0.0.1:53682/oauth/callback"
CODE = "4/0AVG7fiQ-one-time-authorization-code"
VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
REFRESH_TOKEN = "1//0g-refresh-token-value"
ACCESS_TOKEN = "ya29.access-token-value"
# Google reports `email` as its full scope name.
GRANTED_SCOPES = (
    "openid https://www.googleapis.com/auth/userinfo.email "
    "https://www.googleapis.com/auth/calendar.events.readonly"
)
SECRETS = (CLIENT_SECRET, CODE, VERIFIER, REFRESH_TOKEN, ACCESS_TOKEN)

type Json = dict[str, Any]
type Handler = Callable[[httpx.Request], httpx.Response]


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def id_token(claims: Json) -> str:
    """An ID token as Google's token endpoint returns it. The signature is never checked."""
    header = b64url(json.dumps({"alg": "RS256", "kid": "k1", "typ": "JWT"}).encode())
    return f"{header}.{b64url(json.dumps(claims).encode())}.bm90LWEtc2lnbmF0dXJl"


def token_response(**fields: object) -> Json:
    body: Json = {
        "access_token": ACCESS_TOKEN,
        "expires_in": 3599,
        "refresh_token": REFRESH_TOKEN,
        "scope": GRANTED_SCOPES,
        "token_type": "Bearer",
        "id_token": id_token({"aud": CLIENT_ID, "email": "priya@linkt.ai"}),
    }
    body.update(fields)
    return {key: value for key, value in body.items() if value is not None}


def calendar_provider(handler: Handler) -> GoogleCalendarProvider:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return GoogleCalendarProvider(http, client_id=CLIENT_ID, client_secret=CLIENT_SECRET)


def recording(seen: list[httpx.Request], answer: Handler) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answer(request)

    return handler


def form(request: httpx.Request) -> dict[str, str]:
    assert request.headers["Content-Type"] == "application/x-www-form-urlencoded"
    fields = parse_qs(request.content.decode(), keep_blank_values=True, strict_parsing=True)
    assert all(len(values) == 1 for values in fields.values()), fields
    return {name: values[0] for name, values in fields.items()}


def oauth_error(status: int, error: str) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": error, "error_description": "Bad Request"})

    return handler


def api_error(status: int, reason: str) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            json={
                "error": {
                    "code": status,
                    "message": "Request refused.",
                    "errors": [{"domain": "global", "reason": reason, "message": "Refused."}],
                    "status": "PERMISSION_DENIED" if status == 403 else "UNKNOWN",
                }
            },
        )

    return handler


def server_error(request: httpx.Request) -> httpx.Response:
    return httpx.Response(503, text="<html>Service Unavailable</html>")


def timeout(request: httpx.Request) -> httpx.Response:
    raise httpx.ReadTimeout("timed out", request=request)


def unreachable(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused", request=request)


def not_json(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, text="<html>")


@pytest.fixture
def google_logs(monkeypatch: pytest.MonkeyPatch) -> list[CapturedCall]:
    # The module's own logger, swapped: create_app configures structlog with
    # cache_logger_on_first_use, so a logger an earlier test used would bypass `capture_logs`.
    capturing = CapturingLogger()
    monkeypatch.setattr(
        google,
        "logger",
        structlog.wrap_logger(capturing, processors=[], wrapper_class=structlog.stdlib.BoundLogger),
    )
    return capturing.calls


def test_google_provider_is_a_calendar_provider() -> None:
    calendar: CalendarProvider = calendar_provider(server_error)

    assert calendar.provider == "google"


# Authorization URL -------------------------------------------------------------------------------


def test_authorization_url_is_exact() -> None:
    url = calendar_provider(server_error).authorization_url(
        redirect_uri=REDIRECT_URI, code_challenge=CHALLENGE, state="st-8f2c"
    )

    parts = urlsplit(url)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == GOOGLE_AUTHORIZATION_URL
    assert GOOGLE_AUTHORIZATION_URL == "https://accounts.google.com/o/oauth2/v2/auth"
    assert parse_qs(parts.query, strict_parsing=True) == {
        "client_id": [CLIENT_ID],
        "redirect_uri": [REDIRECT_URI],
        "response_type": ["code"],
        "scope": ["openid email https://www.googleapis.com/auth/calendar.events.readonly"],
        "code_challenge": [CHALLENGE],
        "code_challenge_method": ["S256"],
        "state": ["st-8f2c"],
        "access_type": ["offline"],
        "prompt": ["consent"],
        "include_granted_scopes": ["true"],
    }
    assert parts.fragment == ""


# Code exchange -----------------------------------------------------------------------------------


async def test_exchange_sends_code_verifier_secret_and_redirect() -> None:
    seen: list[httpx.Request] = []

    grant = await calendar_provider(
        recording(seen, lambda _: httpx.Response(200, json=token_response()))
    ).exchange_code(code=CODE, code_verifier=VERIFIER, redirect_uri=REDIRECT_URI)

    [request] = seen
    assert request.method == "POST"
    assert str(request.url) == GOOGLE_TOKEN_URL == "https://oauth2.googleapis.com/token"
    assert form(request) == {
        "grant_type": "authorization_code",
        "code": CODE,
        "code_verifier": VERIFIER,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "redirect_uri": REDIRECT_URI,
    }
    assert grant == CalendarGrant(
        account_email="priya@linkt.ai",
        scopes=(
            "openid",
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/calendar.events.readonly",
        ),
        refresh_token=REFRESH_TOKEN,
        access_token=AccessToken(value=ACCESS_TOKEN, expires_in_seconds=3599),
    )


async def test_exchange_reads_the_email_from_the_id_token_with_stdlib_decoding() -> None:
    # `~~~` and `???` encode to `-` and `_` in base64url, and the length leaves the padding off:
    # a decoder that expects standard base64 or padding fails here.
    claims = {
        "email": "jane.doe@linkt.ai",
        "name": "~~~???>>>",
        "email_verified": True,
        "iat": 1759737600,
    }
    token = id_token(claims)
    payload = token.split(".")[1]
    assert "-" in payload
    assert "_" in payload
    assert len(payload) % 4 != 0

    grant = await calendar_provider(
        lambda _: httpx.Response(200, json=token_response(id_token=token))
    ).exchange_code(code=CODE, code_verifier=VERIFIER, redirect_uri=REDIRECT_URI)

    assert grant.account_email == "jane.doe@linkt.ai"


async def test_exchange_refuses_a_grant_without_the_calendar_scope() -> None:
    # The user unticked "View events on all your calendars" on Google's consent screen.
    answer = token_response(scope="openid https://www.googleapis.com/auth/userinfo.email")

    with pytest.raises(CalendarReconnectRequiredError) as raised:
        await calendar_provider(lambda _: httpx.Response(200, json=answer)).exchange_code(
            code=CODE, code_verifier=VERIFIER, redirect_uri=REDIRECT_URI
        )

    assert "tick" in raised.value.message
    assert "View events on all your calendars" in raised.value.message
    assert CALENDAR_SCOPE == "https://www.googleapis.com/auth/calendar.events.readonly"


async def test_exchange_with_a_used_or_expired_code_is_reconnect_required() -> None:
    with pytest.raises(CalendarReconnectRequiredError):
        await calendar_provider(oauth_error(400, "invalid_grant")).exchange_code(
            code=CODE, code_verifier=VERIFIER, redirect_uri=REDIRECT_URI
        )


@pytest.mark.parametrize(
    "handler",
    [
        pytest.param(oauth_error(401, "invalid_client"), id="client misconfigured"),
        pytest.param(oauth_error(400, "redirect_uri_mismatch"), id="redirect mismatch"),
        pytest.param(server_error, id="5xx"),
        pytest.param(timeout, id="timeout"),
        pytest.param(unreachable, id="unreachable"),
        pytest.param(not_json, id="not json"),
        pytest.param(
            lambda _: httpx.Response(200, json=token_response(refresh_token=None)),
            id="no refresh token",
        ),
        pytest.param(
            lambda _: httpx.Response(200, json=token_response(id_token=None)), id="no id token"
        ),
        pytest.param(
            lambda _: httpx.Response(200, json=token_response(id_token="not-a-jwt")),
            id="id token not three parts",
        ),
        pytest.param(
            lambda _: httpx.Response(200, json=token_response(id_token="a.%%%%.c")),
            id="id token payload not base64",
        ),
        pytest.param(
            lambda _: httpx.Response(200, json=token_response(id_token=id_token({"sub": "1"}))),
            id="id token without email",
        ),
    ],
)
async def test_exchange_failures_are_provider_errors(handler: Handler) -> None:
    with pytest.raises(CalendarProviderError):
        await calendar_provider(handler).exchange_code(
            code=CODE, code_verifier=VERIFIER, redirect_uri=REDIRECT_URI
        )


# Refresh -----------------------------------------------------------------------------------------


async def test_refresh_sends_the_refresh_token_and_secret() -> None:
    seen: list[httpx.Request] = []
    answer = {"access_token": "ya29.fresh", "expires_in": 3599, "scope": GRANTED_SCOPES}

    token = await calendar_provider(
        recording(seen, lambda _: httpx.Response(200, json=answer))
    ).refresh(REFRESH_TOKEN)

    [request] = seen
    assert request.method == "POST"
    assert str(request.url) == GOOGLE_TOKEN_URL
    assert form(request) == {
        "grant_type": "refresh_token",
        "refresh_token": REFRESH_TOKEN,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
    }
    assert token == AccessToken(value="ya29.fresh", expires_in_seconds=3599)


async def test_refresh_invalid_grant_is_reconnect_required() -> None:
    # Revoked, expired (7 days in External Testing) or removed on Google's account page.
    with pytest.raises(CalendarReconnectRequiredError) as raised:
        await calendar_provider(oauth_error(400, "invalid_grant")).refresh(REFRESH_TOKEN)

    assert "Reconnect Google Calendar" in raised.value.message


async def test_refresh_without_a_stored_token_is_reconnect_required() -> None:
    seen: list[httpx.Request] = []

    with pytest.raises(CalendarReconnectRequiredError):
        await calendar_provider(recording(seen, server_error)).refresh(None)

    assert seen == []


@pytest.mark.parametrize(
    "handler",
    [
        pytest.param(server_error, id="503"),
        pytest.param(lambda _: httpx.Response(500, json={"error": "internal_failure"}), id="500"),
        pytest.param(timeout, id="timeout"),
        pytest.param(unreachable, id="unreachable"),
        pytest.param(oauth_error(401, "invalid_client"), id="client misconfigured"),
        pytest.param(not_json, id="not json"),
        pytest.param(
            lambda _: httpx.Response(200, json={"access_token": ACCESS_TOKEN}), id="no expiry"
        ),
    ],
)
async def test_refresh_server_errors_and_timeouts_are_provider_errors(handler: Handler) -> None:
    with pytest.raises(CalendarProviderError) as raised:
        await calendar_provider(handler).refresh(REFRESH_TOKEN)

    assert not isinstance(raised.value, CalendarReconnectRequiredError)


# Revoke ------------------------------------------------------------------------------------------


async def test_revoke_posts_the_refresh_token() -> None:
    seen: list[httpx.Request] = []

    await calendar_provider(recording(seen, lambda _: httpx.Response(200))).revoke(REFRESH_TOKEN)

    [request] = seen
    assert request.method == "POST"
    assert str(request.url) == GOOGLE_REVOKE_URL == "https://oauth2.googleapis.com/revoke"
    assert form(request) == {"token": REFRESH_TOKEN}


async def test_revoke_without_a_stored_token_calls_nothing() -> None:
    seen: list[httpx.Request] = []

    await calendar_provider(recording(seen, server_error)).revoke(None)

    assert seen == []


@pytest.mark.parametrize(
    "handler",
    [
        pytest.param(oauth_error(400, "invalid_token"), id="already revoked"),
        pytest.param(server_error, id="5xx"),
        pytest.param(timeout, id="timeout"),
        pytest.param(unreachable, id="unreachable"),
    ],
)
async def test_revoke_failures_are_provider_errors(handler: Handler) -> None:
    # The route logs this and deletes the connection anyway (M5-T3).
    with pytest.raises(CalendarProviderError):
        await calendar_provider(handler).revoke(REFRESH_TOKEN)


# Event listing -----------------------------------------------------------------------------------

IST = timezone(timedelta(hours=5, minutes=30))
TIME_MIN = datetime(2026, 10, 6, 0, 0, tzinfo=IST)
TIME_MAX = datetime(2026, 10, 7, 0, 0, tzinfo=IST)


def fixture_page() -> Json:
    page: Json = json.loads((FIXTURES / "google_events.json").read_text(encoding="utf-8"))
    return page


def event_item(event_id: str, start: str, end: str) -> Json:
    return {
        "id": event_id,
        "status": "confirmed",
        "summary": f"Event {event_id}",
        "start": {"dateTime": start},
        "end": {"dateTime": end},
    }


async def test_list_events_request_is_exact() -> None:
    seen: list[httpx.Request] = []

    events = await calendar_provider(
        recording(seen, lambda _: httpx.Response(200, json=fixture_page()))
    ).list_events(ACCESS_TOKEN, time_min=TIME_MIN, time_max=TIME_MAX)

    [request] = seen
    assert request.method == "GET"
    assert f"{request.url.scheme}://{request.url.host}{request.url.path}" == GOOGLE_EVENTS_URL
    assert GOOGLE_EVENTS_URL == "https://www.googleapis.com/calendar/v3/calendars/primary/events"
    assert request.headers["Authorization"] == f"Bearer {ACCESS_TOKEN}"
    assert dict(request.url.params) == {
        # Google requires an offset on both bounds; the window is sent in UTC.
        "timeMin": "2026-10-05T18:30:00+00:00",
        "timeMax": "2026-10-06T18:30:00+00:00",
        "singleEvents": "true",
        "orderBy": "startTime",
        "eventTypes": "default",
        "maxAttendees": "100",
    }
    assert [event.id for event in events] == [
        "4k1offsite0001",
        "7q2standup0001_20261006T043000Z",
        "9v3vendor0001",
        "2m4review0001",
        "5h7allhands0001",
    ]
    assert {event.provider for event in events} == {"google"}


async def test_list_events_follows_page_tokens() -> None:
    seen: list[httpx.Request] = []
    pages = {
        None: {
            "items": [event_item("a", "2026-10-06T04:00:00Z", "2026-10-06T04:30:00Z")],
            "nextPageToken": "page-2",
        },
        "page-2": {
            "items": [event_item("b", "2026-10-06T05:00:00Z", "2026-10-06T05:30:00Z")],
            "nextPageToken": "page-3",
        },
        "page-3": {"items": [event_item("c", "2026-10-06T06:00:00Z", "2026-10-06T06:30:00Z")]},
    }

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=pages[request.url.params.get("pageToken")])

    events = await calendar_provider(recording(seen, answer)).list_events(
        ACCESS_TOKEN, time_min=TIME_MIN, time_max=TIME_MAX
    )

    assert [event.id for event in events] == ["a", "b", "c"]
    assert [request.url.params.get("pageToken") for request in seen] == [None, "page-2", "page-3"]
    # Every page repeats the query: Google needs it with the token.
    assert {request.url.params["timeMin"] for request in seen} == {"2026-10-05T18:30:00+00:00"}
    assert {request.url.params["singleEvents"] for request in seen} == {"true"}


@pytest.mark.parametrize(
    "tokens",
    [
        pytest.param({None: "p2", "p2": "p2"}, id="same token again"),
        pytest.param({None: "p2", "p2": "p3", "p3": "p2"}, id="a cycle"),
    ],
)
async def test_list_events_refuses_a_repeated_page_token(tokens: dict[str | None, str]) -> None:
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        token = request.url.params.get("pageToken")
        return httpx.Response(200, json={"items": [], "nextPageToken": tokens[token]})

    with pytest.raises(CalendarProviderError, match="repeated"):
        await calendar_provider(recording(seen, answer)).list_events(
            ACCESS_TOKEN, time_min=TIME_MIN, time_max=TIME_MAX
        )

    assert len(seen) == len(tokens)


async def test_list_events_stops_after_the_page_limit() -> None:
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"items": [], "nextPageToken": f"p{len(seen)}"})

    with pytest.raises(CalendarProviderError):
        await calendar_provider(recording(seen, answer)).list_events(
            ACCESS_TOKEN, time_min=TIME_MIN, time_max=TIME_MAX
        )

    assert len(seen) == MAX_EVENT_PAGES


async def test_list_events_401_is_a_rejected_access_token() -> None:
    # The route refreshes once and retries once (M5-T3); uncaught it is a 502, not a 424.
    with pytest.raises(CalendarAccessTokenRejectedError) as raised:
        await calendar_provider(api_error(401, "authError")).list_events(
            ACCESS_TOKEN, time_min=TIME_MIN, time_max=TIME_MAX
        )

    assert raised.value.status_code == 502
    assert raised.value.code == "calendar_provider_error"


async def test_list_events_without_calendar_scope_is_reconnect_required() -> None:
    with pytest.raises(CalendarReconnectRequiredError):
        await calendar_provider(api_error(403, "insufficientPermissions")).list_events(
            ACCESS_TOKEN, time_min=TIME_MIN, time_max=TIME_MAX
        )


@pytest.mark.parametrize(
    "handler",
    [
        pytest.param(server_error, id="5xx"),
        pytest.param(api_error(403, "rateLimitExceeded"), id="rate limited 403"),
        pytest.param(api_error(429, "rateLimitExceeded"), id="rate limited 429"),
        pytest.param(api_error(404, "notFound"), id="404"),
        pytest.param(timeout, id="timeout"),
        pytest.param(unreachable, id="unreachable"),
        pytest.param(not_json, id="not json"),
        pytest.param(lambda _: httpx.Response(200, json={"items": "x"}), id="items not a list"),
    ],
)
async def test_list_events_failures_are_provider_errors(handler: Handler) -> None:
    with pytest.raises(CalendarProviderError) as raised:
        await calendar_provider(handler).list_events(
            ACCESS_TOKEN, time_min=TIME_MIN, time_max=TIME_MAX
        )

    assert not isinstance(raised.value, CalendarAccessTokenRejectedError)


async def test_list_events_skips_an_unreadable_event_and_logs_its_id(
    google_logs: list[CapturedCall],
) -> None:
    broken = event_item("broken-1", "2026-10-06T04:00:00Z", "2026-10-06T04:30:00Z")
    broken["summary"] = "Private: salary review"
    del broken["start"]
    page = {"items": [broken, event_item("ok-1", "2026-10-06T05:00:00Z", "2026-10-06T05:30:00Z")]}

    events = await calendar_provider(lambda _: httpx.Response(200, json=page)).list_events(
        ACCESS_TOKEN, time_min=TIME_MIN, time_max=TIME_MAX
    )

    assert [event.id for event in events] == ["ok-1"]
    [call] = google_logs
    assert call.method_name == "warning"
    assert call.kwargs["event"] == "calendar_event_skipped"
    assert call.kwargs["event_id"] == "broken-1"
    assert "salary" not in repr(call)


@pytest.mark.parametrize(
    ("time_min", "time_max"),
    [
        (datetime(2026, 10, 6), TIME_MAX),  # noqa: DTZ001 - the naive bound under test
        (TIME_MIN, datetime(2026, 10, 7)),  # noqa: DTZ001 - the naive bound under test
    ],
)
async def test_list_events_refuses_a_naive_bound(time_min: datetime, time_max: datetime) -> None:
    seen: list[httpx.Request] = []

    with pytest.raises(ValueError, match="time zone"):
        await calendar_provider(recording(seen, server_error)).list_events(
            ACCESS_TOKEN, time_min=time_min, time_max=time_max
        )

    assert seen == []


# Logs --------------------------------------------------------------------------------------------


async def test_logs_hold_no_secret(google_logs: list[CapturedCall]) -> None:
    # A success body Google sends holds tokens, so an unreadable one must be logged without it.
    unreadable_token = {"access_token": ACCESS_TOKEN, "refresh_token": REFRESH_TOKEN}
    refusals: list[Handler] = [
        oauth_error(400, "invalid_grant"),
        oauth_error(401, "invalid_client"),
        timeout,
    ]

    for handler in [*refusals, lambda _: httpx.Response(200, json=unreadable_token)]:
        calendar = calendar_provider(handler)
        with pytest.raises(AppError):
            await calendar.exchange_code(
                code=CODE, code_verifier=VERIFIER, redirect_uri=REDIRECT_URI
            )
        with pytest.raises(AppError):
            await calendar.refresh(REFRESH_TOKEN)
    for handler in refusals:
        with pytest.raises(AppError):
            await calendar_provider(handler).revoke(REFRESH_TOKEN)
    with pytest.raises(AppError):
        await calendar_provider(api_error(500, "backendError")).list_events(
            ACCESS_TOKEN, time_min=TIME_MIN, time_max=TIME_MAX
        )

    assert len(google_logs) == 12
    logged = repr(google_logs)
    for secret in SECRETS:
        assert secret not in logged


def test_token_objects_print_no_secret() -> None:
    grant = CalendarGrant(
        account_email="priya@linkt.ai",
        scopes=(CALENDAR_SCOPE,),
        refresh_token=REFRESH_TOKEN,
        access_token=AccessToken(value=ACCESS_TOKEN, expires_in_seconds=3599),
    )

    assert REFRESH_TOKEN not in repr(grant)
    assert ACCESS_TOKEN not in repr(grant)
    assert "priya@linkt.ai" in repr(grant)
