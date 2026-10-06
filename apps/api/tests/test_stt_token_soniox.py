"""Soniox, the optional third speech-to-text vendor (decision D1, M3-T14): its temporary-key issuer
and the `soniox` preset. The desktop adapter is M3-T15's; until it lands, STT_PROVIDER=soniox
passes the API's startup and fails Start on the Mac (`AWAITING_A_DESKTOP_ADAPTER` in
tests/test_stt_providers.py). Nothing here calls Soniox: every request goes to a MockTransport."""

import json
from collections.abc import AsyncIterator, Callable

import httpx
import pytest
from asgi_lifespan import LifespanManager
from fastapi import FastAPI

from roger_api.app import create_app
from roger_api.dependencies import get_stt_token_issuer
from roger_api.errors import SttProviderError
from roger_api.schemas.stt import SttStreamSettings
from roger_api.services.stt_tokens import (
    SONIOX_GRANT_URL,
    SonioxSttTokenIssuer,
    SttCredential,
)
from roger_api.stt_vendors import open_stt_token_issuer
from tests.conftest import make_settings
from tests.helpers import AUTH_HEADERS, BASE_URL, Json, assert_error
from tests.test_stt_providers import recorded_events

DATABASE_URL = "postgresql+asyncpg://postgres@localhost:5432/roger"
SONIOX_KEY = "soniox-secret-key-0123"
TEMPORARY_KEY = "temp:soniox-temporary-key"
# The stream settings of the `soniox` preset for a workspace with no jargon list.
STREAM = {
    "model": "stt-rt-v5",
    "language": "en",
    "sample_rate": 16000,
    "encoding": "linear16",
    "keyterms": [],
    "price_per_hour_usd": 0.12,
    "price_per_hour_usd_without_keyterms": 0.12,
}

type Handler = Callable[[httpx.Request], httpx.Response]


def soniox_issuer(handler: Handler, ttl_seconds: int = 30) -> SonioxSttTokenIssuer:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return SonioxSttTokenIssuer(http, api_key=SONIOX_KEY, ttl_seconds=ttl_seconds)


def temporary_key(request: httpx.Request) -> httpx.Response:
    # Soniox answers 201 Created, not 200.
    return httpx.Response(
        201, json={"api_key": TEMPORARY_KEY, "expires_at": "2026-10-07T10:00:30Z"}
    )


async def test_soniox_temporary_key_request_is_exact() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return temporary_key(request)

    credential = await soniox_issuer(handler, ttl_seconds=45).issue()

    assert credential == SttCredential(provider="soniox", access_token=TEMPORARY_KEY, expires_in=45)
    [request] = seen
    assert request.method == "POST"
    assert str(request.url) == SONIOX_GRANT_URL
    assert SONIOX_GRANT_URL == "https://api.soniox.com/v1/auth/temporary-api-key"
    assert request.headers["Authorization"] == f"Bearer {SONIOX_KEY}"
    assert request.headers["Content-Type"] == "application/json"
    assert json.loads(request.content) == {
        "usage_type": "transcribe_websocket",
        "expires_in_seconds": 45,
        # One key opens both of the desktop's streams (mic and system audio): never single use.
        "single_use": False,
        # The session cap is asked for on every key, never left to the vendor, which applies no
        # limit when it is missing.
        "max_session_duration_seconds": 18000,
    }


async def test_soniox_expiry_is_the_requested_lifetime() -> None:
    # `expires_at` is an instant on Soniox's clock; the API's clock may differ from it, so the
    # answer's `expires_in` is the lifetime the issuer asked for, never one computed from it.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            201, json={"api_key": TEMPORARY_KEY, "expires_at": "2000-01-01T00:00:00Z"}
        )

    credential = await soniox_issuer(handler, ttl_seconds=20).issue()

    assert credential.expires_in == 20


def soniox_error(status: int, error_type: str) -> Handler:
    """Soniox's documented error body for one status."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            json={
                "error_code": status,
                "error_type": error_type,
                "error_message": f"{error_type} (test)",
                "request_id": "req-1",
            },
        )

    return handler


def answer(body: object) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json=body)

    return handler


def not_json(request: httpx.Request) -> httpx.Response:
    return httpx.Response(201, text="<html>")


def unreachable(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused", request=request)


def times_out(request: httpx.Request) -> httpx.Response:
    raise httpx.ReadTimeout("timed out", request=request)


SONIOX_FAILURES = {
    "invalid-request": soniox_error(400, "invalid_request"),
    "wrong-key": soniox_error(401, "unauthenticated"),
    "payment-required": soniox_error(402, "payment_required"),
    "rate-limited": soniox_error(429, "rate_limit_exceeded"),
    "server-error": soniox_error(500, "internal_error"),
    "empty-key": answer({"api_key": "", "expires_at": "2026-10-07T10:00:30Z"}),
    "number-key": answer({"api_key": 12345, "expires_at": "2026-10-07T10:00:30Z"}),
    "no-key": answer({"expires_at": "2026-10-07T10:00:30Z"}),
    "not-json": not_json,
    "unreachable": unreachable,
    "times-out": times_out,
}


@pytest.mark.parametrize("handler", SONIOX_FAILURES.values(), ids=SONIOX_FAILURES.keys())
async def test_soniox_failures_raise_provider_error(handler: Handler) -> None:
    with pytest.raises(SttProviderError) as raised:
        await soniox_issuer(handler).issue()

    assert SONIOX_KEY not in raised.value.message


@pytest.fixture
async def soniox_app(database_url: str, clean_database: None) -> AsyncIterator[FastAPI]:
    settings = make_settings(database_url, stt_provider="soniox", soniox_api_key=SONIOX_KEY)
    application = create_app(settings)
    async with LifespanManager(application):
        yield application


@pytest.fixture
async def soniox_client(
    soniox_app: FastAPI,
) -> AsyncIterator[Callable[[Handler], httpx.AsyncClient]]:
    clients: list[httpx.AsyncClient] = []

    def connect(handler: Handler) -> httpx.AsyncClient:
        async def override() -> AsyncIterator[SonioxSttTokenIssuer]:
            yield soniox_issuer(handler)

        soniox_app.dependency_overrides[get_stt_token_issuer] = override
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=soniox_app), base_url=BASE_URL, headers=AUTH_HEADERS
        )
        clients.append(client)
        return client

    yield connect
    for client in clients:
        await client.aclose()


async def test_soniox_token_through_the_api(
    soniox_client: Callable[[Handler], httpx.AsyncClient],
) -> None:
    response = await soniox_client(temporary_key).post("/v1/stt/token")

    assert response.status_code == 200, response.text
    body: Json = response.json()
    # `provider` is the vendor id the desktop's registry picks its adapter by (M3-T15).
    assert body == {
        "provider": "soniox",
        "access_token": TEMPORARY_KEY,
        "expires_in": 30,
        "stream": STREAM,
    }
    assert SONIOX_KEY not in response.text


async def test_soniox_token_carries_the_jargon_list_at_the_same_price(
    soniox_client: Callable[[Handler], httpx.AsyncClient],
) -> None:
    client = soniox_client(temporary_key)
    response = await client.put("/v1/vocabulary", json={"terms": ["Roger", "Linkt"]})
    assert response.status_code == 200, response.text

    response = await client.post("/v1/stt/token")

    assert response.status_code == 200, response.text
    # Soniox bills the list as a few input text tokens per stream, not per hour (stt_vendors.py).
    assert response.json()["stream"] == {**STREAM, "keyterms": ["Linkt", "Roger"]}


@pytest.mark.parametrize(
    "handler",
    [SONIOX_FAILURES["wrong-key"], SONIOX_FAILURES["server-error"], times_out],
    ids=["wrong-key", "server-error", "times-out"],
)
async def test_soniox_failure_is_a_502_envelope(
    soniox_client: Callable[[Handler], httpx.AsyncClient], handler: Handler
) -> None:
    client = soniox_client(handler)

    with recorded_events() as events:
        response = await client.post("/v1/stt/token")

    assert_error(response, 502, "stt_provider_error")
    assert SONIOX_KEY not in response.text
    # The failure was logged (so the next assertion checks real log lines), without the key.
    assert {"stt_token_rejected", "stt_token_unreachable"} & {e.get("event") for e in events}
    assert SONIOX_KEY not in str(events)


async def test_soniox_tokens_are_never_logged(
    soniox_client: Callable[[Handler], httpx.AsyncClient],
) -> None:
    client = soniox_client(temporary_key)

    with recorded_events() as events:
        response = await client.post("/v1/stt/token")

    assert response.status_code == 200, response.text
    # The request's access line arrived, so the recorder saw this request's events.
    assert "request" in {e.get("event") for e in events}
    assert SONIOX_KEY not in str(events)
    assert TEMPORARY_KEY not in str(events)


def test_soniox_preset_picks_its_vendor_model_and_price() -> None:
    settings = make_settings(DATABASE_URL, stt_provider="soniox", soniox_api_key=SONIOX_KEY)

    assert settings.stt_vendor.provider == "soniox"
    assert settings.stt_stream_model == "stt-rt-v5"
    assert settings.stt_stream_price_per_hour_usd == 0.12
    assert settings.stt_vendor_key is not None
    assert settings.stt_vendor_key.get_secret_value() == SONIOX_KEY


def test_soniox_token_ttl_takes_the_vendor_whole_range() -> None:
    # Soniox accepts expires_in_seconds from 1 to 3600, the setting's own range.
    settings = make_settings(
        DATABASE_URL,
        stt_provider="soniox",
        soniox_api_key=SONIOX_KEY,
        stt_token_ttl_seconds=3600,
    )

    assert settings.stt_token_ttl_seconds == 3600


def test_soniox_price_is_the_same_with_and_without_a_list() -> None:
    settings = make_settings(DATABASE_URL, stt_provider="soniox", soniox_api_key=SONIOX_KEY)

    for keyterms in ([], ["Linkt"], [f"term{index}" for index in range(100)]):
        stream = SttStreamSettings.from_settings(settings, keyterms=keyterms)
        assert stream.price_per_hour_usd == 0.12, keyterms
        assert stream.price_per_hour_usd_without_keyterms == 0.12, keyterms


async def test_issuer_opens_for_the_soniox_preset() -> None:
    settings = make_settings(DATABASE_URL, stt_provider="soniox", soniox_api_key=SONIOX_KEY)

    async with open_stt_token_issuer(settings) as issuer:
        assert type(issuer) is SonioxSttTokenIssuer
