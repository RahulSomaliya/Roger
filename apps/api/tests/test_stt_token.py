import json
from collections.abc import AsyncIterator, Callable

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError

from roger_api.config import Settings
from roger_api.dependencies import get_stt_token_issuer
from roger_api.errors import SttProviderError
from roger_api.schemas.stt import SttStreamSettings
from roger_api.services.stt_tokens import (
    DEEPGRAM_GRANT_URL,
    DeepgramSttTokenIssuer,
    FakeSttTokenIssuer,
    SttCredential,
    open_stt_token_issuer,
)
from tests.conftest import make_settings
from tests.helpers import assert_error

DEEPGRAM_KEY = "dg-secret-key"
STREAM = {"model": "nova-3", "language": "en", "sample_rate": 16000, "encoding": "linear16"}

type Handler = Callable[[httpx.Request], httpx.Response]


def deepgram_issuer(handler: Handler, ttl_seconds: int = 30) -> DeepgramSttTokenIssuer:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return DeepgramSttTokenIssuer(http, api_key=DEEPGRAM_KEY, ttl_seconds=ttl_seconds)


def grant(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"access_token": "eyJ.jwt", "expires_in": 30})


async def test_fake_provider(client: httpx.AsyncClient) -> None:
    response = await client.post("/v1/stt/token")

    assert response.status_code == 200
    assert response.json() == {
        "provider": "fake",
        "access_token": "",
        "expires_in": 0,
        "stream": STREAM,
    }


async def test_deepgram_grant_request_is_exact() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return grant(request)

    credential = await deepgram_issuer(handler, ttl_seconds=45).issue()

    assert credential == SttCredential(provider="deepgram", access_token="eyJ.jwt", expires_in=30)
    [request] = seen
    assert request.method == "POST"
    assert str(request.url) == DEEPGRAM_GRANT_URL == "https://api.deepgram.com/v1/auth/grant"
    assert request.headers["Authorization"] == f"Token {DEEPGRAM_KEY}"
    assert request.headers["Content-Type"] == "application/json"
    assert json.loads(request.content) == {"ttl_seconds": 45}


def refuse(request: httpx.Request) -> httpx.Response:
    return httpx.Response(401, json={"err_code": "INVALID_AUTH", "err_msg": "Invalid credentials."})


def fail(request: httpx.Request) -> httpx.Response:
    return httpx.Response(503, text="upstream unavailable")


def unreadable(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"unexpected": True})


def not_json(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, text="<html>")


def unreachable(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused", request=request)


@pytest.mark.parametrize("handler", [refuse, fail, unreadable, not_json, unreachable])
async def test_deepgram_failures_raise_provider_error(handler: Handler) -> None:
    with pytest.raises(SttProviderError):
        await deepgram_issuer(handler).issue()


@pytest.fixture
def use_issuer(app: FastAPI) -> Callable[[Handler], None]:
    def install(handler: Handler) -> None:
        async def override() -> AsyncIterator[DeepgramSttTokenIssuer]:
            yield deepgram_issuer(handler)

        app.dependency_overrides[get_stt_token_issuer] = override

    return install


async def test_deepgram_token_through_the_api(
    client: httpx.AsyncClient, use_issuer: Callable[[Handler], None]
) -> None:
    use_issuer(grant)

    response = await client.post("/v1/stt/token")

    assert response.status_code == 200
    assert response.json() == {
        "provider": "deepgram",
        "access_token": "eyJ.jwt",
        "expires_in": 30,
        "stream": STREAM,
    }


@pytest.mark.parametrize("handler", [refuse, unreachable])
async def test_vendor_failure_is_a_502_envelope(
    client: httpx.AsyncClient, use_issuer: Callable[[Handler], None], handler: Handler
) -> None:
    use_issuer(handler)

    message = assert_error(await client.post("/v1/stt/token"), 502, "stt_provider_error")

    assert DEEPGRAM_KEY not in message


def test_stream_settings_come_from_config(database_url: str) -> None:
    settings = make_settings(database_url, stt_model="nova-2", stt_sample_rate=48000)

    assert SttStreamSettings.from_settings(settings).model_dump() == {
        **STREAM,
        "model": "nova-2",
        "sample_rate": 48000,
    }


async def test_factory_builds_the_configured_issuer(settings: Settings) -> None:
    deepgram = settings.model_copy(
        update={"stt_provider": "deepgram", "deepgram_api_key": settings.roger_api_token}
    )

    async with open_stt_token_issuer(settings) as issuer:
        assert isinstance(issuer, FakeSttTokenIssuer)
    async with open_stt_token_issuer(deepgram) as issuer:
        assert isinstance(issuer, DeepgramSttTokenIssuer)


def test_deepgram_provider_requires_a_key(database_url: str) -> None:
    with pytest.raises(ValidationError, match="DEEPGRAM_API_KEY is required"):
        make_settings(database_url, stt_provider="deepgram")
