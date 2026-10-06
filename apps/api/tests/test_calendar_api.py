"""Calendar routes, the encrypted token store and the calendar runtime (M5-T3), on the test DB.

Google is never called: the Google provider runs over `httpx.MockTransport` (`GoogleStub`), as in
test_calendar_google.py, and the fake provider is the app's own default.
"""

import base64
import importlib.util
import json
import logging
import socket
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import pytest
import structlog
from asgi_lifespan import LifespanManager
from fastapi import FastAPI
from pydantic import SecretStr
from sqlalchemy import func, make_url, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import QueuePool

from roger_api.app import create_app
from roger_api.auth import Principal
from roger_api.config import Settings
from roger_api.config_calendar import GoogleOAuthAudience
from roger_api.db.engine import Database
from roger_api.db.models import Workspace
from roger_api.db.models_calendar import CalendarConnection
from roger_api.dependencies import get_database
from roger_api.log import get_logger
from roger_api.services.calendar import connections
from roger_api.services.calendar import google as google_module
from roger_api.services.calendar.connections import CalendarStoreError, StoredConnection
from roger_api.services.calendar.fake import FAKE_ACCOUNT_EMAIL, FakeCalendarProvider
from roger_api.services.calendar.google import (
    GOOGLE_AUTHORIZATION_URL,
    GOOGLE_EVENTS_URL,
    GOOGLE_REVOKE_URL,
    GOOGLE_TOKEN_URL,
    GoogleCalendarProvider,
)
from roger_api.services.calendar.provider import AccessToken, CalendarProviderName
from roger_api.services.calendar.runtime import (
    ACCESS_TOKEN_MARGIN_SECONDS,
    AccessTokenCache,
    CalendarRuntime,
    get_calendar_runtime,
    open_calendar_runtime,
)
from tests.conftest import make_settings
from tests.helpers import AUTH_HEADERS, BASE_URL, assert_error

FIXTURES = Path(__file__).parent / "fixtures" / "calendar"
CLIENT_ID = "123456789012-roger.apps.googleusercontent.com"
CLIENT_SECRET = "GOCSPX-api-test-client-secret"
TOKEN_KEY = "calendar-token-key-6f1d2c9a8b7e4f30a1b2c3d4"
OTHER_TOKEN_KEY = "another-calendar-token-key-0a9b8c7d6e5f4a3b"
REDIRECT_URI = "http://127.0.0.1:53682/oauth/callback"
CODE = "4/0AVG7fiQ-api-test-one-time-authorization-code"
# RFC 7636's example pair: 43 characters each.
VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
STATE = "st-8f2c1d9e0a7b"
REFRESH_TOKEN = "1//0g-api-test-refresh-token-value"
ACCESS_TOKEN = "ya29.api-test-access-token-from-the-exchange"
REFRESHED_ACCESS_TOKEN = "ya29.api-test-access-token-from-a-refresh"
ACCOUNT_EMAIL = "priya@linkt.ai"
GRANTED_SCOPES = (
    "openid https://www.googleapis.com/auth/userinfo.email "
    "https://www.googleapis.com/auth/calendar.events.readonly"
)
SECRETS = (
    CODE,
    VERIFIER,
    REFRESH_TOKEN,
    ACCESS_TOKEN,
    REFRESHED_ACCESS_TOKEN,
    CLIENT_SECRET,
    TOKEN_KEY,
)
WINDOW = {"from": "2026-10-05T18:30:00Z", "to": "2026-10-08T18:30:00Z"}
CONNECTION_BODY = {"code": CODE, "code_verifier": VERIFIER, "redirect_uri": REDIRECT_URI}
AUTHORIZATION_BODY = {"redirect_uri": REDIRECT_URI, "code_challenge": CHALLENGE, "state": STATE}

type Json = dict[str, Any]
type Handler = Callable[[httpx.Request], httpx.Response]


@pytest.fixture(autouse=True)
def _fresh_google_logger(monkeypatch: pytest.MonkeyPatch) -> None:
    # google.py's module logger is cached on first use with the processor list of the
    # configure_logging() that was current then. Fired here under an app, it would keep that app's
    # list, and test_calendar_google.py (which runs later) would capture none of its entries with
    # structlog's capture_logs and fail on an empty list. Each test here gets a fresh logger
    # instead, so the module's own stays unused (CLAUDE.md failure log, capture_logs).
    monkeypatch.setattr(google_module, "logger", get_logger(google_module.__name__))


# Fake Google ------------------------------------------------------------------------------------


def answer(body: Json, status: int = 200) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body)

    return handler


def in_turn(*handlers: Handler) -> Handler:
    """The handlers in order, one per request; the last one answers every later request."""
    queue = list(handlers)

    def handler(request: httpx.Request) -> httpx.Response:
        return (queue.pop(0) if len(queue) > 1 else queue[0])(request)

    return handler


def token_body(**fields: object) -> Json:
    body: Json = {
        "access_token": ACCESS_TOKEN,
        "expires_in": 3599,
        "refresh_token": REFRESH_TOKEN,
        "scope": GRANTED_SCOPES,
        "token_type": "Bearer",
        "id_token": id_token(ACCOUNT_EMAIL),
    }
    body.update(fields)
    return {key: value for key, value in body.items() if value is not None}


def id_token(email: str) -> str:
    """An ID token as Google's token endpoint returns it. The signature is never checked."""

    def part(value: Json) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()

    return f"{part({'alg': 'RS256'})}.{part({'aud': CLIENT_ID, 'email': email})}.c2lnbmF0dXJl"


REFRESHED = answer(
    {"access_token": REFRESHED_ACCESS_TOKEN, "expires_in": 3599, "token_type": "Bearer"}
)
GOOGLE_500 = answer({"error": {"code": 500, "status": "INTERNAL", "errors": []}}, status=500)
TOKEN_REJECTED = answer({"error": {"code": 401, "status": "UNAUTHENTICATED"}}, status=401)
INVALID_GRANT = answer({"error": "invalid_grant", "error_description": "Bad Request"}, status=400)


def events_page() -> Json:
    return {
        "items": [
            {
                "id": "evt-standup",
                "status": "confirmed",
                "summary": "Standup",
                "iCalUID": "standup@google.com",
                "htmlLink": "https://www.google.com/calendar/event?eid=c3RhbmR1cA",
                "start": {"dateTime": "2026-10-06T10:00:00+05:30"},
                "end": {"dateTime": "2026-10-06T10:15:00+05:30"},
                "organizer": {"email": "jane@linkt.ai"},
                "attendees": [
                    {
                        "email": "jane@linkt.ai",
                        "displayName": "Jane Cooper",
                        "organizer": True,
                        "responseStatus": "accepted",
                    },
                    {"email": ACCOUNT_EMAIL, "self": True, "responseStatus": "needsAction"},
                    {"email": "room@resource.calendar.google.com", "resource": True},
                ],
                "location": "https://us02web.zoom.us/j/81234567890",
            },
            {
                "id": "evt-offsite",
                "status": "confirmed",
                "summary": "Offsite",
                "start": {"date": "2026-10-07"},
                "end": {"date": "2026-10-08"},
            },
        ]
    }


class GoogleStub:
    """Google's token, revoke and events endpoints. Each answer is a handler a test may replace."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, httpx.Request]] = []
        self.exchange: Handler = answer(token_body())
        self.refresh: Handler = REFRESHED
        self.revoke: Handler = answer({})
        self.events: Handler = answer(events_page())

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = f"{request.url.scheme}://{request.url.host}{request.url.path}"
        if url == GOOGLE_TOKEN_URL:
            grant_type = parse_qs(request.content.decode())["grant_type"]
            kind, handler = (
                ("exchange", self.exchange)
                if grant_type == ["authorization_code"]
                else ("refresh", self.refresh)
            )
        elif url == GOOGLE_REVOKE_URL:
            kind, handler = "revoke", self.revoke
        elif url == GOOGLE_EVENTS_URL:
            kind, handler = "events", self.events
        else:
            raise AssertionError(f"unexpected request to {url}")
        self.sent.append((kind, request))
        return handler(request)

    @property
    def kinds(self) -> list[str]:
        return [kind for kind, _ in self.sent]

    def requests(self, kind: str) -> list[httpx.Request]:
        return [request for sent_kind, request in self.sent if sent_kind == kind]


def google_runtime(
    stub: GoogleStub,
    *,
    audience: GoogleOAuthAudience = "external_testing",
    token_key: str = TOKEN_KEY,
    provider_type: type[GoogleCalendarProvider] = GoogleCalendarProvider,
) -> CalendarRuntime:
    http = httpx.AsyncClient(transport=httpx.MockTransport(stub))
    return CalendarRuntime(
        provider=provider_type(http, client_id=CLIENT_ID, client_secret=CLIENT_SECRET),
        token_key=SecretStr(token_key),
        audience=audience,
    )


def use_runtime(app: FastAPI, runtime: CalendarRuntime) -> None:
    app.dependency_overrides[get_calendar_runtime] = lambda: runtime


@pytest.fixture
def google(app: FastAPI) -> GoogleStub:
    """The app on the Google provider (External in Testing), with Google answered by the stub."""
    stub = GoogleStub()
    use_runtime(app, google_runtime(stub))
    return stub


async def connect(client: httpx.AsyncClient, **body: object) -> Json:
    response = await client.post("/v1/calendar/google/connection", json={**CONNECTION_BODY, **body})
    assert response.status_code == 201, response.text
    connection: Json = response.json()
    return connection


async def get_connection(client: httpx.AsyncClient) -> Json | None:
    response = await client.get("/v1/calendar/connection")
    assert response.status_code == 200, response.text
    body: Json = response.json()
    assert set(body) == {"connection"}
    connection: Json | None = body["connection"]
    return connection


async def stored_connections(app: FastAPI) -> list[CalendarConnection]:
    database = app.state.database
    assert isinstance(database, Database)
    async with database.session() as session:
        return list(await session.scalars(select(CalendarConnection)))


# Logs -------------------------------------------------------------------------------------------


class LogRecorder(logging.Handler):
    """Every record the app logs: its event dict, and the text the app's own handler writes."""

    def __init__(self, formatter: logging.Formatter) -> None:
        super().__init__()
        self.events: list[dict[str, Any]] = []
        self.lines: list[str] = []
        self._formatter = formatter

    def emit(self, record: logging.LogRecord) -> None:
        if isinstance(record.msg, dict):
            self.events.append(dict(record.msg))
        # Rendered while the logging call runs, so `exc_info=True` still finds the exception and
        # the traceback (frames and, in production, their locals) is part of the text.
        self.lines.append(self._formatter.format(record))

    @property
    def names(self) -> list[str]:
        return [str(event.get("event")) for event in self.events]

    @property
    def text(self) -> str:
        return "\n".join([*self.lines, repr(self.events)])


@contextmanager
def recorded_logs() -> Iterator[LogRecorder]:
    """Everything logged inside the block. Enter it after create_app(), which resets the handlers.

    Never structlog's capture_logs here: a module logger first used under an earlier test's app
    keeps that app's processors, so capture_logs would see nothing and "never logged" would pass
    on nothing (CLAUDE.md failure log). A root handler sees every record.
    """
    root = logging.getLogger()
    [formatter] = [
        handler.formatter
        for handler in root.handlers
        if isinstance(handler.formatter, structlog.stdlib.ProcessorFormatter)
    ]
    recorder = LogRecorder(formatter)
    root.addHandler(recorder)
    try:
        yield recorder
    finally:
        root.removeHandler(recorder)


def assert_no_secret(*texts: str) -> None:
    for secret in SECRETS:
        for logged in texts:
            assert secret not in logged


# Auth -------------------------------------------------------------------------------------------

CALENDAR_ROUTES = [
    ("POST", "/v1/calendar/google/authorization", AUTHORIZATION_BODY),
    ("POST", "/v1/calendar/google/connection", CONNECTION_BODY),
    ("GET", "/v1/calendar/connection", None),
    ("DELETE", "/v1/calendar/connection", None),
    ("GET", "/v1/calendar/events", None),
]


@pytest.mark.parametrize(("method", "path", "body"), CALENDAR_ROUTES)
async def test_calendar_routes_require_auth(
    anonymous_client: httpx.AsyncClient,
    google: GoogleStub,
    method: str,
    path: str,
    body: Json | None,
) -> None:
    # A valid request in every other way: the token is the only thing missing.
    response = await anonymous_client.request(
        method, path, json=body, params=WINDOW if path.endswith("/events") else None
    )

    assert_error(response, 401, "unauthorized")
    assert google.sent == []


# Authorization ----------------------------------------------------------------------------------

BAD_REDIRECTS = [
    pytest.param("http://localhost:53682/oauth/callback", id="localhost"),
    pytest.param("https://127.0.0.1:53682/oauth/callback", id="https"),
    pytest.param("HTTP://127.0.0.1:53682/oauth/callback", id="upper-case-scheme"),
    pytest.param("http://127.0.0.2:53682/oauth/callback", id="another-loopback-address"),
    pytest.param("http://[::1]:53682/oauth/callback", id="ipv6-loopback"),
    pytest.param("http://127.1:53682/oauth/callback", id="short-ipv4"),
    pytest.param("http://2130706433:53682/oauth/callback", id="decimal-ipv4"),
    pytest.param("http://127.0.0.1.evil.example:53682/oauth/callback", id="lookalike-host"),
    pytest.param("http://127.0.0.1:53682@evil.example/oauth/callback", id="userinfo-trick"),
    pytest.param("http://user@127.0.0.1:53682/oauth/callback", id="userinfo"),
    pytest.param("http://127.0.0.1/oauth/callback", id="no-port"),
    pytest.param("http://127.0.0.1:0/oauth/callback", id="port-0"),
    pytest.param("http://127.0.0.1:65536/oauth/callback", id="port-too-high"),
    pytest.param("http://127.0.0.1:053682/oauth/callback", id="port-leading-zero"),
    pytest.param("http://127.0.0.1:53682", id="no-path"),
    pytest.param("http://127.0.0.1:53682/oauth/callback#fragment", id="fragment"),
    pytest.param("http://127.0.0.1:53682/oauth\\callback", id="backslash"),
    pytest.param("http://127.0.0.1:53682/oauth/callback\n", id="trailing-newline"),
    pytest.param("http://127.0.0.1:53682/oauth/call back", id="space"),
    pytest.param("", id="empty"),
]


@pytest.mark.parametrize("redirect_uri", BAD_REDIRECTS)
@pytest.mark.parametrize(
    ("path", "body"),
    [
        pytest.param("/v1/calendar/google/authorization", AUTHORIZATION_BODY, id="authorization"),
        pytest.param("/v1/calendar/google/connection", CONNECTION_BODY, id="connection"),
    ],
)
async def test_authorization_refuses_a_redirect_that_is_not_loopback(
    client: httpx.AsyncClient, google: GoogleStub, path: str, body: Json, redirect_uri: str
) -> None:
    response = await client.post(path, json={**body, "redirect_uri": redirect_uri})

    message = assert_error(response, 422, "validation_error")
    assert "body.redirect_uri" in message
    assert google.sent == []


@pytest.mark.parametrize("port", [1, 1024, 53682, 65535])
async def test_authorization_accepts_127_0_0_1_on_any_port(
    client: httpx.AsyncClient, google: GoogleStub, port: int
) -> None:
    redirect_uri = f"http://127.0.0.1:{port}/oauth/callback"

    response = await client.post(
        "/v1/calendar/google/authorization",
        json={**AUTHORIZATION_BODY, "redirect_uri": redirect_uri},
    )

    assert response.status_code == 200, response.text
    query = parse_qs(urlsplit(response.json()["authorization_url"]).query)
    assert query["redirect_uri"] == [redirect_uri]


async def test_authorization_url_is_googles_with_the_request_values(
    client: httpx.AsyncClient, google: GoogleStub
) -> None:
    response = await client.post("/v1/calendar/google/authorization", json=AUTHORIZATION_BODY)

    assert response.status_code == 200, response.text
    assert set(response.json()) == {"authorization_url"}
    parts = urlsplit(response.json()["authorization_url"])
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == GOOGLE_AUTHORIZATION_URL
    query = parse_qs(parts.query)
    assert query["client_id"] == [CLIENT_ID]
    assert query["code_challenge"] == [CHALLENGE]
    assert query["code_challenge_method"] == ["S256"]
    assert query["state"] == [STATE]
    assert CLIENT_SECRET not in response.text
    # Building the URL calls nobody.
    assert google.sent == []


async def test_authorization_on_the_fake_provider_is_its_own_redirect(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post("/v1/calendar/google/authorization", json=AUTHORIZATION_BODY)

    assert response.status_code == 200, response.text
    parts = urlsplit(response.json()["authorization_url"])
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == REDIRECT_URI
    assert parse_qs(parts.query) == {"code": ["fake"], "state": [STATE]}


@pytest.mark.parametrize(
    ("field", "value"),
    [
        pytest.param("code_challenge", CHALLENGE[:-1], id="challenge-too-short"),
        pytest.param("code_challenge", CHALLENGE + "A", id="challenge-too-long"),
        pytest.param("code_challenge", CHALLENGE[:-1] + "=", id="challenge-padded"),
        pytest.param("code_challenge", CHALLENGE[:-1] + "+", id="challenge-not-base64url"),
        pytest.param("state", "", id="state-empty"),
        pytest.param("state", "a b", id="state-space"),
        pytest.param("state", "s" * 513, id="state-too-long"),
        pytest.param("state", "st&prompt=none", id="state-query-characters"),
    ],
)
async def test_authorization_refuses_a_bad_challenge_or_state(
    client: httpx.AsyncClient, field: str, value: str
) -> None:
    response = await client.post(
        "/v1/calendar/google/authorization", json={**AUTHORIZATION_BODY, field: value}
    )

    message = assert_error(response, 422, "validation_error")
    assert f"body.{field}" in message


@pytest.mark.parametrize(
    ("field", "value"),
    [
        pytest.param("code", "", id="code-empty"),
        pytest.param("code", "4/0A code", id="code-space"),
        pytest.param("code", "c" * 2049, id="code-too-long"),
        pytest.param("code_verifier", VERIFIER[:42], id="verifier-too-short"),
        pytest.param("code_verifier", "v" * 129, id="verifier-too-long"),
        pytest.param("code_verifier", VERIFIER[:42] + "/", id="verifier-reserved-character"),
    ],
)
async def test_connection_refuses_a_bad_code_or_verifier_without_echoing_it(
    client: httpx.AsyncClient, google: GoogleStub, field: str, value: str
) -> None:
    response = await client.post(
        "/v1/calendar/google/connection", json={**CONNECTION_BODY, field: value}
    )

    message = assert_error(response, 422, "validation_error")
    assert f"body.{field}" in message
    assert google.sent == []
    if value:
        assert value not in message


# Connection -------------------------------------------------------------------------------------


async def test_connection_is_null_before_any_connect(client: httpx.AsyncClient) -> None:
    assert await get_connection(client) is None


async def test_connection_exchanges_the_code_and_reads_back(
    client: httpx.AsyncClient, google: GoogleStub
) -> None:
    before = datetime.now(UTC)

    connection = await connect(client)

    [exchange] = google.requests("exchange")
    sent = parse_qs(exchange.content.decode())
    assert sent["code"] == [CODE]
    assert sent["code_verifier"] == [VERIFIER]
    assert sent["redirect_uri"] == [REDIRECT_URI]
    assert set(connection) == {
        "provider",
        "account_email",
        "status",
        "connected_at",
        "expires_hint",
        "last_error",
    }
    assert connection["provider"] == "google"
    assert connection["account_email"] == ACCOUNT_EMAIL
    assert connection["status"] == "active"
    assert connection["last_error"] is None
    connected_at = datetime.fromisoformat(connection["connected_at"])
    assert connection["connected_at"].endswith("Z")
    assert before - timedelta(seconds=5) <= connected_at <= datetime.now(UTC) + timedelta(seconds=5)
    assert await get_connection(client) == connection
    assert_no_secret(json.dumps(connection))


async def test_refresh_token_is_encrypted_at_rest(
    app: FastAPI, client: httpx.AsyncClient, google: GoogleStub
) -> None:
    await connect(client)

    database = app.state.database
    assert isinstance(database, Database)
    async with database.session() as session:
        [raw] = list(await session.scalars(select(CalendarConnection.refresh_token)))
        decrypted = await session.scalar(
            select(func.pgp_sym_decrypt(CalendarConnection.refresh_token, TOKEN_KEY))
        )
    assert raw is not None
    assert REFRESH_TOKEN.encode() not in raw
    assert TOKEN_KEY.encode() not in raw
    assert ACCESS_TOKEN.encode() not in raw
    assert decrypted == REFRESH_TOKEN


async def test_connection_again_replaces_the_connection(
    app: FastAPI, client: httpx.AsyncClient, google: GoogleStub
) -> None:
    await connect(client)
    google.exchange = answer(
        token_body(
            id_token=id_token("priya.work@linkt.ai"),
            refresh_token="1//0g-second-refresh-token",
            access_token="ya29.second-access-token",
        )
    )

    second = await connect(client)

    assert second["account_email"] == "priya.work@linkt.ai"
    assert await get_connection(client) == second
    [stored] = await stored_connections(app)
    assert stored.account_email == "priya.work@linkt.ai"
    # The new grant's access token, never the replaced one's.
    await client.get("/v1/calendar/events", params=WINDOW)
    [events] = google.requests("events")
    assert events.headers["Authorization"] == "Bearer ya29.second-access-token"


async def test_connection_after_reconnect_required_is_active_again(
    client: httpx.AsyncClient, google: GoogleStub
) -> None:
    google.exchange = answer(token_body(expires_in=30))
    google.refresh = INVALID_GRANT
    await connect(client)
    assert_error(
        await client.get("/v1/calendar/events", params=WINDOW), 424, "calendar_reconnect_required"
    )
    google.exchange = answer(token_body())

    connection = await connect(client)

    assert connection["status"] == "active"
    assert connection["last_error"] is None
    response = await client.get("/v1/calendar/events", params=WINDOW)
    assert response.status_code == 200, response.text


async def test_connection_of_another_workspace_is_invisible(
    app: FastAPI, client: httpx.AsyncClient, google: GoogleStub
) -> None:
    database = app.state.database
    assert isinstance(database, Database)
    other_workspace = uuid4()
    async with database.session() as session:
        session.add(Workspace(id=other_workspace, name="Someone else"))
        await session.flush()
        session.add(
            CalendarConnection(
                id=uuid4(),
                workspace_id=other_workspace,
                provider="google",
                account_email="someone@else.example",
                scopes=GRANTED_SCOPES,
                refresh_token=func.pgp_sym_encrypt("1//0g-not-yours", TOKEN_KEY),
                status="active",
                connected_at=datetime.now(UTC),
            )
        )
        await session.commit()

    assert await get_connection(client) is None
    assert_error(await client.get("/v1/calendar/events", params=WINDOW), 404, "not_found")
    assert (await client.delete("/v1/calendar/connection")).status_code == 204
    await connect(client)

    stored = await stored_connections(app)
    assert sorted(row.account_email for row in stored) == [ACCOUNT_EMAIL, "someone@else.example"]
    # Only this workspace's connection reached Google: the exchange, nothing else.
    assert google.kinds == ["exchange"]


@pytest.mark.parametrize(
    ("audience", "hinted"),
    [("external_testing", True), ("external_production", False), ("internal", False)],
)
async def test_connection_expires_hint_is_seven_days_only_for_external_testing(
    app: FastAPI, client: httpx.AsyncClient, audience: GoogleOAuthAudience, hinted: bool
) -> None:
    use_runtime(app, google_runtime(GoogleStub(), audience=audience))

    connection = await connect(client)

    connected_at = datetime.fromisoformat(connection["connected_at"])
    expected = (connected_at + timedelta(days=7)) if hinted else None
    hint = connection["expires_hint"]
    assert (datetime.fromisoformat(hint) if hint else None) == expected
    assert await get_connection(client) == connection


async def test_connection_expires_hint_is_null_on_the_fake_provider(
    client: httpx.AsyncClient,
) -> None:
    # The audience defaults to external_testing, but the fake grant never expires.
    connection = await connect(client, code="fake")

    assert connection["provider"] == "fake"
    assert connection["account_email"] == FAKE_ACCOUNT_EMAIL
    assert connection["expires_hint"] is None


async def test_connection_without_calendar_access_is_424_and_stores_nothing(
    app: FastAPI, client: httpx.AsyncClient, google: GoogleStub
) -> None:
    google.exchange = answer(
        token_body(scope="openid https://www.googleapis.com/auth/userinfo.email")
    )

    response = await client.post("/v1/calendar/google/connection", json=CONNECTION_BODY)

    message = assert_error(response, 424, "calendar_reconnect_required")
    assert "tick" in message
    assert await stored_connections(app) == []


@pytest.mark.parametrize(
    ("exchange", "status", "code"),
    [
        pytest.param(INVALID_GRANT, 424, "calendar_reconnect_required", id="used-code"),
        pytest.param(GOOGLE_500, 502, "calendar_provider_error", id="google-500"),
    ],
)
async def test_connection_refused_by_google_stores_nothing(
    app: FastAPI,
    client: httpx.AsyncClient,
    google: GoogleStub,
    exchange: Handler,
    status: int,
    code: str,
) -> None:
    google.exchange = exchange

    response = await client.post("/v1/calendar/google/connection", json=CONNECTION_BODY)

    assert_error(response, status, code)
    assert await stored_connections(app) == []


# Events -----------------------------------------------------------------------------------------


async def test_events_without_a_connection_is_404(
    client: httpx.AsyncClient, google: GoogleStub
) -> None:
    assert_error(await client.get("/v1/calendar/events", params=WINDOW), 404, "not_found")
    assert google.sent == []


async def test_events_answer_in_the_contract_shape(
    client: httpx.AsyncClient, google: GoogleStub
) -> None:
    await connect(client)
    before = datetime.now(UTC)

    response = await client.get("/v1/calendar/events", params=WINDOW)

    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"items", "fetched_at"}
    assert before <= datetime.fromisoformat(body["fetched_at"]) <= datetime.now(UTC)
    assert body["fetched_at"].endswith("Z")
    assert body["items"] == [
        {
            "provider": "google",
            "id": "evt-standup",
            "ical_uid": "standup@google.com",
            "recurring_event_id": None,
            "title": "Standup",
            "status": "confirmed",
            "all_day": False,
            "start": "2026-10-06T04:30:00Z",
            "end": "2026-10-06T04:45:00Z",
            "start_date": None,
            "end_date": None,
            "self_response": "needs_action",
            "attendees": [
                {
                    "email": "jane@linkt.ai",
                    "display_name": "Jane Cooper",
                    "response_status": "accepted",
                    "is_self": False,
                    "is_organizer": True,
                },
                {
                    "email": ACCOUNT_EMAIL,
                    "display_name": None,
                    "response_status": "needs_action",
                    "is_self": True,
                    "is_organizer": False,
                },
            ],
            "attendees_omitted": False,
            "video_link": "https://us02web.zoom.us/j/81234567890",
            "video_link_source": "location",
            "html_link": "https://www.google.com/calendar/event?eid=c3RhbmR1cA",
        },
        {
            "provider": "google",
            "id": "evt-offsite",
            "ical_uid": None,
            "recurring_event_id": None,
            "title": "Offsite",
            "status": "confirmed",
            "all_day": True,
            "start": None,
            "end": None,
            "start_date": "2026-10-07",
            "end_date": "2026-10-08",
            "self_response": "unknown",
            "attendees": [],
            "attendees_omitted": False,
            "video_link": None,
            "video_link_source": None,
            "html_link": None,
        },
    ]
    [request] = google.requests("events")
    assert request.url.params["timeMin"] == "2026-10-05T18:30:00+00:00"
    assert request.url.params["timeMax"] == "2026-10-08T18:30:00+00:00"


async def test_events_use_the_access_token_from_the_connect(
    client: httpx.AsyncClient, google: GoogleStub
) -> None:
    await connect(client)

    for _ in range(2):
        response = await client.get("/v1/calendar/events", params=WINDOW)
        assert response.status_code == 200, response.text

    assert google.kinds == ["exchange", "events", "events"]
    for request in google.requests("events"):
        assert request.headers["Authorization"] == f"Bearer {ACCESS_TOKEN}"


async def test_events_expired_access_token_is_refreshed_once_and_cached(
    client: httpx.AsyncClient, google: GoogleStub
) -> None:
    # Inside the last minute of its life the exchange's token counts as expired.
    google.exchange = answer(token_body(expires_in=ACCESS_TOKEN_MARGIN_SECONDS))
    await connect(client)

    for _ in range(2):
        response = await client.get("/v1/calendar/events", params=WINDOW)
        assert response.status_code == 200, response.text

    assert google.kinds == ["exchange", "refresh", "events", "events"]
    [refresh] = google.requests("refresh")
    assert parse_qs(refresh.content.decode())["refresh_token"] == [REFRESH_TOKEN]
    for request in google.requests("events"):
        assert request.headers["Authorization"] == f"Bearer {REFRESHED_ACCESS_TOKEN}"


async def test_events_rejected_access_token_is_refreshed_once_and_retried(
    client: httpx.AsyncClient, google: GoogleStub
) -> None:
    google.events = in_turn(TOKEN_REJECTED, answer(events_page()))
    await connect(client)

    response = await client.get("/v1/calendar/events", params=WINDOW)

    assert response.status_code == 200, response.text
    assert [item["id"] for item in response.json()["items"]] == ["evt-standup", "evt-offsite"]
    assert google.kinds == ["exchange", "events", "refresh", "events"]
    first, retry = google.requests("events")
    assert first.headers["Authorization"] == f"Bearer {ACCESS_TOKEN}"
    assert retry.headers["Authorization"] == f"Bearer {REFRESHED_ACCESS_TOKEN}"


async def test_events_access_token_rejected_after_a_refresh_is_502(
    client: httpx.AsyncClient, google: GoogleStub
) -> None:
    google.events = TOKEN_REJECTED
    await connect(client)

    response = await client.get("/v1/calendar/events", params=WINDOW)

    assert_error(response, 502, "calendar_provider_error")
    # One refresh and one retry, never a loop.
    assert google.kinds == ["exchange", "events", "refresh", "events"]
    connection = await get_connection(client)
    assert connection is not None
    assert connection["status"] == "active"


async def test_events_invalid_grant_is_424_and_reconnect_required(
    client: httpx.AsyncClient, google: GoogleStub
) -> None:
    google.exchange = answer(token_body(expires_in=30))
    google.refresh = INVALID_GRANT
    await connect(client)

    with recorded_logs() as logs:
        response = await client.get("/v1/calendar/events", params=WINDOW)

    message = assert_error(response, 424, "calendar_reconnect_required")
    connection = await get_connection(client)
    assert connection is not None
    assert connection["status"] == "reconnect_required"
    assert connection["last_error"] == message
    assert "calendar_reconnect_required" in logs.names
    # A refused refresh token is never accepted again: the next call asks Google nothing.
    again = await client.get("/v1/calendar/events", params=WINDOW)
    assert assert_error(again, 424, "calendar_reconnect_required") == message
    assert google.kinds == ["exchange", "refresh"]


async def test_events_google_500_is_502_and_status_unchanged(
    client: httpx.AsyncClient, google: GoogleStub
) -> None:
    google.events = GOOGLE_500
    await connect(client)

    response = await client.get("/v1/calendar/events", params=WINDOW)

    assert_error(response, 502, "calendar_provider_error")
    connection = await get_connection(client)
    assert connection is not None
    assert connection["status"] == "active"
    assert connection["last_error"] is None


async def test_events_after_the_token_key_changed_is_424(
    app: FastAPI, client: httpx.AsyncClient, google: GoogleStub
) -> None:
    await connect(client)
    # A restart with another CALENDAR_TOKEN_KEY: nothing cached, and the stored token unreadable.
    use_runtime(app, google_runtime(google, token_key=OTHER_TOKEN_KEY))

    with recorded_logs() as logs:
        response = await client.get("/v1/calendar/events", params=WINDOW)

    assert_error(response, 424, "calendar_reconnect_required")
    connection = await get_connection(client)
    assert connection is not None
    assert connection["status"] == "reconnect_required"
    assert google.kinds == ["exchange"]
    assert "calendar_token_unreadable" in logs.names
    assert OTHER_TOKEN_KEY not in logs.text


async def test_events_after_the_provider_changed_is_424_and_the_grant_kept(
    app: FastAPI, client: httpx.AsyncClient, google: GoogleStub
) -> None:
    await connect(client)
    # A restart on CALENDAR_PROVIDER=fake (a demo, QA, an API started without the repo-root
    # .env): the fake cannot read the Google grant, but Google never refused it.
    use_runtime(
        app,
        CalendarRuntime(
            provider=FakeCalendarProvider(started_at=datetime.now(UTC)),
            token_key=SecretStr(TOKEN_KEY),
            audience="external_testing",
        ),
    )

    response = await client.get("/v1/calendar/events", params=WINDOW)

    message = assert_error(response, 424, "calendar_reconnect_required")
    assert "connect" in message.lower()
    connection = await get_connection(client)
    assert connection is not None
    assert connection["status"] == "active"
    assert connection["last_error"] is None
    # Back on Google (a restart, so nothing cached): the stored grant serves events again, with
    # no new sign-in.
    use_runtime(app, google_runtime(google))
    again = await client.get("/v1/calendar/events", params=WINDOW)
    assert again.status_code == 200, again.text
    assert google.kinds == ["exchange", "refresh", "events"]


async def test_events_on_the_fake_provider_are_its_script(client: httpx.AsyncClient) -> None:
    await connect(client, code="fake")
    now = datetime.now(UTC)
    window = {
        "from": (now - timedelta(hours=36)).isoformat(),
        "to": (now + timedelta(hours=36)).isoformat(),
    }

    response = await client.get("/v1/calendar/events", params=window)

    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert {item["provider"] for item in items} == {"fake"}
    assert "fake-call" in [item["id"] for item in items]


@pytest.mark.parametrize(
    ("window", "field"),
    [
        pytest.param({"from": WINDOW["to"], "to": WINDOW["from"]}, "query", id="reversed"),
        pytest.param({"from": WINDOW["from"], "to": WINDOW["from"]}, "query", id="empty"),
        pytest.param(
            {"from": "2026-10-01T00:00:00Z", "to": "2026-10-08T00:00:01Z"},
            "query",
            id="over-7-days",
        ),
        pytest.param(
            {"from": "2026-10-05T00:00:00", "to": "2026-10-06T00:00:00Z"}, "query.from", id="naive"
        ),
        pytest.param({"from": "yesterday", "to": WINDOW["to"]}, "query.from", id="not-an-instant"),
        pytest.param({"from": WINDOW["from"]}, "query.to", id="missing-to"),
    ],
)
async def test_events_window_over_7_days_or_reversed_is_422(
    client: httpx.AsyncClient, google: GoogleStub, window: dict[str, str], field: str
) -> None:
    await connect(client)

    response = await client.get("/v1/calendar/events", params=window)

    message = assert_error(response, 422, "validation_error")
    assert f"Invalid request: {field}" in message
    assert google.kinds == ["exchange"]


async def test_events_window_of_exactly_7_days_is_accepted(
    client: httpx.AsyncClient, google: GoogleStub
) -> None:
    await connect(client)
    window = {"from": "2026-10-01T00:00:00+05:30", "to": "2026-10-08T00:00:00+05:30"}

    response = await client.get("/v1/calendar/events", params=window)

    assert response.status_code == 200, response.text
    [request] = google.requests("events")
    assert request.url.params["timeMin"] == "2026-09-30T18:30:00+00:00"


# Disconnect -------------------------------------------------------------------------------------


async def test_disconnect_revokes_and_deletes(
    app: FastAPI, client: httpx.AsyncClient, google: GoogleStub
) -> None:
    await connect(client)

    response = await client.delete("/v1/calendar/connection")

    assert response.status_code == 204
    assert response.content == b""
    [revoke] = google.requests("revoke")
    assert parse_qs(revoke.content.decode()) == {"token": [REFRESH_TOKEN]}
    assert await stored_connections(app) == []
    assert await get_connection(client) is None
    assert_error(await client.get("/v1/calendar/events", params=WINDOW), 404, "not_found")


async def test_disconnect_with_a_failed_revoke_still_deletes_and_logs(
    app: FastAPI, client: httpx.AsyncClient, google: GoogleStub
) -> None:
    google.revoke = GOOGLE_500
    await connect(client)

    with recorded_logs() as logs:
        response = await client.delete("/v1/calendar/connection")

    assert response.status_code == 204
    assert google.kinds == ["exchange", "revoke"]
    assert await stored_connections(app) == []
    [failed] = [event for event in logs.events if event["event"] == "calendar_revoke_failed"]
    assert failed["provider"] == "google"
    assert failed["level"] == "warning"
    assert_no_secret(logs.text)


async def test_disconnect_a_second_time_is_204(
    client: httpx.AsyncClient, google: GoogleStub
) -> None:
    await connect(client)

    first = await client.delete("/v1/calendar/connection")
    second = await client.delete("/v1/calendar/connection")

    assert (first.status_code, second.status_code) == (204, 204)
    assert google.kinds == ["exchange", "revoke"]


async def test_disconnect_forgets_the_cached_access_token(
    client: httpx.AsyncClient, google: GoogleStub
) -> None:
    await connect(client)
    await client.delete("/v1/calendar/connection")
    google.exchange = answer(token_body(access_token="ya29.after-reconnect", expires_in=30))

    await connect(client)
    response = await client.get("/v1/calendar/events", params=WINDOW)

    assert response.status_code == 200, response.text
    [events] = google.requests("events")
    assert events.headers["Authorization"] == f"Bearer {REFRESHED_ACCESS_TOKEN}"


async def test_disconnect_on_the_fake_provider_is_204(client: httpx.AsyncClient) -> None:
    await connect(client, code="fake")

    response = await client.delete("/v1/calendar/connection")

    assert response.status_code == 204
    assert await get_connection(client) is None


async def test_no_database_connection_is_held_while_google_answers(
    app: FastAPI, client: httpx.AsyncClient, google: GoogleStub
) -> None:
    # A Google call may wait GOOGLE_TIMEOUT (10 s) per phase. A request that holds its pooled
    # connection across one sits idle in a transaction that long, and a few slow calls empty the
    # pool: every call to Google, the revoke included, comes after the session's last commit.
    database = app.state.database
    assert isinstance(database, Database)
    pool = database.engine.pool
    assert isinstance(pool, QueuePool)
    held: list[tuple[str, int]] = []

    def watched(kind: str, handler: Handler) -> Handler:
        def record(request: httpx.Request) -> httpx.Response:
            held.append((kind, pool.checkedout()))
            return handler(request)

        return record

    # Every call the routes make: the exchange, a refresh for an expiring token, a refused access
    # token with its refresh and retry, and the revoke.
    google.exchange = watched("exchange", answer(token_body(expires_in=30)))
    google.refresh = watched("refresh", REFRESHED)
    google.events = watched("events", in_turn(TOKEN_REJECTED, answer(events_page())))
    google.revoke = watched("revoke", google.revoke)

    await connect(client)
    assert (await client.get("/v1/calendar/events", params=WINDOW)).status_code == 200
    assert (await client.delete("/v1/calendar/connection")).status_code == 204

    assert held == [
        ("exchange", 0),
        ("refresh", 0),
        ("events", 0),
        ("refresh", 0),
        ("events", 0),
        ("revoke", 0),
    ]


# Secrets ----------------------------------------------------------------------------------------


async def test_secrets_never_logged(client: httpx.AsyncClient, google: GoogleStub) -> None:
    # Every path that handles a secret: the exchange, a refresh for an expiring token, a refused
    # access token with its retry, and the revoke.
    google.exchange = answer(token_body(expires_in=30))
    google.events = in_turn(TOKEN_REJECTED, answer(events_page()))

    with recorded_logs() as logs:
        authorization = await client.post(
            "/v1/calendar/google/authorization", json=AUTHORIZATION_BODY
        )
        await connect(client)
        events = await client.get("/v1/calendar/events", params=WINDOW)
        disconnect = await client.delete("/v1/calendar/connection")

    assert (authorization.status_code, events.status_code, disconnect.status_code) == (
        200,
        200,
        204,
    )
    assert google.kinds == ["exchange", "refresh", "events", "refresh", "events", "revoke"]
    # The expected lines arrived, so the check below looked at real output.
    assert {
        "calendar_connected",
        "calendar_access_token_rejected",
        "calendar_disconnected",
    } <= set(logs.names)
    assert logs.names.count("request") == 4
    assert_no_secret(logs.text)


class _ProviderTheDatabaseRefuses(GoogleCalendarProvider):
    @property
    def provider(self) -> CalendarProviderName:
        # A name the check constraint refuses, so the upsert that carries the token and the key
        # fails in Postgres itself. Cast: the type allows only the real names, on purpose.
        return cast("CalendarProviderName", "outlook")


@pytest.mark.parametrize("app_env", ["development", "production"])
async def test_db_error_never_leaks_token_or_key(
    database_url: str, clean_database: None, app_env: str
) -> None:
    # Both renderers: production writes JSON with each frame's locals, development a plain
    # traceback.
    app = create_app(make_settings(database_url, app_env=app_env))
    stub = GoogleStub()
    use_runtime(app, google_runtime(stub, provider_type=_ProviderTheDatabaseRefuses))

    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=BASE_URL, headers=AUTH_HEADERS
        ) as client,
    ):
        with recorded_logs() as logs:
            response = await client.post("/v1/calendar/google/connection", json=CONNECTION_BODY)

    assert_error(response, 500, "internal_error")
    assert stub.kinds == ["exchange"]
    assert_no_secret(logs.text, response.text)
    # No frame under the failed statement is rendered. In production every frame's locals are
    # logged, and SQLAlchemy's and asyncpg's hold the parameters in clear, token and key included;
    # unhandled, only structlog's 80-character cut of each local hides them (two UUIDs open the
    # parameter tuple), which is luck, not a guard.
    for library in ("sqlalchemy", "asyncpg", "fastapi"):
        assert package_dir(library) not in logs.text
    assert "unhandled_exception" not in logs.names
    # What went wrong is still logged: the check constraint's SQLSTATE.
    [failure] = [event for event in logs.events if event["event"] == "calendar_store_failed"]
    assert failure["level"] == "error"
    assert failure["sqlstate"] == "23514"
    assert failure["operation"] == "store the connection"


def package_dir(name: str) -> str:
    spec = importlib.util.find_spec(name)
    assert spec is not None
    assert spec.origin is not None
    return str(Path(spec.origin).parent)


type DatabaseFailure = Literal["postgres_gone", "pool_exhausted"]
# The error each failure raises, as calendar_store_failed names it. Neither is a DBAPIError.
DATABASE_FAILURE_ERRORS: dict[DatabaseFailure, str] = {
    "postgres_gone": "builtins.ConnectionRefusedError",
    "pool_exhausted": "sqlalchemy.exc.TimeoutError",
}


def closed_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
    return port


@asynccontextmanager
async def failing_database(database_url: str, failure: DatabaseFailure) -> AsyncIterator[Database]:
    """A database whose next statement fails before it reaches Postgres."""
    if failure == "postgres_gone":
        # Postgres stopped after the API started: nothing listens on the port, and asyncpg's
        # refused connection comes up raw, not wrapped in a DBAPIError.
        url = make_url(database_url).set(host="127.0.0.1", port=closed_port())
        database = Database(url.render_as_string(hide_password=False))
        try:
            yield database
        finally:
            await database.dispose()
        return
    # Every pooled connection is taken: the checkout gives up with sqlalchemy's TimeoutError.
    database = Database(database_url)
    database.engine = create_async_engine(
        database_url, pool_size=1, max_overflow=0, pool_timeout=0.1, hide_parameters=True
    )
    database.session_factory = async_sessionmaker(database.engine, expire_on_commit=False)
    try:
        async with database.engine.connect():
            yield database
    finally:
        await database.dispose()


@pytest.mark.parametrize("app_env", ["development", "production"])
@pytest.mark.parametrize("failure", ["postgres_gone", "pool_exhausted"])
async def test_lost_database_never_leaks_the_sign_in_code(
    database_url: str, clean_database: None, app_env: str, failure: DatabaseFailure
) -> None:
    # The code is redeemed at Google before the store fails. Unhandled, the failure would reach
    # middleware.py, and in production its traceback lists connect()'s locals: the code and the
    # verifier in full, and FastAPI's copy of the body.
    app = create_app(make_settings(database_url, app_env=app_env))
    stub = GoogleStub()
    use_runtime(app, google_runtime(stub))

    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=BASE_URL, headers=AUTH_HEADERS
        ) as client,
        failing_database(database_url, failure) as broken,
    ):
        app.dependency_overrides[get_database] = lambda: broken
        with recorded_logs() as logs:
            response = await client.post("/v1/calendar/google/connection", json=CONNECTION_BODY)

    assert_error(response, 500, "internal_error")
    assert stub.kinds == ["exchange"]
    [stored] = [event for event in logs.events if event["event"] == "calendar_store_failed"]
    assert stored["operation"] == "store the connection"
    assert stored["error"] == DATABASE_FAILURE_ERRORS[failure]
    assert "unhandled_exception" not in logs.names
    assert_no_secret(logs.text, response.text)
    for library in ("sqlalchemy", "asyncpg", "fastapi"):
        assert package_dir(library) not in logs.text


@pytest.mark.usefixtures("app")
@pytest.mark.parametrize("failure", ["postgres_gone", "pool_exhausted"])
async def test_lost_database_on_a_token_read_is_a_handled_500(
    database_url: str, failure: DatabaseFailure
) -> None:
    # The decrypt binds CALENDAR_TOKEN_KEY: like the upsert, it never fails unhandled.
    connection = StoredConnection(
        id=uuid4(),
        provider="google",
        account_email=ACCOUNT_EMAIL,
        status="active",
        last_error=None,
        connected_at=datetime.now(UTC),
        refresh_token=b"pgp-ciphertext",
    )

    async with failing_database(database_url, failure) as broken, broken.session() as session:
        with recorded_logs() as logs, pytest.raises(CalendarStoreError):
            await connections.read_refresh_token(session, connection, SecretStr(TOKEN_KEY))

    [stored] = [event for event in logs.events if event["event"] == "calendar_store_failed"]
    assert stored["operation"] == "read the refresh token"
    assert stored["error"] == DATABASE_FAILURE_ERRORS[failure]
    assert TOKEN_KEY not in logs.text


async def test_database_errors_never_render_bind_parameters(database_url: str) -> None:
    # db/engine.py's hide_parameters: a failed statement's text names no bound value.
    database = Database(database_url)
    try:
        async with database.session() as session:
            with pytest.raises(DBAPIError) as raised:
                await session.execute(
                    text("SELECT CAST(:secret AS text), 1 / 0"), {"secret": TOKEN_KEY}
                )
    finally:
        await database.dispose()

    assert "division by zero" in str(raised.value)
    assert TOKEN_KEY not in str(raised.value)


# Runtime ----------------------------------------------------------------------------------------


type SettingsFactory = Callable[..., Settings]


@pytest.fixture
def runtime_settings(database_url: str) -> SettingsFactory:
    def build(**overrides: object) -> Settings:
        return make_settings(database_url, **overrides)

    return build


async def test_runtime_is_the_fake_provider_by_default(
    runtime_settings: SettingsFactory,
) -> None:
    before = datetime.now(UTC)

    async with open_calendar_runtime(runtime_settings()) as runtime:
        assert isinstance(runtime.provider, FakeCalendarProvider)
        assert runtime.audience == "external_testing"
        # Anchored at startup: the scripted call is two minutes after the API started.
        events = await runtime.provider.list_events(
            "fake", time_min=before, time_max=before + timedelta(hours=1)
        )
    [call] = [event for event in events if event.id == "fake-call"]
    assert call.start is not None
    assert before + timedelta(minutes=2) - timedelta(seconds=1) <= call.start
    assert call.start <= datetime.now(UTC) + timedelta(minutes=2)


async def test_runtime_reads_the_fake_calendar_file(runtime_settings: SettingsFactory) -> None:
    settings = runtime_settings(fake_calendar_file=str(FIXTURES / "fake_calendar.json"))

    async with open_calendar_runtime(settings) as runtime:
        events = await runtime.provider.list_events(
            "fake",
            time_min=datetime(2026, 10, 6, tzinfo=UTC),
            time_max=datetime(2026, 10, 7, tzinfo=UTC),
        )

    assert "file-board-meeting" in [event.id for event in events]


async def test_runtime_on_google_holds_the_client_and_the_key(
    runtime_settings: SettingsFactory,
) -> None:
    settings = runtime_settings(
        calendar_provider="google",
        google_oauth_client_id=CLIENT_ID,
        google_oauth_client_secret=CLIENT_SECRET,
        google_oauth_audience="external_production",
        calendar_token_key=TOKEN_KEY,
    )

    async with open_calendar_runtime(settings) as runtime:
        assert isinstance(runtime.provider, GoogleCalendarProvider)
        assert runtime.audience == "external_production"
        assert runtime.token_key is not None
        assert runtime.token_key.get_secret_value() == TOKEN_KEY
        url = runtime.provider.authorization_url(
            redirect_uri=REDIRECT_URI, code_challenge=CHALLENGE, state=STATE
        )
    assert parse_qs(urlsplit(url).query)["client_id"] == [CLIENT_ID]


async def test_lifespan_runtime_is_what_the_routes_use(app: FastAPI) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=BASE_URL, headers=AUTH_HEADERS
    ) as client:
        response = await client.post("/v1/calendar/google/authorization", json=AUTHORIZATION_BODY)

    # The default runtime is the fake: its authorization URL is the desktop's own redirect.
    assert response.json()["authorization_url"].startswith(REDIRECT_URI)
    assert isinstance(app.state.calendar_runtime, CalendarRuntime)


# Access token cache -----------------------------------------------------------------------------


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def owner() -> Principal:
    return Principal(workspace_id=uuid4(), user_id=None)


def test_access_token_is_kept_until_a_minute_before_it_expires(owner: Principal) -> None:
    clock = Clock()
    cache = AccessTokenCache(clock=clock)
    connection_id = uuid4()

    cache.put(owner, connection_id, AccessToken(value=ACCESS_TOKEN, expires_in_seconds=3600))

    clock.now += 3600 - ACCESS_TOKEN_MARGIN_SECONDS - 1
    assert cache.get(owner, connection_id) == ACCESS_TOKEN
    clock.now += 1
    assert cache.get(owner, connection_id) is None


def test_access_token_belongs_to_one_connection(owner: Principal) -> None:
    cache = AccessTokenCache(clock=Clock())
    replaced, current = uuid4(), uuid4()

    cache.put(owner, replaced, AccessToken(value=ACCESS_TOKEN, expires_in_seconds=3600))

    assert cache.get(owner, current) is None
    cache.put(owner, current, AccessToken(value=REFRESHED_ACCESS_TOKEN, expires_in_seconds=3600))
    assert cache.get(owner, replaced) is None
    assert cache.get(owner, current) == REFRESHED_ACCESS_TOKEN
    cache.drop(owner)
    assert cache.get(owner, current) is None


def test_access_token_cache_prints_no_token(owner: Principal) -> None:
    cache = AccessTokenCache(clock=Clock())
    cache.put(owner, uuid4(), AccessToken(value=ACCESS_TOKEN, expires_in_seconds=3600))

    assert ACCESS_TOKEN not in repr(cache)
    assert ACCESS_TOKEN not in repr(vars(cache))
