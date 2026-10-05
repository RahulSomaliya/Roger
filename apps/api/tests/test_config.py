import pytest
from pydantic import ValidationError

from tests.conftest import make_settings
from tests.helpers import TEST_TOKEN

DATABASE_URL = "postgresql+asyncpg://postgres@localhost:5432/roger"


def test_api_token_must_be_at_least_16_characters() -> None:
    with pytest.raises(ValidationError, match="at least 16 characters") as raised:
        make_settings(DATABASE_URL, roger_api_token="too-short")

    assert "too-short" not in str(raised.value)


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
