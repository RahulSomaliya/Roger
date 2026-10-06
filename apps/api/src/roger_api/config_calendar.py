"""Calendar settings (M5-T1).

`config.Settings` inherits `CalendarSettings`, so a field declared here is read from the
environment and the repo-root `.env` like any other setting, and a validator here runs on
`Settings`. Three rules (tests/test_settings_layout.py checks the first two):
- No `model_config`: `Settings` takes its config from `DatabaseSettings`, and a mixin's own would
  be merged into it.
- Import neither `roger_api.config` nor `roger_api.stt_vendors`: config.py imports this module, so
  either import is a cycle that fails at startup.
- Give every validator a name no other mixin and no `Settings` validator uses. Pydantic keeps one
  validator per name across the class tree, so a `_blank_is_unset` here would be replaced, without
  a word, by the one `Settings` declares for the STT fields, and these fields would stop being
  checked (tests/test_calendar_config.py fails if a calendar validator stops running).
"""

from pathlib import Path
from typing import Literal, Self

from pydantic import BaseModel, SecretStr, field_validator, model_validator

# Which calendar backend the API talks to. `calendar_connections.provider` holds the same values and
# its check constraint (migration 0004, db/models_calendar.py) lists them: change them together.
type CalendarProviderName = Literal["fake", "google"]
# The Google consent screen's audience and publishing status (docs/plans/M5-calendar.md, D2).
# `external_testing` is External in Testing: at most 100 test users, and Google expires its refresh
# tokens after 7 days, so the API reports `expires_hint` for it alone. `external_production` is
# External once Google has verified the app; `internal` is a Workspace-only project.
type GoogleOAuthAudience = Literal["external_testing", "external_production", "internal"]

# pgp_sym_encrypt derives its key from this passphrase, so the tokens are only as safe as it is.
# 32 characters rules out a word someone typed; `openssl rand -hex 32` gives 64.
MIN_CALENDAR_TOKEN_KEY_LENGTH = 32

_GOOGLE_REQUIRED = (
    ("google_oauth_client_id", "GOOGLE_OAUTH_CLIENT_ID"),
    ("google_oauth_client_secret", "GOOGLE_OAUTH_CLIENT_SECRET"),
    ("calendar_token_key", "CALENDAR_TOKEN_KEY"),
)


class CalendarSettings(BaseModel):
    """The calendar provider, the Google OAuth client, its audience and the token encryption key."""

    calendar_provider: CalendarProviderName = "fake"
    # The Google Cloud "Desktop app" OAuth client. The id is public (it is in every authorization
    # URL); Google still wants the secret at its token endpoint, so it stays on the API.
    google_oauth_client_id: str | None = None
    google_oauth_client_secret: SecretStr | None = None
    google_oauth_audience: GoogleOAuthAudience = "external_testing"
    # Encrypts the stored refresh tokens with pgcrypto (calendar_connections.refresh_token). Losing
    # or changing it means every account connects again.
    calendar_token_key: SecretStr | None = None
    # A JSON file of events for the fake provider; None means its built-in events.
    fake_calendar_file: Path | None = None

    @field_validator(
        "google_oauth_client_id",
        "google_oauth_client_secret",
        "calendar_token_key",
        "fake_calendar_file",
        mode="before",
    )
    @classmethod
    def _blank_calendar_setting_is_unset(cls, value: object) -> object:
        """`GOOGLE_OAUTH_CLIENT_ID=` and the rest of `.env.example` arrive as empty strings."""
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("calendar_token_key")
    @classmethod
    def _calendar_token_key_is_long_enough(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value()) < MIN_CALENDAR_TOKEN_KEY_LENGTH:
            raise ValueError(
                f"must be at least {MIN_CALENDAR_TOKEN_KEY_LENGTH} characters "
                "(try: openssl rand -hex 32)"
            )
        return value

    @model_validator(mode="after")
    def _google_calendar_settings_fit(self) -> Self:
        if self.calendar_provider != "google":
            return self
        missing = [variable for field, variable in _GOOGLE_REQUIRED if getattr(self, field) is None]
        if missing:
            verb = "is" if len(missing) == 1 else "are"
            raise ValueError(
                f"{', '.join(missing)} {verb} required when CALENDAR_PROVIDER=google "
                "(docs/plans/M5-calendar.md, Owner setup: Google Cloud)"
            )
        return self
