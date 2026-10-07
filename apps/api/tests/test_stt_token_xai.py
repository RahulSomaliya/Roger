"""xAI (Grok Voice Transcribe 2.0), the fourth speech-to-text vendor: its client-secret issuer and
the `xai` preset. The desktop adapter lands in the next commit (`AWAITING_A_DESKTOP_ADAPTER` in
tests/test_stt_providers.py covers the gap). Nothing here calls xAI: every request goes to a
MockTransport.

A client secret authenticates `wss://api.x.ai/v1/stt` against the real vendor (live check
2026-10-07), though xAI documents it for the `/v1/realtime` voice-agent socket only; see the
issuer's docstring."""

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
    XAI_GRANT_URL,
    SttCredential,
    XaiSttTokenIssuer,
)
from roger_api.stt_vendors import open_stt_token_issuer
from tests.conftest import make_settings
from tests.helpers import AUTH_HEADERS, BASE_URL, Json, assert_error
from tests.test_stt_providers import recorded_events

DATABASE_URL = "postgresql+asyncpg://postgres@localhost:5432/roger"
XAI_KEY = "xai-secret-key-0123"
CLIENT_SECRET = "xai-client-secret.ephemeral-0123"
# The stream settings of the `xai` preset for a workspace with no jargon list.
STREAM = {
    "model": "grok-voice-transcribe-2.0",
    "language": "en",
    "sample_rate": 16000,
    "encoding": "linear16",
    "keyterms": [],
    "price_per_hour_usd": 0.2,
    "price_per_hour_usd_without_keyterms": 0.2,
}

type Handler = Callable[[httpx.Request], httpx.Response]


def xai_issuer(handler: Handler, ttl_seconds: int = 30) -> XaiSttTokenIssuer:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return XaiSttTokenIssuer(http, api_key=XAI_KEY, ttl_seconds=ttl_seconds)


def client_secret(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"value": CLIENT_SECRET, "expires_at": 1_791_000_030})


async def test_xai_client_secret_request_is_exact() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return client_secret(request)

    credential = await xai_issuer(handler, ttl_seconds=45).issue()

    assert credential == SttCredential(provider="xai", access_token=CLIENT_SECRET, expires_in=45)
    [request] = seen
    assert request.method == "POST"
    assert str(request.url) == XAI_GRANT_URL
    assert XAI_GRANT_URL == "https://api.x.ai/v1/realtime/client_secrets"
    assert request.headers["Authorization"] == f"Bearer {XAI_KEY}"
    assert request.headers["Content-Type"] == "application/json"
    # Only the lifetime: no `session` block, which configures the voice-agent socket, not /v1/stt.
    assert json.loads(request.content) == {"expires_after": {"seconds": 45}}


async def test_xai_expiry_is_the_requested_lifetime() -> None:
    # `expires_at` is an instant on xAI's clock; the API's clock may differ from it, so `expires_in`
    # is the lifetime the issuer asked for, never one computed from it (as for Soniox).
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"value": CLIENT_SECRET, "expires_at": 1})

    credential = await xai_issuer(handler, ttl_seconds=20).issue()

    assert credential.expires_in == 20


def xai_error(status: int) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": f"status {status} (test)"})

    return handler


def answer(body: object) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=body)

    return handler


def not_json(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, text="<html>")


def unreachable(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused", request=request)


def times_out(request: httpx.Request) -> httpx.Response:
    raise httpx.ReadTimeout("timed out", request=request)


XAI_FAILURES = {
    "invalid-request": xai_error(400),
    "wrong-key": xai_error(401),
    "forbidden": xai_error(403),
    "rate-limited": xai_error(429),
    "server-error": xai_error(500),
    "empty-secret": answer({"value": "", "expires_at": 1}),
    "number-secret": answer({"value": 12345, "expires_at": 1}),
    "no-secret": answer({"expires_at": 1}),
    "not-json": not_json,
    "unreachable": unreachable,
    "times-out": times_out,
}


@pytest.mark.parametrize("handler", XAI_FAILURES.values(), ids=XAI_FAILURES.keys())
async def test_xai_failures_raise_provider_error(handler: Handler) -> None:
    with pytest.raises(SttProviderError) as raised:
        await xai_issuer(handler).issue()

    assert XAI_KEY not in raised.value.message


@pytest.fixture
async def xai_app(database_url: str, clean_database: None) -> AsyncIterator[FastAPI]:
    settings = make_settings(database_url, stt_provider="xai", xai_api_key=XAI_KEY)
    application = create_app(settings)
    async with LifespanManager(application):
        yield application


@pytest.fixture
async def xai_client(xai_app: FastAPI) -> AsyncIterator[Callable[[Handler], httpx.AsyncClient]]:
    clients: list[httpx.AsyncClient] = []

    def connect(handler: Handler) -> httpx.AsyncClient:
        async def override() -> AsyncIterator[XaiSttTokenIssuer]:
            yield xai_issuer(handler)

        xai_app.dependency_overrides[get_stt_token_issuer] = override
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=xai_app), base_url=BASE_URL, headers=AUTH_HEADERS
        )
        clients.append(client)
        return client

    yield connect
    for client in clients:
        await client.aclose()


async def test_xai_token_through_the_api(
    xai_client: Callable[[Handler], httpx.AsyncClient],
) -> None:
    response = await xai_client(client_secret).post("/v1/stt/token")

    assert response.status_code == 200, response.text
    body: Json = response.json()
    # `provider` is the vendor id the desktop's registry picks its adapter by.
    assert body == {
        "provider": "xai",
        "access_token": CLIENT_SECRET,
        "expires_in": 30,
        "stream": STREAM,
    }
    assert XAI_KEY not in response.text


async def test_xai_token_carries_the_jargon_list_at_the_same_price(
    xai_client: Callable[[Handler], httpx.AsyncClient],
) -> None:
    client = xai_client(client_secret)
    response = await client.put("/v1/vocabulary", json={"terms": ["Roger", "Linkt"]})
    assert response.status_code == 200, response.text

    response = await client.post("/v1/stt/token")

    assert response.status_code == 200, response.text
    # xAI prices keyterms at zero (its pricing page, stt_vendors.py).
    assert response.json()["stream"] == {**STREAM, "keyterms": ["Linkt", "Roger"]}


@pytest.mark.parametrize(
    "handler",
    [XAI_FAILURES["wrong-key"], XAI_FAILURES["server-error"], times_out],
    ids=["wrong-key", "server-error", "times-out"],
)
async def test_xai_failure_is_a_502_envelope(
    xai_client: Callable[[Handler], httpx.AsyncClient], handler: Handler
) -> None:
    client = xai_client(handler)

    with recorded_events() as events:
        response = await client.post("/v1/stt/token")

    assert_error(response, 502, "stt_provider_error")
    assert XAI_KEY not in response.text
    assert {"stt_token_rejected", "stt_token_unreachable"} & {e.get("event") for e in events}
    assert XAI_KEY not in str(events)


async def test_xai_tokens_are_never_logged(
    xai_client: Callable[[Handler], httpx.AsyncClient],
) -> None:
    client = xai_client(client_secret)

    with recorded_events() as events:
        response = await client.post("/v1/stt/token")

    assert response.status_code == 200, response.text
    assert "request" in {e.get("event") for e in events}
    assert XAI_KEY not in str(events)
    assert CLIENT_SECRET not in str(events)


def test_xai_preset_picks_its_vendor_model_and_price() -> None:
    settings = make_settings(DATABASE_URL, stt_provider="xai", xai_api_key=XAI_KEY)

    assert settings.stt_vendor.provider == "xai"
    assert settings.stt_stream_model == "grok-voice-transcribe-2.0"
    assert settings.stt_stream_price_per_hour_usd == 0.2
    assert settings.stt_vendor_key is not None
    assert settings.stt_vendor_key.get_secret_value() == XAI_KEY


def test_xai_token_ttl_takes_the_vendor_whole_range() -> None:
    # client_secrets accepts expires_after.seconds up to 3600, the setting's own range.
    settings = make_settings(
        DATABASE_URL, stt_provider="xai", xai_api_key=XAI_KEY, stt_token_ttl_seconds=3600
    )

    assert settings.stt_token_ttl_seconds == 3600


def test_xai_price_is_the_same_with_and_without_a_list() -> None:
    settings = make_settings(DATABASE_URL, stt_provider="xai", xai_api_key=XAI_KEY)

    for keyterms in ([], ["Linkt"], [f"term{index}" for index in range(100)]):
        stream = SttStreamSettings.from_settings(settings, keyterms=keyterms)
        assert stream.price_per_hour_usd == 0.2, keyterms
        assert stream.price_per_hour_usd_without_keyterms == 0.2, keyterms


async def test_issuer_opens_for_the_xai_preset() -> None:
    settings = make_settings(DATABASE_URL, stt_provider="xai", xai_api_key=XAI_KEY)

    async with open_stt_token_issuer(settings) as issuer:
        assert type(issuer) is XaiSttTokenIssuer
