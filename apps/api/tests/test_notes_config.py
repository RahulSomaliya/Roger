"""The notes model settings (`config_notes.py`), as `Settings` reads them."""

import re

import pytest
from pydantic import ValidationError

from roger_api.config import REPO_ROOT_ENV_FILE
from roger_api.config_notes import DEFAULT_NOTES_MODEL, NotesSettings
from tests.conftest import make_settings

DATABASE_URL = "postgresql+asyncpg://postgres@localhost:5432/roger"
ENV_EXAMPLE = REPO_ROOT_ENV_FILE.with_name(".env.example")
OPENROUTER_KEY = "sk-or-v1-secret-key"


def test_fake_is_the_default_provider() -> None:
    settings = make_settings(DATABASE_URL)

    assert settings.notes_provider == "fake"
    assert settings.openrouter_api_key is None


def test_the_default_model_writes_notes_and_answers_chat() -> None:
    settings = make_settings(DATABASE_URL)

    # The owner's choice on 2026-10-06 (M4 plan, D2).
    assert DEFAULT_NOTES_MODEL == "xiaomi/mimo-v2.6-pro"
    assert settings.notes_model == DEFAULT_NOTES_MODEL
    assert settings.chat_model == DEFAULT_NOTES_MODEL


def test_reasoning_defaults_to_off() -> None:
    settings = make_settings(DATABASE_URL)

    assert settings.notes_reasoning == "off"


def test_budget_defaults() -> None:
    settings = make_settings(DATABASE_URL)

    assert settings.notes_max_input_tokens == 200_000
    assert settings.notes_max_output_tokens == 8_192
    assert settings.notes_reasoning_tokens == 4_096
    assert settings.notes_timeout_seconds == 120


@pytest.mark.parametrize("key", [None, "", "   "])
def test_openrouter_provider_requires_a_key(key: str | None) -> None:
    with pytest.raises(ValidationError, match="OPENROUTER_API_KEY is required"):
        make_settings(DATABASE_URL, notes_provider="openrouter", openrouter_api_key=key)


def test_openrouter_provider_with_a_key() -> None:
    settings = make_settings(
        DATABASE_URL, notes_provider="openrouter", openrouter_api_key=OPENROUTER_KEY
    )

    assert settings.notes_provider == "openrouter"
    assert settings.openrouter_api_key is not None
    assert settings.openrouter_api_key.get_secret_value() == OPENROUTER_KEY
    assert OPENROUTER_KEY not in repr(settings)


def test_unknown_provider_is_refused() -> None:
    with pytest.raises(ValidationError, match="notes_provider"):
        make_settings(DATABASE_URL, notes_provider="litellm")


@pytest.mark.parametrize("field", ["notes_model", "chat_model"])
@pytest.mark.parametrize("value", ["", "  "])
def test_a_blank_model_means_the_default(field: str, value: str) -> None:
    # `NOTES_MODEL=` in a `.env` arrives as an empty string.
    settings = make_settings(DATABASE_URL, **{field: value})

    assert getattr(settings, field) == DEFAULT_NOTES_MODEL


def test_a_model_can_be_chosen_per_purpose() -> None:
    settings = make_settings(
        DATABASE_URL, notes_model=" anthropic/claude-sonnet-5.5 ", chat_model="openai/gpt-6"
    )

    assert settings.notes_model == "anthropic/claude-sonnet-5.5"
    assert settings.chat_model == "openai/gpt-6"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("notes_reasoning", "auto"),
        ("notes_reasoning_tokens", 0),
        ("notes_max_input_tokens", 0),
        ("notes_max_output_tokens", 0),
        ("notes_timeout_seconds", 0),
        ("notes_timeout_seconds", 601),
    ],
)
def test_out_of_range_values_are_refused(field: str, value: object) -> None:
    with pytest.raises(ValidationError, match=field):
        make_settings(DATABASE_URL, **{field: value})


def _env_example_notes_section() -> dict[str, str]:
    text = ENV_EXAMPLE.read_text()
    section = text.split("# Notes and AI", 1)[1].split("\n# Calendar", 1)[0]
    return dict(re.findall(r"^([A-Z_]+)=(.*)$", section, re.MULTILINE))


def test_env_example_lists_every_notes_setting() -> None:
    names = {name.upper() for name in NotesSettings.model_fields}

    assert set(_env_example_notes_section()) == names


def test_env_example_notes_section_reads_as_the_defaults() -> None:
    # A `.env` copied from the example runs the fake model with the defaults, and never pins a
    # model id: an empty NOTES_MODEL follows the default when it changes.
    values = {name.lower(): value for name, value in _env_example_notes_section().items()}

    assert make_settings(DATABASE_URL, **values) == make_settings(DATABASE_URL)
