"""Calendar settings (M5-T1): the provider, the Google OAuth client, its consent-screen audience,
the refresh-token key and the fake provider's file. The fake provider needs nothing; Google needs
the client id, its secret and a key of at least 32 characters."""

import re
from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from roger_api.config import REPO_ROOT_ENV_FILE
from roger_api.config_calendar import CalendarSettings, GoogleOAuthAudience
from tests.conftest import make_settings

DATABASE_URL = "postgresql+asyncpg://postgres@localhost:5432/roger"
ENV_EXAMPLE = REPO_ROOT_ENV_FILE.with_name(".env.example")

CLIENT_ID = "1234567890-abc.apps.googleusercontent.com"
CLIENT_SECRET = "GOCSPX-client-secret-value"
TOKEN_KEY = "0123456789abcdef0123456789abcdef"  # 32 characters, the minimum

GOOGLE = {
    "calendar_provider": "google",
    "google_oauth_client_id": CLIENT_ID,
    "google_oauth_client_secret": CLIENT_SECRET,
    "calendar_token_key": TOKEN_KEY,
}


def test_defaults_are_no_provider_and_an_external_testing_audience() -> None:
    settings = make_settings(DATABASE_URL)

    # No default provider: the fake used to be one and showed a made-up account on a real Mac.
    assert settings.calendar_provider is None
    assert settings.google_oauth_audience == "external_testing"
    assert settings.google_oauth_client_id is None
    assert settings.google_oauth_client_secret is None
    assert settings.calendar_token_key is None
    assert settings.fake_calendar_file is None


def test_google_provider_with_the_client_and_a_key_is_accepted() -> None:
    settings = make_settings(DATABASE_URL, **GOOGLE)

    assert settings.calendar_provider == "google"
    assert settings.google_oauth_client_id == CLIENT_ID
    assert settings.google_oauth_client_secret is not None
    assert settings.google_oauth_client_secret.get_secret_value() == CLIENT_SECRET
    assert settings.calendar_token_key is not None
    assert settings.calendar_token_key.get_secret_value() == TOKEN_KEY


@pytest.mark.parametrize(
    ("missing", "variable"),
    [
        ("google_oauth_client_id", "GOOGLE_OAUTH_CLIENT_ID"),
        ("google_oauth_client_secret", "GOOGLE_OAUTH_CLIENT_SECRET"),
        ("calendar_token_key", "CALENDAR_TOKEN_KEY"),
    ],
)
def test_google_provider_needs_the_client_id_its_secret_and_a_key(
    missing: str, variable: str
) -> None:
    values = {**GOOGLE, missing: None}

    with pytest.raises(
        ValidationError, match=f"{variable} is required when CALENDAR_PROVIDER=google"
    ):
        make_settings(DATABASE_URL, **values)


def test_google_provider_names_every_missing_setting_at_once() -> None:
    with pytest.raises(ValidationError) as raised:
        make_settings(DATABASE_URL, calendar_provider="google")

    message = str(raised.value)
    assert (
        "GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, CALENDAR_TOKEN_KEY are required "
        "when CALENDAR_PROVIDER=google"
    ) in message


@pytest.mark.parametrize(
    "variable", ["google_oauth_client_id", "google_oauth_client_secret", "calendar_token_key"]
)
def test_blank_values_count_as_unset(variable: str) -> None:
    # `.env.example` ships `GOOGLE_OAUTH_CLIENT_ID=` and the rest empty; they arrive as "". A blank
    # must read as "not set" (and so as missing for Google), never as a value, and never trip the
    # key's length check with a confusing message.
    fake = make_settings(DATABASE_URL, **{variable: "  "})
    assert getattr(fake, variable) is None

    with pytest.raises(ValidationError, match="is required when CALENDAR_PROVIDER=google"):
        make_settings(DATABASE_URL, **{**GOOGLE, variable: ""})


def test_token_key_must_be_at_least_32_characters() -> None:
    short_key = TOKEN_KEY[:-1]

    with pytest.raises(ValidationError, match="at least 32 characters") as raised:
        make_settings(DATABASE_URL, **{**GOOGLE, "calendar_token_key": short_key})

    assert short_key not in str(raised.value)


def test_a_short_token_key_is_refused_with_the_fake_provider_too() -> None:
    # A key that is set is meant to be used: refusing it at startup beats finding out on the day
    # CALENDAR_PROVIDER switches to google.
    with pytest.raises(ValidationError, match="at least 32 characters"):
        make_settings(DATABASE_URL, calendar_token_key="too-short-for-a-key")


def test_secrets_are_not_echoed_in_validation_errors() -> None:
    with pytest.raises(ValidationError) as raised:
        make_settings(
            DATABASE_URL,
            calendar_provider="google",
            google_oauth_client_secret=CLIENT_SECRET,
            calendar_token_key="short-secret-key",
            google_oauth_audience="not-an-audience",
        )

    message = str(raised.value)
    assert CLIENT_SECRET not in message
    assert "short-secret-key" not in message


@pytest.mark.parametrize("audience", ["external_testing", "external_production", "internal"])
def test_audience_is_one_of_three_values(audience: str) -> None:
    settings = make_settings(DATABASE_URL, **GOOGLE, google_oauth_audience=audience)

    assert settings.google_oauth_audience == audience


def test_the_audience_type_lists_exactly_the_three_values() -> None:
    assert set(get_args(GoogleOAuthAudience.__value__)) == {
        "external_testing",
        "external_production",
        "internal",
    }


@pytest.mark.parametrize("audience", ["external", "testing", "production", ""])
def test_unknown_audience_is_refused(audience: str) -> None:
    with pytest.raises(ValidationError, match="google_oauth_audience"):
        make_settings(DATABASE_URL, google_oauth_audience=audience)


def test_unknown_calendar_provider_is_refused() -> None:
    with pytest.raises(ValidationError, match="calendar_provider"):
        make_settings(DATABASE_URL, calendar_provider="outlook")


def test_fake_calendar_file_is_a_path_and_blank_means_the_built_in_events() -> None:
    assert make_settings(DATABASE_URL, fake_calendar_file="").fake_calendar_file is None
    settings = make_settings(DATABASE_URL, fake_calendar_file="calendar/events.json")

    assert settings.fake_calendar_file == Path("calendar/events.json")


def _env_example_calendar_values() -> dict[str, str]:
    text = ENV_EXAMPLE.read_text()
    values: dict[str, str] = {}
    for name in CalendarSettings.model_fields:
        match = re.search(rf"^{name.upper()}=(.*)$", text, re.MULTILINE)
        assert match, f"{name.upper()} is missing from {ENV_EXAMPLE}"
        values[name] = match.group(1)
    return values


def test_env_example_documents_every_calendar_setting_and_loads_as_the_defaults() -> None:
    # House rule: `.env.example` documents every variable. Its values, read the way a copied
    # `.env` would hand them over, must start the API with the fake provider.
    from_example = make_settings(DATABASE_URL, **_env_example_calendar_values())
    defaults = make_settings(DATABASE_URL)

    for name in CalendarSettings.model_fields:
        assert getattr(from_example, name) == getattr(defaults, name), name


def test_a_blank_calendar_provider_is_no_provider_and_fake_stays_readable() -> None:
    # `.env.example` ships `CALENDAR_PROVIDER=` empty; an old `.env` that says fake still works.
    assert make_settings(DATABASE_URL, calendar_provider="").calendar_provider is None
    assert make_settings(DATABASE_URL, calendar_provider="fake").calendar_provider == "fake"
