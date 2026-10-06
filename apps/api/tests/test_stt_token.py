import dataclasses
import json
from collections.abc import AsyncIterator, Callable
from types import MappingProxyType
from uuid import UUID, uuid4

import httpx
import pytest
from asgi_lifespan import LifespanManager
from fastapi import FastAPI
from pydantic import ValidationError
from sqlalchemy import event
from sqlalchemy.engine import Connection

from roger_api import config
from roger_api.app import create_app
from roger_api.config import Settings
from roger_api.db.engine import Database
from roger_api.db.models import Workspace
from roger_api.db.models_vocabulary import VocabularyTerm
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
)
from roger_api.stt_vendors import (
    STT_PRESETS,
    STT_VENDORS,
    SttPreset,
    open_stt_token_issuer,
)
from tests.conftest import make_settings
from tests.helpers import AUTH_HEADERS, BASE_URL, Json, assert_error

DEEPGRAM_KEY = "dg-secret-key"
ASSEMBLYAI_KEY = "aai-secret-key"
# The stream settings the test app (STT_PROVIDER=fake) returns to a workspace with no jargon list.
STREAM = {
    "model": "fake",
    "language": "en",
    "sample_rate": 16000,
    "encoding": "linear16",
    "keyterms": [],
    "price_per_hour_usd": 0.0,
}

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
    # The model and its price come from the preset; the rest from the stream settings.
    settings = make_settings(
        database_url,
        stt_provider="assemblyai-pro",
        assemblyai_api_key=ASSEMBLYAI_KEY,
        stt_sample_rate=48000,
    )

    assert SttStreamSettings.from_settings(settings).model_dump() == {
        **STREAM,
        "model": "universal-3-6-pro",
        "sample_rate": 48000,
        "price_per_hour_usd": 0.45,
    }


def test_stream_price_is_the_override_when_set(database_url: str) -> None:
    settings = make_settings(
        database_url,
        stt_provider="deepgram",
        deepgram_api_key=DEEPGRAM_KEY,
        stt_price_per_hour_usd=0.348,
    )

    assert SttStreamSettings.from_settings(settings).price_per_hour_usd == 0.348


def test_unknown_stream_price_is_null(database_url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    # Every real preset has a list price (tests/test_stt_providers.py), so this one is patched in:
    # a model the registry has no price for is null, never a guess.
    unpriced = SttPreset(vendor="deepgram", model="nova-2")
    monkeypatch.setattr(
        config, "STT_PRESETS", MappingProxyType({**STT_PRESETS, "deepgram": unpriced})
    )
    settings = make_settings(database_url, stt_provider="deepgram", deepgram_api_key=DEEPGRAM_KEY)

    assert SttStreamSettings.from_settings(settings).model_dump() == {
        **STREAM,
        "model": "nova-2",
        "price_per_hour_usd": None,
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
    # The 3-hour session cap is asked for explicitly, never left to the vendor's default.
    assert str(request.url) == (
        f"{ASSEMBLYAI_GRANT_URL}?expires_in_seconds=45&max_session_duration_seconds=10800"
    )
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
        # The price is per hour of one open stream, silent or not; a meeting opens two.
        "stream": {**STREAM, "model": "universal-streaming-english", "price_per_hour_usd": 0.15},
    }
    assert ASSEMBLYAI_KEY not in response.text


@pytest.mark.parametrize("handler", [aai_refuse, aai_fail, times_out])
async def test_assemblyai_failure_is_a_502_envelope(
    assemblyai_client: Callable[[Handler], httpx.AsyncClient], handler: Handler
) -> None:
    response = await assemblyai_client(handler).post("/v1/stt/token")

    assert_error(response, 502, "stt_provider_error")
    assert ASSEMBLYAI_KEY not in response.text


# ---------------------------------------------------------------------------- keyterms (M3-T3)

VOCABULARY_PATH = "/v1/vocabulary"
VENDOR_KEYS = {"assemblyai_api_key": ASSEMBLYAI_KEY, "deepgram_api_key": DEEPGRAM_KEY}


def database_of(app: FastAPI) -> Database:
    database = app.state.database
    assert isinstance(database, Database)
    return database


async def put_vocabulary(client: httpx.AsyncClient, terms: list[str]) -> None:
    response = await client.put(VOCABULARY_PATH, json={"terms": terms})
    assert response.status_code == 200, response.text


async def token_stream(client: httpx.AsyncClient) -> Json:
    response = await client.post("/v1/stt/token")
    assert response.status_code == 200, response.text
    stream: Json = response.json()["stream"]
    return stream


async def store_terms(app: FastAPI, workspace_id: UUID, terms: list[str]) -> None:
    """Rows written straight to the table, past the PUT's limits."""
    async with database_of(app).session() as session:
        session.add_all(
            VocabularyTerm(id=uuid4(), workspace_id=workspace_id, term=term) for term in terms
        )
        await session.commit()


async def test_token_carries_the_workspace_keyterms(client: httpx.AsyncClient) -> None:
    await put_vocabulary(client, ["Roger", "linkt", "AssemblyAI"])

    stream = await token_stream(client)

    # As `GET /v1/vocabulary` lists them: spelled as the user spelled them, sorted ignoring case.
    assert stream == {**STREAM, "keyterms": ["AssemblyAI", "linkt", "Roger"]}


async def test_token_keyterms_empty_when_no_list(client: httpx.AsyncClient) -> None:
    assert (await token_stream(client))["keyterms"] == []

    await put_vocabulary(client, ["Linkt"])
    await put_vocabulary(client, [])

    # A cleared list is an empty one, never the list as it was.
    assert (await token_stream(client))["keyterms"] == []


async def test_token_never_carries_another_workspace_terms(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    other_workspace = uuid4()
    async with database_of(app).session() as session:
        session.add(Workspace(id=other_workspace, name="Someone else"))
        await session.commit()
    await store_terms(app, other_workspace, ["Acme", "Globex"])

    assert (await token_stream(client))["keyterms"] == []

    await put_vocabulary(client, ["Linkt"])

    assert (await token_stream(client))["keyterms"] == ["Linkt"]


async def test_token_reads_the_list_in_one_query_of_at_most_100_terms(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings
) -> None:
    # A PUT stores at most 100 terms, AssemblyAI's limit. Rows that got past it another way are
    # still cut at 100 here, never sent to a vendor that refuses the whole stream over them.
    terms = [f"term{index:03d}" for index in range(101)]
    await store_terms(app, settings.default_workspace_id, terms)
    engine = database_of(app).engine.sync_engine
    statements: list[str] = []

    def record(
        conn: Connection,
        cursor: object,
        statement: str,
        parameters: object,
        context: object,
        executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        stream = await token_stream(client)
    finally:
        event.remove(engine, "before_cursor_execute", record)

    assert stream["keyterms"] == terms[:100]
    [read] = [statement for statement in statements if "vocabulary_terms" in statement]
    assert "LIMIT" in read


# Per hour of one stream, without and with a jargon list. Sources and dates: stt_vendors.py.
SURCHARGES = [
    # Universal-Streaming English: +$0.04 an hour for keyterms prompting.
    ("assemblyai", 0.15, 0.19),
    # Universal-3.6 Pro: keyterms are included in its price.
    ("assemblyai-pro", 0.45, 0.45),
    # Nova-3: +$0.0013 a minute for keyterm prompting.
    ("deepgram", 0.462, 0.54),
    ("fake", 0.0, 0.0),
]


@pytest.mark.parametrize(("preset", "without_list", "with_list"), SURCHARGES)
def test_keyterm_surcharge_only_with_a_list(
    database_url: str, preset: str, without_list: float, with_list: float
) -> None:
    settings = make_settings(database_url, stt_provider=preset, **VENDOR_KEYS)

    def price(keyterms: list[str]) -> float | None:
        return SttStreamSettings.from_settings(settings, keyterms=keyterms).price_per_hour_usd

    assert SttStreamSettings.from_settings(settings).price_per_hour_usd == without_list
    assert price([]) == without_list
    assert price(["Linkt"]) == with_list
    # The surcharge is per stream hour, whatever the list's length.
    assert price([f"term{index}" for index in range(100)]) == with_list


async def test_token_price_includes_the_surcharge_with_a_list(
    assemblyai_client: Callable[[Handler], httpx.AsyncClient],
) -> None:
    client = assemblyai_client(temporary_token)
    universal_streaming = {**STREAM, "model": "universal-streaming-english"}

    assert await token_stream(client) == {**universal_streaming, "price_per_hour_usd": 0.15}

    await put_vocabulary(client, ["Linkt"])

    assert await token_stream(client) == {
        **universal_streaming,
        "keyterms": ["Linkt"],
        "price_per_hour_usd": 0.19,
    }


def test_keyterm_surcharge_is_added_to_the_price_override(database_url: str) -> None:
    # STT_PRICE_PER_HOUR_USD replaces the model's base price (a negotiated rate, or Deepgram's
    # price with training opted out); the vendor still bills keyterms on top of it.
    settings = make_settings(
        database_url,
        stt_provider="deepgram",
        deepgram_api_key=DEEPGRAM_KEY,
        stt_price_per_hour_usd=0.348,
    )

    stream = SttStreamSettings.from_settings(settings, keyterms=["Linkt"])

    assert stream.price_per_hour_usd == 0.426


def test_unknown_price_stays_null_with_a_list(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No base price, so no total: the surcharge alone would read as the whole price.
    unpriced = SttPreset(vendor="deepgram", model="nova-2")
    monkeypatch.setattr(
        config, "STT_PRESETS", MappingProxyType({**STT_PRESETS, "deepgram": unpriced})
    )
    settings = make_settings(database_url, stt_provider="deepgram", deepgram_api_key=DEEPGRAM_KEY)

    assert SttStreamSettings.from_settings(settings, keyterms=["Linkt"]).price_per_hour_usd is None


def test_unknown_keyterm_surcharge_makes_the_price_null(
    database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The base price alone would under-count every meeting with a list; null says "unknown".
    no_surcharge = dataclasses.replace(STT_VENDORS["deepgram"], keyterm_surcharge_per_hour_usd={})
    monkeypatch.setattr(
        config, "STT_VENDORS", MappingProxyType({**STT_VENDORS, "deepgram": no_surcharge})
    )
    settings = make_settings(database_url, stt_provider="deepgram", deepgram_api_key=DEEPGRAM_KEY)

    assert SttStreamSettings.from_settings(settings).price_per_hour_usd == 0.462
    assert SttStreamSettings.from_settings(settings, keyterms=["Linkt"]).price_per_hour_usd is None


def test_every_preset_model_has_a_keyterm_surcharge() -> None:
    # 0.0 where the model's price includes keyterms. Without one, every stream with a jargon list
    # reports an unknown price and the desktop's meter stops counting its cost.
    for preset, row in STT_PRESETS.items():
        assert STT_VENDORS[row.vendor].keyterm_surcharge_for(row.model) is not None, preset
