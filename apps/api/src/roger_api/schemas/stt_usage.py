"""STT usage on the wire: one meeting's usage as the desktop meters it, and the summary.

The desktop's `SttUsageUploader` (M3-T19b) sends each local `stt_usage` row once per save and
treats a `422` as a rejected row that it never sends again until a later save changes it. So
everything here refuses only what no Mac ever sends (a negative count, a blank name), never a value
a Mac of another release could hold.
"""

from typing import Annotated, Self
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, Field, StringConstraints

from roger_api.db.models_stt_usage import MAX_USAGE_LABEL_LENGTH, MeetingSttUsage
from roger_api.schemas.common import UtcDatetime

# Postgres `integer` and `bigint`: a larger number would fail the insert with a 500.
UsageCount = Annotated[int, Field(ge=0, le=2_147_483_647)]
UsageMs = Annotated[int, Field(ge=0, le=9_223_372_036_854_775_807)]
# Python's json reads NaN and Infinity; neither is a cost.
UsageUsd = Annotated[float, Field(ge=0, allow_inf_nan=False)]


def _without_nul(value: object) -> object:
    # Postgres `text` cannot hold U+0000: kept, it fails the insert with a 500. Dropped, not
    # refused: a refused row is never sent again. A name that is only NULs is then blank, and
    # refused. Pydantic itself refuses an unpaired surrogate, which UTF-8 cannot encode.
    if isinstance(value, str):
        return value.replace("\x00", "")
    return value


# `provider` and `stop_reason`: free text, never a list (MAX_USAGE_LABEL_LENGTH says why).
UsageLabel = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_USAGE_LABEL_LENGTH),
    # After the constraints, never before: written first, it makes pydantic check the lengths
    # before the trim, so " " passes as "".
    BeforeValidator(_without_nul),
]


class SttSourceUsage(BaseModel):
    """What one audio source's sessions used. The desktop's `SttUsage`, in snake case."""

    sessions_opened: UsageCount
    connected_ms: UsageMs
    audio_sent_ms: UsageMs
    dropped_chunks: UsageCount
    # Missing reads as 0: the silence gate (M3-T20) lands after the uploader.
    gated_ms: UsageMs = 0
    # Required, null when unknown: a client that forgot it must not read as an unknown price.
    estimated_cost_usd: UsageUsd | None


class SttUsageBySource(BaseModel):
    mic: SttSourceUsage
    system: SttSourceUsage


class SttUsageIn(BaseModel):
    """`PUT /v1/stt-usage/meetings/{id}`: the meeting's whole usage so far, both sources summed."""

    provider: UsageLabel
    sessions_opened: UsageCount
    connected_ms: UsageMs
    audio_sent_ms: UsageMs
    dropped_chunks: UsageCount
    gated_ms: UsageMs = 0
    estimated_cost_usd: UsageUsd | None
    by_source: SttUsageBySource
    # Null while the recording still runs.
    stop_reason: UsageLabel | None = None


class SttUsageOut(BaseModel):
    meeting_id: UUID
    provider: str
    sessions_opened: int
    connected_ms: int
    audio_sent_ms: int
    dropped_chunks: int
    gated_ms: int
    estimated_cost_usd: float | None
    by_source: SttUsageBySource
    stop_reason: str | None
    created_at: UtcDatetime
    updated_at: UtcDatetime

    @classmethod
    def from_row(cls, row: MeetingSttUsage) -> Self:
        cost = row.estimated_cost_usd
        return cls(
            meeting_id=row.meeting_id,
            provider=row.provider,
            sessions_opened=row.sessions_opened,
            connected_ms=row.connected_ms,
            audio_sent_ms=row.audio_sent_ms,
            dropped_chunks=row.dropped_chunks,
            gated_ms=row.gated_ms,
            # A float on the wire: pydantic writes a Decimal as a JSON string.
            estimated_cost_usd=None if cost is None else float(cost),
            by_source=SttUsageBySource.model_validate(row.by_source),
            stop_reason=row.stop_reason,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )


class SttUsageSummary(BaseModel):
    """`GET /v1/stt-usage/summary`. Hours and USD to 4 decimal places (services/stt_usage.py)."""

    meetings: int
    stream_hours: float
    meeting_hours: float
    estimated_cost_usd: float | None
    cost_per_meeting_hour: float | None
    gated_hours: float
    estimated_saved_usd: float | None
    unpriced_meetings: int
    unpriced_meeting_ids: list[UUID]
