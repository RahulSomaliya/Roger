"""The speech-to-text vendor registry: everything the API knows about a vendor, in one entry.

An entry holds what stays server-side: how to mint the desktop's short-lived token (the issuer),
the streaming model used when `STT_MODEL` is unset, the model names only that vendor uses, its
limit on the token lifetime, and its list price. `config.Settings` validates against it and
`/v1/stt/token` answers from it. The desktop's registry (apps/desktop/src/main/stt/registry.ts)
lists the same provider ids. Adding a vendor: "Add a speech-to-text vendor" in
apps/desktop/README.md.

Prices are USD per hour of ONE open stream, from the vendor's published list price. A meeting
opens two streams (mic and system audio), and AssemblyAI bills the time a stream is open, silent
or not, so a meeting hour costs twice the price. `STT_PRICE_PER_HOUR_USD` overrides the table
(a negotiated rate, or a model not listed here).
- AssemblyAI, https://www.assemblyai.com/pricing (read 2026-10-06): Universal-Streaming English
  and Multilingual $0.15/hr, Universal-3.6 Pro realtime $0.45/hr base, "billed on session
  duration: the time the WebSocket connection is open, not the duration of audio sent".
- Deepgram, https://deepgram.com/pricing (read 2026-10-06): Nova-3 monolingual streaming, Pay As
  You Go, regular price $0.0077/min = $0.462/hr (a promotional $0.0048/min was also shown; the
  regular price is used so estimates err high). Deepgram bills the audio streamed, and Roger
  streams silence as well, so an open stream costs about its open time there too.
"""

from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import TYPE_CHECKING, Protocol

import httpx

from roger_api.domain import SttProvider
from roger_api.services.stt_tokens import (
    VENDOR_TIMEOUT,
    AssemblyAiSttTokenIssuer,
    DeepgramSttTokenIssuer,
    FakeSttTokenIssuer,
    SttTokenIssuer,
)

if TYPE_CHECKING:
    # Only for the annotation: config imports this module, so a runtime import is a cycle.
    from roger_api.config import Settings


class SttIssuerFactory(Protocol):
    def __call__(
        self, http: httpx.AsyncClient, *, api_key: str, ttl_seconds: int
    ) -> SttTokenIssuer: ...


@dataclass(frozen=True, slots=True)
class SttVendor:
    provider: SttProvider
    # The vendor's English streaming model, used when STT_MODEL is unset.
    default_model: str
    # Model names only this vendor uses. A `.env` switched to another vendor but still naming
    # this one's model fails at startup instead of when someone presses Start on the Mac.
    model_prefix: str | None
    # The longest token lifetime the vendor's token endpoint accepts.
    max_token_ttl_seconds: int
    # USD per hour of one open stream, by model (see the module docstring).
    price_per_hour_usd: Mapping[str, float]
    # Mints the desktop's token. None: no vendor (the desktop's built-in fake).
    issuer: SttIssuerFactory | None
    # The price of a model missing from the table. None means unknown: a real vendor's price is
    # never guessed.
    other_models_price_per_hour_usd: float | None = field(default=None)

    def price_for(self, model: str) -> float | None:
        return self.price_per_hour_usd.get(model, self.other_models_price_per_hour_usd)


STT_VENDORS: Mapping[SttProvider, SttVendor] = MappingProxyType(
    {
        "fake": SttVendor(
            provider="fake",
            default_model="fake",
            model_prefix=None,
            max_token_ttl_seconds=3600,
            price_per_hour_usd={},
            issuer=None,
            other_models_price_per_hour_usd=0.0,
        ),
        "deepgram": SttVendor(
            provider="deepgram",
            default_model="nova-3",
            model_prefix="nova-",
            max_token_ttl_seconds=3600,
            price_per_hour_usd={"nova-3": 0.462},
            issuer=DeepgramSttTokenIssuer,
        ),
        # The owner's choice on 2026-10-06. The default is Universal-Streaming English, not the
        # vendor's documented default universal-3-6-pro: $0.45/hr, and it takes no `format_turns`
        # (the desktop adapter sends that only to universal-streaming-* models).
        "assemblyai": SttVendor(
            provider="assemblyai",
            default_model="universal-streaming-english",
            model_prefix="universal-",
            max_token_ttl_seconds=600,
            price_per_hour_usd={
                "universal-streaming-english": 0.15,
                "universal-streaming-multilingual": 0.15,
                "universal-3-6-pro": 0.45,
            },
            issuer=AssemblyAiSttTokenIssuer,
        ),
    }
)


@asynccontextmanager
async def open_stt_token_issuer(settings: "Settings") -> AsyncIterator[SttTokenIssuer]:
    """The issuer for `STT_PROVIDER`, holding any HTTP client it needs for the app's lifetime."""
    vendor = STT_VENDORS[settings.stt_provider]
    if vendor.issuer is None:
        yield FakeSttTokenIssuer()
        return
    key = settings.stt_vendor_key
    if key is None:  # Settings validation already guarantees this.
        raise RuntimeError(
            f"{vendor.provider.upper()}_API_KEY is required when STT_PROVIDER={vendor.provider}"
        )
    async with httpx.AsyncClient(timeout=VENDOR_TIMEOUT) as http:
        yield vendor.issuer(
            http, api_key=key.get_secret_value(), ttl_seconds=settings.stt_token_ttl_seconds
        )
