from collections.abc import Mapping, Sequence
from typing import Annotated, Self
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StringConstraints

from roger_api.config_calendar import CalendarProviderName
from roger_api.db.models import Meeting
from roger_api.db.models_calendar import AttendeeResponseStatus, MeetingAttendee
from roger_api.domain import DEFAULT_MEETING_TITLE, MeetingStatus, StartSource
from roger_api.schemas.common import UtcDatetime, storable_input
from roger_api.services.records import MeetingRecord


def _title_or_default(value: object) -> object:
    value = storable_input(value)
    if value is None or (isinstance(value, str) and not value.strip()):
        return DEFAULT_MEETING_TITLE
    return value


def _blank_is_none(value: object) -> object:
    value = storable_input(value)
    if isinstance(value, str) and not value.strip():
        return None
    return value


# The most attendees a meeting keeps, in invite order. The desktop cuts the list to the same number
# before it sends (MAX_MEETING_ATTENDEES in apps/desktop/src/shared/calendar.ts); change the two
# together.
MAX_MEETING_ATTENDEES = 200
# Every text field of a calendar link. Far above anything Google sends (its event ids are at most
# 1024 characters), so a real invite never meets it: a refused create keeps the whole meeting, its
# transcript included, off the server.
MAX_CALENDAR_TEXT_LENGTH = 2048

# Blank, or nothing but U+0000 and whitespace, is the default title.
MeetingTitle = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=500),
    # After the constraints, as in CalendarText: written first, it made pydantic count trailing
    # spaces toward the 500 (test_the_title_limit_counts_the_trimmed_title).
    BeforeValidator(_title_or_default),
]
# U+0000 dropped and unpaired surrogates replaced (`storable_text`), then trimmed.
CalendarText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_CALENDAR_TEXT_LENGTH),
    # After the constraints, never before: written first, it makes pydantic check the lengths
    # before the trim, so " " passes as "" (test_create_validation_errors pins it).
    BeforeValidator(storable_input),
]
# Blank, NUL and whitespace only included, reads as null. M6 matches two teammates' notes of one
# call by `ical_uid`: stored as "", it would match calls that have nothing to do with each other.
OptionalCalendarText = Annotated[CalendarText | None, BeforeValidator(_blank_is_none)]


class CalendarAttendee(BaseModel):
    """A person on the invite, as the calendar listed them. Rooms are never attendees.

    The contract's `CalendarAttendee`, defined under Calendar in docs/api-contract.md and also
    served on calendar events by schemas/calendar.py: change the two models together."""

    model_config = ConfigDict(from_attributes=True)

    email: CalendarText
    display_name: OptionalCalendarText = None
    # meeting_attendees.response_status has no check constraint: this type is its only guard.
    response_status: AttendeeResponseStatus
    is_self: bool
    is_organizer: bool


class MeetingCalendarEvent(BaseModel):
    """The calendar event a meeting was started for. Stored once, by the create that made the
    meeting: the ids and times are `meetings` columns, the attendees `meeting_attendees` rows."""

    # meetings.calendar_provider has no check constraint: this type is its only guard.
    provider: CalendarProviderName
    event_id: CalendarText  # the instance id when the event recurs
    ical_uid: OptionalCalendarText = None  # the same for every invitee
    recurring_event_id: OptionalCalendarText = None
    # Not checked for order: they copy what the calendar said, and a refused create would keep the
    # meeting, transcript included, off the server.
    scheduled_start: UtcDatetime
    scheduled_end: UtcDatetime
    # In invite order.
    attendees: Annotated[list[CalendarAttendee], Field(max_length=MAX_MEETING_ATTENDEES)]


class MeetingCreate(BaseModel):
    id: UUID | None = None
    title: MeetingTitle = DEFAULT_MEETING_TITLE
    started_at: UtcDatetime | None = None
    start_source: StartSource = "manual"
    calendar_event: MeetingCalendarEvent | None = None


class MeetingEnd(BaseModel):
    ended_at: UtcDatetime | None = None


def _calendar_event(
    meeting: Meeting, attendees: Sequence[MeetingAttendee]
) -> MeetingCalendarEvent | None:
    if meeting.calendar_event_id is None:
        return None
    provider, start, end = (
        meeting.calendar_provider,
        meeting.scheduled_start_at,
        meeting.scheduled_end_at,
    )
    if provider is None or start is None or end is None:
        # services.meetings.create_meeting writes the link's columns together; no constraint does.
        raise ValueError(
            f"Meeting {meeting.id} has a calendar event id without its provider or scheduled times"
        )
    return MeetingCalendarEvent(
        provider=provider,
        event_id=meeting.calendar_event_id,
        ical_uid=meeting.calendar_ical_uid,
        recurring_event_id=meeting.calendar_recurring_event_id,
        scheduled_start=start,
        scheduled_end=end,
        attendees=[CalendarAttendee.model_validate(attendee) for attendee in attendees],
    )


class MeetingOut(BaseModel):
    id: UUID
    workspace_id: UUID
    title: str
    status: MeetingStatus
    started_at: UtcDatetime
    ended_at: UtcDatetime | None
    segment_count: int
    start_source: StartSource
    calendar_event: MeetingCalendarEvent | None
    created_at: UtcDatetime
    updated_at: UtcDatetime

    @classmethod
    def from_record(
        cls, record: MeetingRecord, attendees: Mapping[UUID, Sequence[MeetingAttendee]]
    ) -> Self:
        """`attendees` is what `services.meetings.list_attendees` returned for this meeting, or for
        the page it is on. Load it once per page, never once per meeting."""
        meeting = record.meeting
        return cls(
            id=meeting.id,
            workspace_id=meeting.workspace_id,
            title=meeting.title,
            status=meeting.status,
            started_at=meeting.started_at,
            ended_at=meeting.ended_at,
            segment_count=record.segment_count,
            start_source=meeting.start_source,
            calendar_event=_calendar_event(meeting, attendees.get(meeting.id, ())),
            created_at=meeting.created_at,
            updated_at=meeting.updated_at,
        )


class MeetingList(BaseModel):
    items: list[MeetingOut]
