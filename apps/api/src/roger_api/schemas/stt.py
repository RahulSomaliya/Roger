from typing import Self

from pydantic import BaseModel

from roger_api.config import Settings
from roger_api.domain import SttProvider


class SttStreamSettings(BaseModel):
    model: str
    language: str
    sample_rate: int
    encoding: str
    # USD per hour of one open stream (a meeting opens two), so the desktop can meter cost
    # without knowing vendor prices. None when no price is known for the model.
    price_per_hour_usd: float | None

    @classmethod
    def from_settings(cls, settings: Settings) -> Self:
        return cls(
            model=settings.stt_stream_model,
            language=settings.stt_language,
            sample_rate=settings.stt_sample_rate,
            encoding=settings.stt_encoding,
            price_per_hour_usd=settings.stt_stream_price_per_hour_usd,
        )


class SttTokenOut(BaseModel):
    provider: SttProvider
    access_token: str
    expires_in: int
    stream: SttStreamSettings
