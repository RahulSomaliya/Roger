from collections.abc import Mapping, Sequence
from typing import Annotated, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from roger_api.db.models_calendar import MeetingAttendee
from roger_api.domain import MAX_SEGMENTS_PER_APPEND, AudioSource
from roger_api.schemas.common import Confidence, NonEmptyText, OffsetMs, UtcDatetime
from roger_api.schemas.meetings import MeetingOut
from roger_api.services.records import Transcript


def _require_ordered_span(start_ms: int, end_ms: int) -> None:
    if end_ms < start_ms:
        raise ValueError("end_ms must be >= start_ms")


class TranscriptWord(BaseModel):
    text: NonEmptyText
    start_ms: OffsetMs
    end_ms: OffsetMs
    confidence: Confidence | None = None

    @model_validator(mode="after")
    def _end_not_before_start(self) -> Self:
        _require_ordered_span(self.start_ms, self.end_ms)
        return self


class SegmentIn(BaseModel):
    id: UUID
    source: AudioSource
    speaker: NonEmptyText
    start_ms: OffsetMs
    end_ms: OffsetMs
    text: NonEmptyText
    confidence: Confidence | None = None
    words: list[TranscriptWord] | None = None

    @model_validator(mode="after")
    def _end_not_before_start(self) -> Self:
        _require_ordered_span(self.start_ms, self.end_ms)
        return self


class SegmentOut(SegmentIn):
    model_config = ConfigDict(from_attributes=True)

    meeting_id: UUID
    created_at: UtcDatetime


class SegmentsAppend(BaseModel):
    segments: Annotated[list[SegmentIn], Field(min_length=1, max_length=MAX_SEGMENTS_PER_APPEND)]


class SegmentsAppendResult(BaseModel):
    accepted: int
    duplicates: int


class TranscriptOut(BaseModel):
    meeting: MeetingOut
    segments: list[SegmentOut]

    @classmethod
    def from_transcript(
        cls, transcript: Transcript, attendees: Mapping[UUID, Sequence[MeetingAttendee]]
    ) -> Self:
        """`attendees` as `MeetingOut.from_record` takes them."""
        return cls(
            meeting=MeetingOut.from_record(transcript.meeting, attendees),
            segments=[SegmentOut.model_validate(segment) for segment in transcript.segments],
        )
