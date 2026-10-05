from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from sqlalchemy.engine import make_url

from roger_api import __version__

# The monorepo keeps one `.env` at its root (see `.env.example`). Missing files are ignored, so
# deployments that pass real environment variables are unaffected.
REPO_ROOT_ENV_FILE = Path(__file__).resolve().parents[4] / ".env"

# The single workspace every M1 request resolves to. Fixed so that every install agrees on it.
DEFAULT_WORKSPACE_ID = UUID("805dd994-ff52-405c-a3cc-58f09b32a2dd")
MIN_API_TOKEN_LENGTH = 16

type SttProvider = Literal["fake", "deepgram"]


class DatabaseSettings(BaseSettings):
    """The subset of settings Alembic needs, so migrations run without the API secrets."""

    model_config = SettingsConfigDict(
        env_file=REPO_ROOT_ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        # Never echo a rejected secret (API token, database password) into logs.
        hide_input_in_errors=True,
    )

    database_url: str

    @field_validator("database_url")
    @classmethod
    def _use_asyncpg_driver(cls, value: str) -> str:
        """Accept plain `postgres://` / `postgresql://` URLs, as hosting providers hand them out."""
        url = make_url(value)
        if url.drivername in {"postgres", "postgresql"}:
            url = url.set(drivername="postgresql+asyncpg")
        if url.drivername != "postgresql+asyncpg":
            raise ValueError("must be a PostgreSQL URL (postgresql+asyncpg://...)")
        return url.render_as_string(hide_password=False)


class Settings(DatabaseSettings):
    roger_api_token: SecretStr
    stt_provider: SttProvider = "fake"
    deepgram_api_key: SecretStr | None = None
    stt_token_ttl_seconds: int = Field(default=30, ge=1, le=3600)
    stt_model: str = "nova-3"
    stt_language: str = "en"
    stt_sample_rate: int = Field(default=16000, gt=0)
    stt_encoding: str = "linear16"
    default_workspace_id: UUID = DEFAULT_WORKSPACE_ID
    default_workspace_name: str = "Linkt"
    app_env: Literal["development", "production"] = "development"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    # Extra Host header values the MCP endpoint accepts (comma-separated in the environment).
    # Empty keeps the SDK default: localhost only.
    mcp_allowed_hosts: Annotated[list[str], NoDecode] = Field(default_factory=list)

    @field_validator("roger_api_token")
    @classmethod
    def _token_is_long_enough(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value()) < MIN_API_TOKEN_LENGTH:
            raise ValueError(
                f"must be at least {MIN_API_TOKEN_LENGTH} characters (try: openssl rand -hex 32)"
            )
        return value

    @field_validator("mcp_allowed_hosts", mode="before")
    @classmethod
    def _split_hosts(cls, value: object) -> object:
        if isinstance(value, str):
            return [host.strip() for host in value.split(",") if host.strip()]
        return value

    @model_validator(mode="after")
    def _vendor_key_present(self) -> Self:
        if self.stt_provider == "deepgram" and not (
            self.deepgram_api_key and self.deepgram_api_key.get_secret_value()
        ):
            raise ValueError("DEEPGRAM_API_KEY is required when STT_PROVIDER=deepgram")
        return self

    @property
    def app_version(self) -> str:
        return __version__

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
