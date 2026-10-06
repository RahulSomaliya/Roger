from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from sqlalchemy.engine import make_url

from roger_api import __version__
from roger_api.domain import SttProvider

# The vendor registry imports the token issuers, which log through roger_api.log. That module
# (and stt_vendors.py, and services/stt_tokens.py) must import Settings only under TYPE_CHECKING:
# a runtime import back into this module is a cycle that fails at startup.
from roger_api.stt_vendors import STT_VENDORS, SttVendor

# The monorepo keeps one `.env` at its root (see `.env.example`). Missing files are ignored, so
# deployments that pass real environment variables are unaffected.
REPO_ROOT_ENV_FILE = Path(__file__).resolve().parents[4] / ".env"

# The single workspace every M1 request resolves to. Fixed so that every install agrees on it.
DEFAULT_WORKSPACE_ID = UUID("805dd994-ff52-405c-a3cc-58f09b32a2dd")
MIN_API_TOKEN_LENGTH = 16
# `.env.example` ships `ROGER_API_TOKEN=change-me-to-a-real-secret`. That value is public and long
# enough to pass the length check, so a `.env` copied without editing would serve every transcript
# behind a token anyone can read. Keep the example value starting with this prefix.
ENV_EXAMPLE_PLACEHOLDER_PREFIX = "change-me"


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
    assemblyai_api_key: SecretStr | None = None
    stt_token_ttl_seconds: int = Field(default=30, ge=1, le=3600)
    # None means the provider's default (stt_vendors.py); read `stt_stream_model`, not this.
    stt_model: str | None = None
    # None means the registry's list price for the provider and model; read
    # `stt_stream_price_per_hour_usd`, not this.
    stt_price_per_hour_usd: float | None = Field(default=None, ge=0)
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
    def _token_is_a_real_secret(cls, value: SecretStr) -> SecretStr:
        token = value.get_secret_value()
        if len(token) < MIN_API_TOKEN_LENGTH:
            raise ValueError(
                f"must be at least {MIN_API_TOKEN_LENGTH} characters (try: openssl rand -hex 32)"
            )
        if token.lower().startswith(ENV_EXAMPLE_PLACEHOLDER_PREFIX):
            raise ValueError(
                "is still the placeholder from .env.example; set a real secret "
                "(try: openssl rand -hex 32)"
            )
        return value

    @field_validator("stt_model", "stt_price_per_hour_usd", mode="before")
    @classmethod
    def _blank_is_unset(cls, value: object) -> object:
        """`STT_MODEL=` or `STT_PRICE_PER_HOUR_USD=` in a `.env` arrives as an empty string."""
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("mcp_allowed_hosts", mode="before")
    @classmethod
    def _split_hosts(cls, value: object) -> object:
        if isinstance(value, str):
            return [host.strip() for host in value.split(",") if host.strip()]
        return value

    @model_validator(mode="after")
    def _vendor_settings_fit(self) -> Self:
        provider = self.stt_provider
        if provider == "fake":
            return self
        key = self.stt_vendor_key
        if not (key and key.get_secret_value()):
            raise ValueError(f"{provider.upper()}_API_KEY is required when STT_PROVIDER={provider}")
        vendor = self.stt_vendor
        if self.stt_token_ttl_seconds > vendor.max_token_ttl_seconds:
            raise ValueError(
                f"STT_TOKEN_TTL_SECONDS must be at most {vendor.max_token_ttl_seconds} when "
                f"STT_PROVIDER={provider} (the vendor's limit for a temporary token)"
            )
        for owner in STT_VENDORS.values():
            prefix = owner.model_prefix
            if (
                owner.provider != provider
                and prefix is not None
                and self.stt_model
                and self.stt_model.startswith(prefix)
            ):
                raise ValueError(
                    f"STT_MODEL={self.stt_model} is a {owner.provider} model; remove STT_MODEL to "
                    f"use {vendor.default_model} with STT_PROVIDER={provider}"
                )
        return self

    @property
    def stt_vendor(self) -> SttVendor:
        """The registry entry of `stt_provider`."""
        return STT_VENDORS[self.stt_provider]

    @property
    def stt_vendor_key(self) -> SecretStr | None:
        """The API key of the `stt_provider` vendor. None for the fake provider."""
        match self.stt_provider:
            case "deepgram":
                return self.deepgram_api_key
            case "assemblyai":
                return self.assemblyai_api_key
            case "fake":
                return None

    @property
    def stt_stream_model(self) -> str:
        """The model the desktop asks the vendor for: STT_MODEL, else the provider's default."""
        return self.stt_model or self.stt_vendor.default_model

    @property
    def stt_stream_price_per_hour_usd(self) -> float | None:
        """USD per hour of one stream: STT_PRICE_PER_HOUR_USD, else the list price, else None."""
        if self.stt_price_per_hour_usd is not None:
            return self.stt_price_per_hour_usd
        return self.stt_vendor.price_for(self.stt_stream_model)

    @property
    def app_version(self) -> str:
        return __version__

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
