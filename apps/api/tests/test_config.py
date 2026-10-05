import re

import pytest
from pydantic import ValidationError

from roger_api.config import REPO_ROOT_ENV_FILE
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
    assert (settings.stt_model, settings.stt_language) == ("nova-3", "en")
    assert (settings.stt_sample_rate, settings.stt_encoding) == (16000, "linear16")
    assert settings.default_workspace_name == "Linkt"
    assert settings.mcp_allowed_hosts == []
    assert settings.roger_api_token.get_secret_value() == TEST_TOKEN
