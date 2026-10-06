from collections.abc import Sequence
from typing import Self

from pydantic import BaseModel

from roger_api.config import Settings
from roger_api.domain import SttProvider


class SttStreamSettings(BaseModel):
    model: str
    language: str
    sample_rate: int
    encoding: str
    # The caller's workspace jargon list as `GET /v1/vocabulary` lists it, `[]` when it has none.
    # The desktop sends it to the vendor (Deepgram `keyterm`, AssemblyAI `keyterms_prompt`). It is
    # never cached there: each token carries the list as it is now, a reopen's fresh one included.
    keyterms: list[str]
    # USD per hour of one open stream (a meeting opens two), so the desktop can meter cost
    # without knowing vendor prices. It includes the vendor's keyterm surcharge when `keyterms` is
    # not empty. None when no price is known for the model.
    price_per_hour_usd: float | None
    # USD per hour of one stream of the same model opened with no keyterms: the base price, never
    # the surcharge, and equal to `price_per_hour_usd` when `keyterms` is empty. The vendor bills a
    # stream by what it was opened with, so a stream opened with `keyterms: []` from a token that
    # carried a list (CaptureSession's reopen after the vendor rejected the list, the bench's
    # `--no-keyterms` run) is metered at this price. At `price_per_hour_usd` it would over-count,
    # and the bench would price a run without the list the same as one with it. None when no base
    # price is known.
    price_per_hour_usd_without_keyterms: float | None

    @classmethod
    def from_settings(cls, settings: Settings, *, keyterms: Sequence[str] = ()) -> Self:
        """The stream of the `STT_PROVIDER` preset for a workspace whose jargon list is `keyterms`:
        its model, that model's price with the keyterm surcharge when the list is not empty, and
        its price without keyterms."""
        return cls(
            model=settings.stt_stream_model,
            language=settings.stt_language,
            sample_rate=settings.stt_sample_rate,
            encoding=settings.stt_encoding,
            keyterms=list(keyterms),
            price_per_hour_usd=_price_per_hour_usd(settings, with_keyterms=bool(keyterms)),
            price_per_hour_usd_without_keyterms=_price_per_hour_usd(settings, with_keyterms=False),
        )


def _price_per_hour_usd(settings: Settings, *, with_keyterms: bool) -> float | None:
    # The base is STT_PRICE_PER_HOUR_USD when set, else the model's list price; the vendor bills
    # keyterms on top of either (stt_vendors.py), so the override is a rate without keyterms, never
    # an all-in one, or every stream with a list counts the surcharge twice. An unknown base or
    # surcharge makes the whole price unknown: the surcharge alone, or the base alone, would read
    # as the full price and the desktop's meter would under-count every meeting with a list.
    base = settings.stt_stream_price_per_hour_usd
    if base is None or not with_keyterms:
        return base
    surcharge = settings.stt_vendor.keyterm_surcharge_for(settings.stt_stream_model)
    if surcharge is None:
        return None
    return base + surcharge


class SttTokenOut(BaseModel):
    # The vendor id, never the preset: both AssemblyAI presets answer `assemblyai`. The desktop
    # picks its adapter by this id (apps/desktop/src/main/stt/registry.ts), and a preset id there
    # would fail Start with an unknown provider.
    provider: SttProvider
    access_token: str
    expires_in: int
    stream: SttStreamSettings
