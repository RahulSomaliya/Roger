"""Short-lived speech-to-text credentials for the desktop app. Vendor keys stay on the API.

One `SttTokenIssuer` per vendor; the registry (roger_api/stt_vendors.py) picks one by provider.
This module must not import roger_api.config: config imports the registry, which imports this.

AssemblyAI temporary tokens, per https://www.assemblyai.com/docs/streaming/api-spec/generate-streaming-token
and https://www.assemblyai.com/docs/streaming/authenticate-with-a-temporary-token (read 2026-10-06):
`GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=N` with the raw key as
`Authorization` (no prefix), answering `{"token", "expires_in_seconds"}`. `expires_in_seconds`
(1..600) is only the window to open a websocket; one token may open several sessions, which is how
the desktop opens its mic and system streams with one. `max_session_duration_seconds` (60..10800,
default 10800) caps every session the token opens; it is a token parameter, not a websocket one.

Soniox temporary API keys, per https://soniox.com/docs/api-reference/auth/create_temporary_api_key
and https://soniox.com/docs/guides/temporary-api-keys (read 2026-10-07):
`POST https://api.soniox.com/v1/auth/temporary-api-key` with `Authorization: Bearer <key>` and a
JSON body `{"usage_type": "transcribe_websocket", "expires_in_seconds": 1..3600}`, answering
`201 {"api_key", "expires_at"}`. Like AssemblyAI's token, `expires_in_seconds` is only the window to
open a stream ("It does not terminate streams that are already open"), and a key opens any number
of streams unless `single_use` is true. `max_session_duration_seconds` (1..18000) caps every stream
the key opens; without it "no limit is applied" beyond the WebSocket API's 300 minutes of audio.
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
# Sent explicitly so a change of the vendor's default can never lengthen a session silently. Each
# open session bills ($0.15 an hour per stream); this cap is the last net for one that nothing
# else closed: at 3 hours it costs $0.45. The vendor then closes with 3008 after the current turn,
# and the desktop opens a fresh session if it is still recording (its reopen budget allows it). The
# desktop's own guards (stall close, idle timeout, 4-hour auto-stop) are in
# apps/desktop/src/main/costGuards.ts.
ASSEMBLYAI_MAX_SESSION_SECONDS = 10_800
SONIOX_GRANT_URL = "https://api.soniox.com/v1/auth/temporary-api-key"
# The same rule as AssemblyAI's cap above: the vendor's maximum (300 minutes), asked for on every
# key, because Soniox applies no limit when the field is missing and a vendor default must never
# decide how long a billed stream may run. It sits above the desktop's 4-hour recording cap, so it
# only ends a stream nothing else closed. At it Soniox sends a final `temp_api_key_session_expired`
# error (403) and closes the websocket normally.
SONIOX_MAX_SESSION_SECONDS = 18_000
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
                params={
                    "expires_in_seconds": self._ttl_seconds,
                    "max_session_duration_seconds": ASSEMBLYAI_MAX_SESSION_SECONDS,
                },
            ),
            _AssemblyAiToken,
        )
        return SttCredential(
            provider="assemblyai",
            access_token=token.token,
            expires_in=token.expires_in_seconds or self._ttl_seconds,
        )


class _SonioxTemporaryKey(BaseModel):
    # Soniox also answers `expires_at`, an instant on its own clock, which is not read: see issue().
    api_key: str = Field(min_length=1)


class SonioxSttTokenIssuer:
    """Mints a Soniox temporary API key for the realtime websocket (see the module docstring)."""

    def __init__(self, http: httpx.AsyncClient, *, api_key: str, ttl_seconds: int) -> None:
        self._http = http
        self._api_key = api_key
        self._ttl_seconds = ttl_seconds

    async def issue(self) -> SttCredential:
        key = await _request_vendor_token(
            "soniox",
            self._http.post(
                SONIOX_GRANT_URL,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json={
                    "usage_type": "transcribe_websocket",
                    "expires_in_seconds": self._ttl_seconds,
                    # Sent explicitly: one key opens both of the desktop's streams (mic and system
                    # audio), and a single-use key would fail the second open.
                    "single_use": False,
                    "max_session_duration_seconds": SONIOX_MAX_SESSION_SECONDS,
                },
            ),
            _SonioxTemporaryKey,
        )
        # The lifetime asked for, not one computed from `expires_at`: the API's clock may differ
        # from Soniox's, and a skew would report a key as expired or as living longer than it does.
        return SttCredential(
            provider="soniox", access_token=key.api_key, expires_in=self._ttl_seconds
        )
