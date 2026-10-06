import json
from collections.abc import AsyncIterator, Callable

import httpx
import pytest
from asgi_lifespan import LifespanManager
from fastapi import FastAPI
from pydantic import ValidationError

from roger_api.app import create_app
from roger_api.config import Settings
from roger_api.dependencies import get_stt_token_issuer
from roger_api.errors import SttProviderError
from roger_api.schemas.stt import SttStreamSettings
from roger_api.services.stt_tokens import (
    ASSEMBLYAI_GRANT_URL,
    DEEPGRAM_GRANT_URL,
    AssemblyAiSttTokenIssuer,
    DeepgramSttTokenIssuer,
    FakeSttTokenIssuer,
    SttCredential,
    open_stt_token_issuer,
)
from tests.conftest import make_settings
from tests.helpers import AUTH_HEADERS, BASE_URL, assert_error

DEEPGRAM_KEY = "dg-secret-key"
ASSEMBLYAI_KEY = "aai-secret-key"
# The stream settings the test app (STT_PROVIDER=fake, STT_MODEL unset) returns.
STREAM = {"model": "fake", "language": "en", "sample_rate": 16000, "encoding": "linear16"}

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
    assemblyai = settings.model_copy(
        update={"stt_provider": "assemblyai", "assemblyai_api_key": settings.roger_api_token}
    )

    async with open_stt_token_issuer(settings) as issuer:
        assert isinstance(issuer, FakeSttTokenIssuer)
    async with open_stt_token_issuer(deepgram) as issuer:
        assert isinstance(issuer, DeepgramSttTokenIssuer)
    async with open_stt_token_issuer(assemblyai) as issuer:
        assert isinstance(issuer, AssemblyAiSttTokenIssuer)


def test_deepgram_provider_requires_a_key(database_url: str) -> None:
    with pytest.raises(ValidationError, match="DEEPGRAM_API_KEY is required"):
        make_settings(database_url, stt_provider="deepgram")


def test_assemblyai_provider_requires_a_key(database_url: str) -> None:
    with pytest.raises(ValidationError, match="ASSEMBLYAI_API_KEY is required"):
        make_settings(database_url, stt_provider="assemblyai")


def assemblyai_issuer(handler: Handler, ttl_seconds: int = 30) -> AssemblyAiSttTokenIssuer:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return AssemblyAiSttTokenIssuer(http, api_key=ASSEMBLYAI_KEY, ttl_seconds=ttl_seconds)


def temporary_token(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"token": "aai-temp-token", "expires_in_seconds": 30})


async def test_assemblyai_token_request_is_exact() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"token": "aai-temp-token", "expires_in_seconds": 45})

    credential = await assemblyai_issuer(handler, ttl_seconds=45).issue()

    assert credential == SttCredential(
        provider="assemblyai", access_token="aai-temp-token", expires_in=45
    )
    [request] = seen
    assert request.method == "GET"
    assert ASSEMBLYAI_GRANT_URL == "https://streaming.assemblyai.com/v3/token"
    assert str(request.url) == f"{ASSEMBLYAI_GRANT_URL}?expires_in_seconds=45"
    # The raw key, no "Bearer" or "Token" prefix, as AssemblyAI documents it.
    assert request.headers["Authorization"] == ASSEMBLYAI_KEY
    assert request.content == b""


async def test_assemblyai_expiry_falls_back_to_the_requested_ttl() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"token": "aai-temp-token"})

    credential = await assemblyai_issuer(handler, ttl_seconds=20).issue()

    assert credential.expires_in == 20


def aai_refuse(request: httpx.Request) -> httpx.Response:
    return httpx.Response(401, json={"error": "Invalid API key"})


def aai_rate_limited(request: httpx.Request) -> httpx.Response:
    return httpx.Response(429, json={"error": "Too many requests"})


def aai_fail(request: httpx.Request) -> httpx.Response:
    return httpx.Response(500, json={"error": "Internal server error"})


def aai_empty_token(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"token": "", "expires_in_seconds": 30})


def aai_number_token(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"token": 12345, "expires_in_seconds": 30})


def times_out(request: httpx.Request) -> httpx.Response:
    raise httpx.ReadTimeout("timed out", request=request)


AAI_FAILURES = [
    aai_refuse,
    aai_rate_limited,
    aai_fail,
    aai_empty_token,
    aai_number_token,
    unreadable,
    not_json,
    unreachable,
    times_out,
]


@pytest.mark.parametrize("handler", AAI_FAILURES)
async def test_assemblyai_failures_raise_provider_error(handler: Handler) -> None:
    with pytest.raises(SttProviderError) as raised:
        await assemblyai_issuer(handler).issue()

    assert ASSEMBLYAI_KEY not in raised.value.message


@pytest.fixture
async def assemblyai_app(database_url: str, clean_database: None) -> AsyncIterator[FastAPI]:
    settings = make_settings(
        database_url, stt_provider="assemblyai", assemblyai_api_key=ASSEMBLYAI_KEY
    )
    application = create_app(settings)
    async with LifespanManager(application):
        yield application


@pytest.fixture
async def assemblyai_client(
    assemblyai_app: FastAPI,
) -> AsyncIterator[Callable[[Handler], httpx.AsyncClient]]:
    clients: list[httpx.AsyncClient] = []

    def connect(handler: Handler) -> httpx.AsyncClient:
        async def override() -> AsyncIterator[AssemblyAiSttTokenIssuer]:
            yield assemblyai_issuer(handler)

        assemblyai_app.dependency_overrides[get_stt_token_issuer] = override
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=assemblyai_app),
            base_url=BASE_URL,
            headers=AUTH_HEADERS,
        )
        clients.append(client)
        return client

    yield connect
    for client in clients:
        await client.aclose()


async def test_assemblyai_token_through_the_api(
    assemblyai_client: Callable[[Handler], httpx.AsyncClient],
) -> None:
    response = await assemblyai_client(temporary_token).post("/v1/stt/token")

    assert response.status_code == 200
    assert response.json() == {
        "provider": "assemblyai",
        "access_token": "aai-temp-token",
        "expires_in": 30,
        # Our encoding name: the desktop adapter maps linear16 to AssemblyAI's pcm_s16le.
        "stream": {**STREAM, "model": "universal-streaming-english"},
    }
    assert ASSEMBLYAI_KEY not in response.text


@pytest.mark.parametrize("handler", [aai_refuse, aai_fail, times_out])
async def test_assemblyai_failure_is_a_502_envelope(
    assemblyai_client: Callable[[Handler], httpx.AsyncClient], handler: Handler
) -> None:
    response = await assemblyai_client(handler).post("/v1/stt/token")

    assert_error(response, 502, "stt_provider_error")
    assert ASSEMBLYAI_KEY not in response.text
