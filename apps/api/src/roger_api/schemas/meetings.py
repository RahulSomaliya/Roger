from typing import Annotated, Self
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, StringConstraints

from roger_api.domain import DEFAULT_MEETING_TITLE, MeetingStatus
from roger_api.schemas.common import UtcDatetime
from roger_api.services.records import MeetingRecord


def _title_or_default(value: object) -> object:
    if value is None or (isinstance(value, str) and not value.strip()):
        return DEFAULT_MEETING_TITLE
    return value


MeetingTitle = Annotated[
    str,
    BeforeValidator(_title_or_default),
    StringConstraints(strip_whitespace=True, max_length=500),
]


class MeetingCreate(BaseModel):
    id: UUID | None = None
    title: MeetingTitle = DEFAULT_MEETING_TITLE
    started_at: UtcDatetime | None = None


class MeetingEnd(BaseModel):
    ended_at: UtcDatetime | None = None


class MeetingOut(BaseModel):
    id: UUID
    workspace_id: UUID
    title: str
    status: MeetingStatus
    started_at: UtcDatetime
    ended_at: UtcDatetime | None
    segment_count: int
    created_at: UtcDatetime
    updated_at: UtcDatetime

    @classmethod
    def from_record(cls, record: MeetingRecord) -> Self:
        meeting = record.meeting
        return cls(
            id=meeting.id,
            workspace_id=meeting.workspace_id,
            title=meeting.title,
            status=meeting.status,
            started_at=meeting.started_at,
            ended_at=meeting.ended_at,
            segment_count=record.segment_count,
            created_at=meeting.created_at,
            updated_at=meeting.updated_at,
        )


class MeetingList(BaseModel):
    items: list[MeetingOut]
