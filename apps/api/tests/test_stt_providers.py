"""`STT_PROVIDER` names a preset: one vendor and one model, a row of `STT_PRESETS` in
stt_vendors.py. Every bake-off configuration is one `.env` line from every other, the desktop never
sees a preset (the token's `provider` is the vendor), and the retired `STT_MODEL` stops startup by
name (docs/plans/M3-live-transcript.md, M3-T1)."""

import logging
import re
from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager
from pathlib import Path
from types import MappingProxyType
from typing import Any, get_args

import httpx
import pytest
from asgi_lifespan import LifespanManager
from pydantic import ValidationError
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource

from roger_api import config
from roger_api.app import create_app
from roger_api.config import REPO_ROOT_ENV_FILE, Settings
from roger_api.dependencies import get_stt_token_issuer
from roger_api.schemas.stt import SttStreamSettings
from roger_api.services.stt_tokens import (
    AssemblyAiSttTokenIssuer,
    DeepgramSttTokenIssuer,
    FakeSttTokenIssuer,
    SttTokenIssuer,
)
from roger_api.stt_vendors import (
    STT_PRESETS,
    STT_VENDORS,
    SttPreset,
    SttPresetId,
    open_stt_token_issuer,
)
from tests.conftest import make_settings
from tests.helpers import AUTH_HEADERS, BASE_URL, TEST_TOKEN

DATABASE_URL = "postgresql+asyncpg://postgres@localhost:5432/roger"
DESKTOP_STT_REGISTRY = REPO_ROOT_ENV_FILE.parent / "apps/desktop/src/main/stt/registry.ts"
VENDOR_KEY = "vendor-secret-key-0123"


def vendor_keys() -> dict[str, str]:
    """Every vendor's key setting, named as config.py names it (`<vendor>_api_key`).

    Built from the registry, so a vendor added later is covered without editing this file.
    """
    return {
        f"{provider}_api_key": VENDOR_KEY
        for provider, vendor in STT_VENDORS.items()
        if vendor.issuer is not None
    }


def presets_with_a_vendor() -> list[SttPresetId]:
    return sorted(
        preset for preset, row in STT_PRESETS.items() if STT_VENDORS[row.vendor].issuer is not None
    )


@pytest.mark.parametrize(
    ("preset", "vendor", "model", "price"),
    [
        ("fake", "fake", "fake", 0.0),
        ("assemblyai", "assemblyai", "universal-streaming-english", 0.15),
        ("assemblyai-pro", "assemblyai", "universal-3-6-pro", 0.45),
        ("deepgram", "deepgram", "nova-3", 0.462),
    ],
)
def test_stt_provider_alone_picks_the_preset_vendor_and_model(
    preset: str, vendor: str, model: str, price: float
) -> None:
    settings = make_settings(DATABASE_URL, stt_provider=preset, **vendor_keys())

    assert settings.stt_vendor.provider == vendor
    assert settings.stt_stream_model == model
    assert settings.stt_stream_price_per_hour_usd == price


class DotenvOnlySettings(Settings):
    """Settings read from one `.env` file only, the way `make dev-api` reads the repo-root one."""

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        return (dotenv_settings,)


def test_every_bakeoff_config_differs_from_every_other_by_one_line(tmp_path: Path) -> None:
    # The exit check flips vendor by changing STT_PROVIDER alone. With the retired STT_MODEL, a
    # move to or from another model took a second line, and a leftover one stopped the API.
    base = [
        f"DATABASE_URL={DATABASE_URL}",
        f"ROGER_API_TOKEN={TEST_TOKEN}",
        *(f"{name.upper()}={value}" for name, value in vendor_keys().items()),
        "STT_TOKEN_TTL_SECONDS=30",
        "STT_PRICE_PER_HOUR_USD=",
        "STT_LANGUAGE=en",
        "STT_SAMPLE_RATE=16000",
        "STT_ENCODING=linear16",
    ]
    streams: dict[str, tuple[str, str]] = {}
    for preset in STT_PRESETS:
        env_file = tmp_path / f"{preset}.env"
        env_file.write_text("\n".join([*base, f"STT_PROVIDER={preset}"]) + "\n")
        settings = DotenvOnlySettings(_env_file=env_file)
        streams[preset] = (
            settings.stt_vendor.provider,
            SttStreamSettings.from_settings(settings).model,
        )

    assert streams == {preset: (row.vendor, row.model) for preset, row in STT_PRESETS.items()}
    # Two presets for one vendor and model would be one configuration under two names.
    assert len(set(streams.values())) == len(streams)


@pytest.mark.parametrize("value", ["whisper", "nova-3", "universal-3-6-pro", "AssemblyAI"])
def test_unknown_preset_is_refused_at_startup(value: str) -> None:
    with pytest.raises(ValidationError, match="stt_provider") as raised:
        make_settings(DATABASE_URL, stt_provider=value, **vendor_keys())

    for preset in STT_PRESETS:
        assert f"'{preset}'" in str(raised.value)


@pytest.mark.parametrize(
    ("preset", "model"),
    [
        # The likeliest leftover: the line that picked this preset's model before presets.
        *((preset, row.model) for preset, row in sorted(STT_PRESETS.items())),
        # A leftover that asks for another model than the preset's must not be quietly replaced.
        ("assemblyai", "universal-3-6-pro"),
        ("fake", "nova-3"),
    ],
)
def test_retired_stt_model_is_refused_by_name(preset: str, model: str) -> None:
    with pytest.raises(ValidationError, match="STT_MODEL is retired") as raised:
        make_settings(DATABASE_URL, stt_provider=preset, stt_model=model, **vendor_keys())

    # The message says what to set instead.
    for name in STT_PRESETS:
        assert name in str(raised.value)


@pytest.mark.parametrize("preset", presets_with_a_vendor())
def test_missing_key_for_the_chosen_vendor_is_refused(preset: SttPresetId) -> None:
    vendor = STT_PRESETS[preset].vendor
    others = {name: key for name, key in vendor_keys().items() if name != f"{vendor}_api_key"}

    with pytest.raises(
        ValidationError, match=f"{vendor.upper()}_API_KEY is required when STT_PROVIDER={preset}"
    ):
        make_settings(DATABASE_URL, stt_provider=preset, **others)


def desktop_stt_provider_ids() -> set[str]:
    """The ids in the desktop's `STT_VENDORS` map (apps/desktop/src/main/stt/registry.ts)."""
    source = DESKTOP_STT_REGISTRY.read_text()
    entries = re.search(r"export const STT_VENDORS\b(.*?)\n\);", source, re.DOTALL)
    assert entries, f"no STT_VENDORS map in {DESKTOP_STT_REGISTRY}"
    return set(re.findall(r"\[\s*'([^']+)',", entries.group(1)))


# API vendors the desktop cannot run yet: the one allowed split of "Add a speech-to-text vendor"
# (apps/desktop/README.md) lands a vendor's issuer and preset first and lists it here, since an
# exact match would turn every gate red in between; meanwhile STT_PROVIDER=<vendor> fails Start on
# the Mac (UnsupportedSttProviderError). The commit that adds the vendor to registry.ts deletes it
# here. Empty since M3-T15 added Soniox's adapter (M3-T14 had landed its issuer and preset).
AWAITING_A_DESKTOP_ADAPTER: frozenset[str] = frozenset()


def test_every_preset_names_a_registered_vendor() -> None:
    # config.py validates STT_PROVIDER against the Literal and reads the mapping: they must agree.
    assert set(get_args(SttPresetId.__value__)) == set(STT_PRESETS)
    # Both ways: STT_PROVIDER cannot select a vendor that no preset names (the Literal refuses it).
    assert {row.vendor for row in STT_PRESETS.values()} == set(STT_VENDORS)
    # The token's `provider` is the vendor, and the desktop picks its adapter by that id: an id
    # missing there fails Start on the Mac, not at the API's startup.
    desktop = desktop_stt_provider_ids()
    assert desktop <= set(STT_VENDORS)
    assert set(STT_VENDORS) - desktop <= AWAITING_A_DESKTOP_ADAPTER


def test_every_preset_model_has_a_list_price() -> None:
    # A preset whose model is missing from its vendor's price table is most likely a misspelt
    # model, and AssemblyAI quietly runs another model for a name it does not know.
    for preset, row in STT_PRESETS.items():
        assert STT_VENDORS[row.vendor].price_for(row.model) is not None, preset


@pytest.mark.parametrize("preset", sorted(STT_PRESETS))
def test_stream_encoding_is_linear16_for_every_preset(preset: str) -> None:
    # The app's own name for its audio; each desktop protocol translates it to the vendor's term.
    settings = make_settings(DATABASE_URL, stt_provider=preset, **vendor_keys())

    assert SttStreamSettings.from_settings(settings).encoding == "linear16"


def vendor_answer(request: httpx.Request) -> httpx.Response:
    """What each vendor's token endpoint answers, so the registry's real issuers run."""
    match request.url.host:
        case "streaming.assemblyai.com":
            return httpx.Response(200, json={"token": "aai-temp-token", "expires_in_seconds": 30})
        case "api.deepgram.com":
            return httpx.Response(200, json={"access_token": "eyJ.jwt", "expires_in": 30})
    raise AssertionError(f"unexpected token request to {request.url.host}")


async def token_response(database_url: str, preset: str) -> Any:
    """`POST /v1/stt/token` on an app whose settings differ from the base only in STT_PROVIDER."""
    settings = make_settings(database_url, stt_provider=preset, **vendor_keys())
    app = create_app(settings)
    factory = settings.stt_vendor.issuer

    async def issuer() -> AsyncIterator[SttTokenIssuer]:
        if factory is None:
            yield FakeSttTokenIssuer()
            return
        async with httpx.AsyncClient(transport=httpx.MockTransport(vendor_answer)) as http:
            yield factory(http, api_key=VENDOR_KEY, ttl_seconds=settings.stt_token_ttl_seconds)

    app.dependency_overrides[get_stt_token_issuer] = issuer
    async with (
        LifespanManager(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=BASE_URL, headers=AUTH_HEADERS
        ) as client,
    ):
        response = await client.post("/v1/stt/token")
    assert response.status_code == 200, response.text
    return response.json()


async def test_switching_stt_provider_changes_the_token_response(
    database_url: str, clean_database: None
) -> None:
    presets = ["assemblyai", "assemblyai-pro", "deepgram", "fake"]
    responses = {preset: await token_response(database_url, preset) for preset in presets}

    # `provider` stays the vendor: both AssemblyAI presets answer `assemblyai`.
    assert {
        preset: (body["provider"], body["stream"]["model"], body["stream"]["price_per_hour_usd"])
        for preset, body in responses.items()
    } == {
        "assemblyai": ("assemblyai", "universal-streaming-english", 0.15),
        "assemblyai-pro": ("assemblyai", "universal-3-6-pro", 0.45),
        "deepgram": ("deepgram", "nova-3", 0.462),
        "fake": ("fake", "fake", 0.0),
    }
    assert VENDOR_KEY not in str(responses)


@pytest.mark.parametrize(
    ("preset", "issuer_type"),
    [
        ("fake", FakeSttTokenIssuer),
        ("assemblyai", AssemblyAiSttTokenIssuer),
        # Looked up by the preset id instead of its vendor, this was a KeyError at startup.
        ("assemblyai-pro", AssemblyAiSttTokenIssuer),
        ("deepgram", DeepgramSttTokenIssuer),
    ],
)
async def test_issuer_opens_for_every_preset(preset: str, issuer_type: type[object]) -> None:
    settings = make_settings(DATABASE_URL, stt_provider=preset, **vendor_keys())

    async with open_stt_token_issuer(settings) as issuer:
        assert type(issuer) is issuer_type


class EventRecorder(logging.Handler):
    """Keeps the event dicts the app logs: configure_logging hands each one to stdlib logging."""

    def __init__(self) -> None:
        super().__init__()
        self.events: list[dict[str, Any]] = []

    def emit(self, record: logging.LogRecord) -> None:
        if isinstance(record.msg, dict):
            self.events.append(dict(record.msg))


@contextmanager
def recorded_events() -> Iterator[list[dict[str, Any]]]:
    """Events logged inside the block. Enter it after create_app(), which resets the handlers."""
    recorder = EventRecorder()
    root = logging.getLogger()
    root.addHandler(recorder)
    try:
        yield recorder.events
    finally:
        root.removeHandler(recorder)


def stt_fields(events: list[dict[str, Any]], event: str) -> dict[str, Any]:
    """The `stt_*` fields of the one `event` logged."""
    [found] = [logged for logged in events if logged.get("event") == event]
    return {name: value for name, value in found.items() if name.startswith("stt_")}


async def test_api_started_names_the_preset_and_the_token_ttl(
    database_url: str, clean_database: None
) -> None:
    settings = make_settings(
        database_url, stt_provider="assemblyai-pro", stt_token_ttl_seconds=45, **vendor_keys()
    )
    app = create_app(settings)

    with recorded_events() as events:
        async with LifespanManager(app):
            pass

    assert stt_fields(events, "api_started") == {
        "stt_preset": "assemblyai-pro",
        "stt_provider": "assemblyai",
        "stt_model": "universal-3-6-pro",
        "stt_price_per_hour_usd": 0.45,
        "stt_token_ttl_seconds": 45,
    }
    assert VENDOR_KEY not in str(events)


async def test_unknown_price_warning_names_the_preset_and_its_vendor(
    database_url: str, clean_database: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Every real preset has a list price (above), so the warning needs a patched one.
    unpriced = SttPreset(vendor="assemblyai", model="universal-3-5-pro")
    monkeypatch.setattr(
        config, "STT_PRESETS", MappingProxyType({**STT_PRESETS, "assemblyai-pro": unpriced})
    )
    app = create_app(make_settings(database_url, stt_provider="assemblyai-pro", **vendor_keys()))

    with recorded_events() as events:
        async with LifespanManager(app):
            pass

    assert stt_fields(events, "stt_price_unknown") == {
        "stt_preset": "assemblyai-pro",
        "stt_provider": "assemblyai",
        "stt_model": "universal-3-5-pro",
    }
