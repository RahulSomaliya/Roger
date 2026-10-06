"""Short-lived speech-to-text credentials for the desktop app. Vendor keys stay on the API."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import httpx
from pydantic import BaseModel, ValidationError

from roger_api.config import Settings, SttProvider
from roger_api.errors import SttProviderError
from roger_api.log import get_logger

logger = get_logger(__name__)

DEEPGRAM_GRANT_URL = "https://api.deepgram.com/v1/auth/grant"
VENDOR_TIMEOUT = httpx.Timeout(10.0)


@dataclass(frozen=True, slots=True)
class SttCredential:
    provider: SttProvider
    access_token: str
    expires_in: int


@runtime_checkable
class SttTokenIssuer(Protocol):
    async def issue(self) -> SttCredential: ...


class FakeSttTokenIssuer:
    """For development without a vendor key: the desktop uses its built-in fake adapter."""

    async def issue(self) -> SttCredential:
        return SttCredential(provider="fake", access_token="", expires_in=0)


class _DeepgramGrant(BaseModel):
    access_token: str
    expires_in: int


class DeepgramSttTokenIssuer:
    def __init__(self, http: httpx.AsyncClient, *, api_key: str, ttl_seconds: int) -> None:
        self._http = http
        self._api_key = api_key
        self._ttl_seconds = ttl_seconds

    async def issue(self) -> SttCredential:
        try:
            response = await self._http.post(
                DEEPGRAM_GRANT_URL,
                headers={"Authorization": f"Token {self._api_key}"},
                json={"ttl_seconds": self._ttl_seconds},
            )
        except httpx.HTTPError as exc:
            logger.warning("deepgram_grant_unreachable", error=repr(exc))
            raise SttProviderError("Speech-to-text provider is unreachable") from exc

        if response.is_error:
            logger.warning(
                "deepgram_grant_rejected", status=response.status_code, body=response.text[:500]
            )
            raise SttProviderError(
                f"Speech-to-text provider refused the token request (HTTP {response.status_code})"
            )

        try:
            grant = _DeepgramGrant.model_validate_json(response.content)
        except ValidationError as exc:
            logger.warning("deepgram_grant_unreadable", error=str(exc))
            raise SttProviderError("Speech-to-text provider sent an unreadable token") from exc
        return SttCredential(
            provider="deepgram", access_token=grant.access_token, expires_in=grant.expires_in
        )


@asynccontextmanager
async def open_stt_token_issuer(settings: Settings) -> AsyncIterator[SttTokenIssuer]:
    """The issuer for `STT_PROVIDER`, holding any HTTP client it needs for the app's lifetime."""
    if settings.stt_provider == "fake":
        yield FakeSttTokenIssuer()
        return
    if settings.deepgram_api_key is None:  # Settings validation already guarantees this.
        raise RuntimeError("DEEPGRAM_API_KEY is required when STT_PROVIDER=deepgram")
    async with httpx.AsyncClient(timeout=VENDOR_TIMEOUT) as http:
        yield DeepgramSttTokenIssuer(
            http,
            api_key=settings.deepgram_api_key.get_secret_value(),
            ttl_seconds=settings.stt_token_ttl_seconds,
        )
