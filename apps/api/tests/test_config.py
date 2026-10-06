import re
from typing import get_args

import pytest
from pydantic import ValidationError

from roger_api.config import REPO_ROOT_ENV_FILE
from roger_api.domain import SttProvider
from roger_api.stt_vendors import STT_VENDORS
from tests.conftest import make_settings
from tests.helpers import TEST_TOKEN

DATABASE_URL = "postgresql+asyncpg://postgres@localhost:5432/roger"
ENV_EXAMPLE = REPO_ROOT_ENV_FILE.with_name(".env.example")


def test_api_token_must_be_at_least_16_characters() -> None:
    with pytest.raises(ValidationError, match="at least 16 characters") as raised:
        make_settings(DATABASE_URL, roger_api_token="too-short")

    assert "too-short" not in str(raised.value)


def example_api_token() -> str:
    match = re.search(r"^ROGER_API_TOKEN=(.*)$", ENV_EXAMPLE.read_text(), re.MULTILINE)
    assert match, f"ROGER_API_TOKEN is missing from {ENV_EXAMPLE}"
    return match.group(1)


@pytest.mark.parametrize(
    "token",
    [
        pytest.param(example_api_token(), id="env-example-value"),
        pytest.param("change-me-0123456789abcdef", id="other-change-me"),
        pytest.param("CHANGE-ME-TO-A-REAL-SECRET", id="upper-case"),
    ],
)
def test_api_token_must_not_be_the_env_example_placeholder(token: str) -> None:
    # The placeholder is public and long enough to pass the length check, so a `.env` copied
    # without editing would otherwise serve every transcript behind a token anyone can read.
    with pytest.raises(ValidationError, match=r"placeholder from \.env\.example") as raised:
        make_settings(DATABASE_URL, roger_api_token=token)

    assert token not in str(raised.value)


def test_api_token_is_required() -> None:
    with pytest.raises(ValidationError, match="roger_api_token"):
        make_settings(DATABASE_URL, roger_api_token=None)


@pytest.mark.parametrize(
    "url",
    [
        "postgres://u:p@db.example.com:5432/roger",
        "postgresql://u:p@db.example.com:5432/roger",
        "postgresql+asyncpg://u:p@db.example.com:5432/roger",
    ],
)
def test_database_url_uses_asyncpg(url: str) -> None:
    settings = make_settings(url)

    assert settings.database_url == "postgresql+asyncpg://u:p@db.example.com:5432/roger"


def test_non_postgres_database_url_is_rejected() -> None:
    with pytest.raises(ValidationError, match="PostgreSQL"):
        make_settings("sqlite+aiosqlite:///roger.db")


def test_mcp_allowed_hosts_accepts_a_comma_separated_string() -> None:
    settings = make_settings(
        DATABASE_URL, mcp_allowed_hosts=" roger.example.com, roger.example.com:* ,"
    )

    assert settings.mcp_allowed_hosts == ["roger.example.com", "roger.example.com:*"]


def test_defaults() -> None:
    settings = make_settings(DATABASE_URL)

    assert settings.stt_provider == "fake"
    assert settings.stt_token_ttl_seconds == 30
    assert (settings.stt_stream_model, settings.stt_language) == ("fake", "en")
    assert (settings.stt_sample_rate, settings.stt_encoding) == (16000, "linear16")
    assert settings.default_workspace_name == "Linkt"
    assert settings.mcp_allowed_hosts == []
    assert settings.roger_api_token.get_secret_value() == TEST_TOKEN


VENDOR_KEY = "vendor-secret-key-0123"


@pytest.mark.parametrize("blank", ["", " "])
def test_blank_stt_model_counts_as_unset(blank: str) -> None:
    # STT_MODEL is retired (tests/test_stt_providers.py), but `STT_MODEL=` left in a `.env`
    # arrives as an empty string and must not stop the API.
    settings = make_settings(
        DATABASE_URL,
        stt_provider="assemblyai-pro",
        stt_model=blank,
        assemblyai_api_key=VENDOR_KEY,
    )

    assert settings.stt_stream_model == "universal-3-6-pro"


@pytest.mark.parametrize("preset", ["assemblyai", "assemblyai-pro"])
def test_assemblyai_token_ttl_is_capped_at_the_vendor_limit(preset: str) -> None:
    # AssemblyAI's temporary token endpoint accepts expires_in_seconds from 1 to 600, whichever
    # of its models the preset streams.
    accepted = make_settings(
        DATABASE_URL,
        stt_provider=preset,
        assemblyai_api_key=VENDOR_KEY,
        stt_token_ttl_seconds=600,
    )
    assert accepted.stt_token_ttl_seconds == 600

    with pytest.raises(ValidationError, match=f"at most 600 when STT_PROVIDER={preset} "):
        make_settings(
            DATABASE_URL,
            stt_provider=preset,
            assemblyai_api_key=VENDOR_KEY,
            stt_token_ttl_seconds=601,
        )


def test_deepgram_token_ttl_keeps_its_wider_range() -> None:
    settings = make_settings(
        DATABASE_URL,
        stt_provider="deepgram",
        deepgram_api_key=VENDOR_KEY,
        stt_token_ttl_seconds=3600,
    )

    assert settings.stt_token_ttl_seconds == 3600


@pytest.mark.parametrize("provider", ["deepgram", "assemblyai", "assemblyai-pro"])
def test_vendor_key_is_not_echoed_in_validation_errors(provider: str) -> None:
    with pytest.raises(ValidationError) as raised:
        make_settings(
            DATABASE_URL,
            stt_provider=provider,
            deepgram_api_key=VENDOR_KEY,
            assemblyai_api_key=VENDOR_KEY,
            stt_token_ttl_seconds=0,
        )

    assert VENDOR_KEY not in str(raised.value)


def test_every_provider_has_a_registry_entry() -> None:
    # Adding a provider to the SttProvider type without a registry entry would fail only when
    # someone configured it.
    assert set(get_args(SttProvider.__value__)) == set(STT_VENDORS)
    for provider, vendor in STT_VENDORS.items():
        assert vendor.provider == provider


@pytest.mark.parametrize(
    ("preset", "price"),
    [
        ("fake", 0.0),
        ("assemblyai", 0.15),
        ("assemblyai-pro", 0.45),
        ("deepgram", 0.462),
    ],
)
def test_price_per_hour_comes_from_the_registry(preset: str, price: float) -> None:
    # A model with no list price is null, never a guess: tests/test_stt_token.py.
    settings = make_settings(
        DATABASE_URL,
        stt_provider=preset,
        deepgram_api_key=VENDOR_KEY,
        assemblyai_api_key=VENDOR_KEY,
    )

    assert settings.stt_price_per_hour_usd is None
    assert settings.stt_stream_price_per_hour_usd == price


def test_price_per_hour_can_be_overridden() -> None:
    settings = make_settings(
        DATABASE_URL,
        stt_provider="deepgram",
        deepgram_api_key=VENDOR_KEY,
        stt_price_per_hour_usd=0.348,
    )

    assert settings.stt_stream_price_per_hour_usd == 0.348


def test_price_per_hour_cannot_be_negative() -> None:
    with pytest.raises(ValidationError, match="stt_price_per_hour_usd"):
        make_settings(DATABASE_URL, stt_price_per_hour_usd=-0.01)


def test_blank_price_counts_as_unset() -> None:
    # `.env.example` ships `STT_PRICE_PER_HOUR_USD=`, which arrives as an empty string.
    settings = make_settings(DATABASE_URL, stt_price_per_hour_usd=" ")

    assert settings.stt_price_per_hour_usd is None
    assert settings.stt_stream_price_per_hour_usd == 0.0
