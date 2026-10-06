"""The speech-to-text registry: the vendors the API can mint tokens for, and the presets.

A vendor entry (`STT_VENDORS`) holds what stays server-side: how to mint the desktop's
short-lived token (the issuer), its limit on the token lifetime, and its list price by model. A
preset (`STT_PRESETS`) is what `STT_PROVIDER` names: one vendor and one of its models. Another
model is another preset row, so every configuration is one `.env` line from every other.
`config.Settings` validates against both and `/v1/stt/token` answers from them. The desktop's
registry (apps/desktop/src/main/stt/registry.ts) lists the same vendor ids, but for one whose
adapter is still to come, and never sees a preset (tests/test_stt_providers.py checks both).
Adding a vendor: "Add a speech-to-text vendor" in apps/desktop/README.md. Its part here is one
`STT_VENDORS` entry and at least one `STT_PRESETS` row with its id added to `SttPresetId`:
`STT_PROVIDER` names a preset, so a vendor no preset names cannot be selected (a test fails).

Prices are USD per hour of ONE open stream, from the vendor's published list price. A meeting
opens two streams (mic and system audio), and AssemblyAI bills the time a stream is open, silent
or not, so a meeting hour costs twice the price. `STT_PRICE_PER_HOUR_USD` overrides the base price
for every preset (a negotiated rate, or Deepgram's unpublished price with training opted out).
A stream that carries keyterms (the workspace's jargon list, sent with every token) also pays the
vendor's keyterm surcharge for its model, added to the base price, the override included
(schemas/stt.py). It is per stream hour, whatever the list's length; 0.0 where the model's price
includes keyterms. So the override is a rate without keyterms: an all-in rate would count the
surcharge twice on every stream with a list. A stream opened with no keyterms pays the base alone,
which the token also carries (`stream.price_per_hour_usd_without_keyterms`).
- AssemblyAI, https://www.assemblyai.com/pricing (read 2026-10-06): Universal-Streaming English
  and Multilingual $0.15/hr, Universal-3.6 Pro realtime $0.45/hr base, "billed on session
  duration: the time the WebSocket connection is open, not the duration of audio sent".
  Keyterms prompting: Universal-Streaming English "+$0.04/hr"; Universal-3.6 Pro Realtime and
  Universal-Streaming Multilingual "Included".
- Deepgram, https://deepgram.com/pricing (read 2026-10-06): Nova-3 monolingual streaming, Pay As
  You Go, regular price $0.0077/min = $0.462/hr (a promotional $0.0048/min was also shown; the
  regular price is used so estimates err high). Deepgram bills the audio streamed, and Roger
  streams silence as well, so an open stream costs about its open time there too. Keyterm
  prompting, streaming, Pay As You Go: $0.0013/min = $0.078/hr.
- Soniox, https://soniox.com/pricing (read 2026-10-07): real-time stt-rt-v5 $0.12/hr, billed in
  tokens: input audio $2.00 per 1M (about 30,000 an hour of audio) and output text $4.00 per 1M
  (about 15,000 an hour of speech). So $0.12 is an hour of continuous speech, and a stream with
  pauses costs less (the estimate errs high). Context, which carries the jargon list as
  `context.terms` (https://soniox.com/docs/stt/concepts/context), is billed as input text tokens,
  $4.00 per 1M at about 0.3 tokens a character. The list goes once per stream, in its opening
  config message (the pricing page does not say how often it is counted), so its cost is per
  stream opened, not per hour: Roger's longest list (800 characters, schemas/vocabulary.py) is
  about 240 tokens, under $0.001. Its surcharge is therefore 0.0, which that margin covers.
  stt-rt-v5 is the current real-time model (https://soniox.com/docs/stt/models, same date).
"""

from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import TYPE_CHECKING, Literal, Protocol

import httpx

from roger_api.domain import SttProvider
from roger_api.services.stt_tokens import (
    VENDOR_TIMEOUT,
    AssemblyAiSttTokenIssuer,
    DeepgramSttTokenIssuer,
    FakeSttTokenIssuer,
    SonioxSttTokenIssuer,
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
    # The longest token lifetime the vendor's token endpoint accepts.
    max_token_ttl_seconds: int
    # USD per hour of one open stream, by model (see the module docstring).
    price_per_hour_usd: Mapping[str, float]
    # USD per hour added to a stream that carries keyterms, by model; 0.0 where the price includes
    # them (see the module docstring). Required, so a new vendor states it: a missing surcharge
    # makes the price of every stream with a jargon list unknown, and the base price alone would
    # under-count it.
    keyterm_surcharge_per_hour_usd: Mapping[str, float]
    # Mints the desktop's token. None: no vendor (the desktop's built-in fake).
    issuer: SttIssuerFactory | None
    # The price of a model missing from the table. None means unknown: a real vendor's price is
    # never guessed.
    other_models_price_per_hour_usd: float | None = field(default=None)
    # The keyterm surcharge of a model missing from its table. None means unknown, as above.
    other_models_keyterm_surcharge_per_hour_usd: float | None = field(default=None)

    def price_for(self, model: str) -> float | None:
        return self.price_per_hour_usd.get(model, self.other_models_price_per_hour_usd)

    def keyterm_surcharge_for(self, model: str) -> float | None:
        return self.keyterm_surcharge_per_hour_usd.get(
            model, self.other_models_keyterm_surcharge_per_hour_usd
        )


STT_VENDORS: Mapping[SttProvider, SttVendor] = MappingProxyType(
    {
        "fake": SttVendor(
            provider="fake",
            max_token_ttl_seconds=3600,
            price_per_hour_usd={},
            keyterm_surcharge_per_hour_usd={},
            issuer=None,
            other_models_price_per_hour_usd=0.0,
            other_models_keyterm_surcharge_per_hour_usd=0.0,
        ),
        "deepgram": SttVendor(
            provider="deepgram",
            max_token_ttl_seconds=3600,
            price_per_hour_usd={"nova-3": 0.462},
            keyterm_surcharge_per_hour_usd={"nova-3": 0.078},
            issuer=DeepgramSttTokenIssuer,
        ),
        "assemblyai": SttVendor(
            provider="assemblyai",
            max_token_ttl_seconds=600,
            price_per_hour_usd={
                "universal-streaming-english": 0.15,
                "universal-streaming-multilingual": 0.15,
                "universal-3-6-pro": 0.45,
            },
            keyterm_surcharge_per_hour_usd={
                "universal-streaming-english": 0.04,
                "universal-streaming-multilingual": 0.0,
                "universal-3-6-pro": 0.0,
            },
            issuer=AssemblyAiSttTokenIssuer,
        ),
        # The optional third vendor (decision D1 in docs/plans/M3-live-transcript.md): its docs
        # say it never trains on customer audio, and it has the lowest live price.
        "soniox": SttVendor(
            provider="soniox",
            max_token_ttl_seconds=3600,
            price_per_hour_usd={"stt-rt-v5": 0.12},
            keyterm_surcharge_per_hour_usd={"stt-rt-v5": 0.0},
            issuer=SonioxSttTokenIssuer,
        ),
    }
)


# What STT_PROVIDER may name. A test keeps it equal to the keys of STT_PRESETS.
type SttPresetId = Literal["fake", "assemblyai", "assemblyai-pro", "deepgram", "soniox"]


@dataclass(frozen=True, slots=True)
class SttPreset:
    # An STT_VENDORS key: the token's `provider`, which picks the desktop's adapter.
    vendor: SttProvider
    # The model the desktop asks the vendor for, priced from the vendor's table above. Spell it
    # exactly as the vendor does: AssemblyAI quietly runs another model for a name it does not
    # know, and a test fails on a preset whose model has no list price.
    model: str


STT_PRESETS: Mapping[SttPresetId, SttPreset] = MappingProxyType(
    {
        "fake": SttPreset(vendor="fake", model="fake"),
        # The owner's choice on 2026-10-06 (M1): Universal-Streaming English, not the vendor's
        # documented default universal-3-6-pro at three times the price.
        "assemblyai": SttPreset(vendor="assemblyai", model="universal-streaming-english"),
        # Run B of the M3 bake-off, run only if it is worth its price
        # (docs/plans/M3-live-transcript.md). It takes no `format_turns`: the desktop adapter
        # sends that only to universal-streaming-* models.
        "assemblyai-pro": SttPreset(vendor="assemblyai", model="universal-3-6-pro"),
        "deepgram": SttPreset(vendor="deepgram", model="nova-3"),
        # Run D of the M3 bake-off. The desktop runs it once M3-T15's adapter lands; until then
        # Start on the Mac refuses the provider.
        "soniox": SttPreset(vendor="soniox", model="stt-rt-v5"),
    }
)


@asynccontextmanager
async def open_stt_token_issuer(settings: "Settings") -> AsyncIterator[SttTokenIssuer]:
    """The issuer for `STT_PROVIDER`, holding any HTTP client it needs for the app's lifetime."""
    # The preset's vendor, never STT_VENDORS[settings.stt_provider]: that is a preset id, and
    # STT_PROVIDER=assemblyai-pro would be a KeyError at startup.
    vendor = settings.stt_vendor
    if vendor.issuer is None:
        yield FakeSttTokenIssuer()
        return
    key = settings.stt_vendor_key
    if key is None:  # Settings validation already guarantees this.
        raise RuntimeError(
            f"{vendor.provider.upper()}_API_KEY is required when "
            f"STT_PROVIDER={settings.stt_provider}"
        )
    async with httpx.AsyncClient(timeout=VENDOR_TIMEOUT) as http:
        yield vendor.issuer(
            http, api_key=key.get_secret_value(), ttl_seconds=settings.stt_token_ttl_seconds
        )
