"""Short-lived speech-to-text credentials for the desktop app. Vendor keys stay on the API.

One `SttTokenIssuer` per vendor; the registry (roger_api/stt_vendors.py) picks one by provider.
This module must not import roger_api.config: config imports the registry, which imports this.

AssemblyAI temporary tokens, per https://www.assemblyai.com/docs/streaming/api-spec/generate-streaming-token
and https://www.assemblyai.com/docs/streaming/authenticate-with-a-temporary-token (read 2026-10-06):
`GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=N` with the raw key as
`Authorization` (no prefix), answering `{"token", "expires_in_seconds"}`. `expires_in_seconds`
(1..600) is only the window to open a websocket; one token may open several sessions, which is how
the desktop opens its mic and system streams with one. Sessions last up to 3 hours
(`max_session_duration_seconds`, left at the vendor's default and maximum of 10800).
"""

from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import httpx
from pydantic import BaseModel, Field, ValidationError

from roger_api.domain import SttProvider
from roger_api.errors import SttProviderError
from roger_api.log import get_logger

logger = get_logger(__name__)

DEEPGRAM_GRANT_URL = "https://api.deepgram.com/v1/auth/grant"
ASSEMBLYAI_GRANT_URL = "https://streaming.assemblyai.com/v3/token"
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


async def _request_vendor_token[M: BaseModel](
    provider: SttProvider, request: Awaitable[httpx.Response], schema: type[M]
) -> M:
    """Awaits a vendor token request; every failure becomes SttProviderError (HTTP 502).

    Logs name the provider, the status and the vendor's error body. Never log the request: its
    headers carry the master key.
    """
    try:
        response = await request
    except httpx.HTTPError as exc:
        logger.warning("stt_token_unreachable", provider=provider, error=repr(exc))
        raise SttProviderError("Speech-to-text provider is unreachable") from exc

    if response.is_error:
        logger.warning(
            "stt_token_rejected",
            provider=provider,
            status=response.status_code,
            body=response.text[:500],
        )
        raise SttProviderError(
            f"Speech-to-text provider refused the token request (HTTP {response.status_code})"
        )

    try:
        return schema.model_validate_json(response.content)
    except ValidationError as exc:
        # `str(exc)` would quote the input, and a success body holds the token.
        logger.warning(
            "stt_token_unreadable",
            provider=provider,
            errors=exc.errors(include_url=False, include_input=False),
        )
        raise SttProviderError("Speech-to-text provider sent an unreadable token") from exc


class _DeepgramGrant(BaseModel):
    access_token: str
    expires_in: int


class DeepgramSttTokenIssuer:
    def __init__(self, http: httpx.AsyncClient, *, api_key: str, ttl_seconds: int) -> None:
        self._http = http
        self._api_key = api_key
        self._ttl_seconds = ttl_seconds

    async def issue(self) -> SttCredential:
        grant = await _request_vendor_token(
            "deepgram",
            self._http.post(
                DEEPGRAM_GRANT_URL,
                headers={"Authorization": f"Token {self._api_key}"},
                json={"ttl_seconds": self._ttl_seconds},
            ),
            _DeepgramGrant,
        )
        return SttCredential(
            provider="deepgram", access_token=grant.access_token, expires_in=grant.expires_in
        )


class _AssemblyAiToken(BaseModel):
    token: str = Field(min_length=1)
    expires_in_seconds: int | None = None


class AssemblyAiSttTokenIssuer:
    """Mints an AssemblyAI temporary streaming token (see the module docstring)."""

    def __init__(self, http: httpx.AsyncClient, *, api_key: str, ttl_seconds: int) -> None:
        self._http = http
        self._api_key = api_key
        self._ttl_seconds = ttl_seconds

    async def issue(self) -> SttCredential:
        token = await _request_vendor_token(
            "assemblyai",
            self._http.get(
                ASSEMBLYAI_GRANT_URL,
                headers={"Authorization": self._api_key},
                params={"expires_in_seconds": self._ttl_seconds},
            ),
            _AssemblyAiToken,
        )
        return SttCredential(
            provider="assemblyai",
            access_token=token.token,
            expires_in=token.expires_in_seconds or self._ttl_seconds,
        )
