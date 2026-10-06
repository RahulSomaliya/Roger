from typing import Self

from pydantic import BaseModel

from roger_api.config import Settings, SttProvider


class SttStreamSettings(BaseModel):
    model: str
    language: str
    sample_rate: int
    encoding: str

    @classmethod
    def from_settings(cls, settings: Settings) -> Self:
        return cls(
            model=settings.stt_model,
            language=settings.stt_language,
            sample_rate=settings.stt_sample_rate,
            encoding=settings.stt_encoding,
        )


class SttTokenOut(BaseModel):
    provider: SttProvider
    access_token: str
    expires_in: int
    stream: SttStreamSettings
