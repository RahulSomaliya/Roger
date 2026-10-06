"""Google Calendar events in the API's shape (`provider.CalendarEvent`, docs/api-contract.md).

Google's event resource: https://developers.google.com/workspace/calendar/api/v3/reference/events
(read 2026-10-06). Used by `google.py` for live answers and by `fake.py` for its script and for
`FAKE_CALENDAR_FILE`, which is an `events.list` page in Google's own JSON.

- Timed events become UTC instants (Google's offsets resolved; a local time with a `timeZone` is
  read in that zone). All-day events keep their plain dates, end exclusive.
- Cancelled events are dropped. Declined ones are kept and say so in `self_response`: the desktop
  decides what a declined event means.
- Rooms and other resources are not attendees.
- `video_link`: `hangoutLink`, then the video entry points of the conference data, then the first
  allowlisted link in the location, then in the description (video_links.py).
"""

import datetime as dt
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError

from roger_api.services.calendar.provider import (
    CalendarAttendee,
    CalendarEvent,
    CalendarProviderName,
    ResponseStatus,
    SelfResponse,
    VideoLinkSource,
)
from roger_api.services.calendar.video_links import find_join_link, parse_join_link


class _GoogleModel(BaseModel):
    # Google adds fields over time; only the ones read here are declared.
    model_config = ConfigDict(extra="ignore", frozen=True)


class GoogleEventTime(_GoogleModel):
    date: dt.date | None = None
    date_time: dt.datetime | None = Field(default=None, alias="dateTime")
    time_zone: str | None = Field(default=None, alias="timeZone")


class GoogleAttendee(_GoogleModel):
    email: str | None = None
    display_name: str | None = Field(default=None, alias="displayName")
    # A plain string: a value Google adds later reads as unanswered instead of losing the event.
    response_status: str | None = Field(default=None, alias="responseStatus")
    is_self: bool = Field(default=False, alias="self")
    organizer: bool = False
    resource: bool = False


class GoogleOrganizer(_GoogleModel):
    email: str | None = None
    is_self: bool = Field(default=False, alias="self")


class GoogleEntryPoint(_GoogleModel):
    entry_point_type: str | None = Field(default=None, alias="entryPointType")
    uri: str | None = None


class GoogleConferenceData(_GoogleModel):
    entry_points: list[GoogleEntryPoint] = Field(default_factory=list, alias="entryPoints")


class GoogleEvent(_GoogleModel):
    id: str = Field(min_length=1)
    status: str | None = None
    summary: str | None = None
    description: str | None = None
    location: str | None = None
    html_link: str | None = Field(default=None, alias="htmlLink")
    ical_uid: str | None = Field(default=None, alias="iCalUID")
    recurring_event_id: str | None = Field(default=None, alias="recurringEventId")
    # A cancelled instance can come with no times at all.
    start: GoogleEventTime | None = None
    end: GoogleEventTime | None = None
    organizer: GoogleOrganizer | None = None
    attendees: list[GoogleAttendee] = Field(default_factory=list)
    attendees_omitted: bool = Field(default=False, alias="attendeesOmitted")
    hangout_link: str | None = Field(default=None, alias="hangoutLink")
    conference_data: GoogleConferenceData | None = Field(default=None, alias="conferenceData")


class GoogleEventsPage(_GoogleModel):
    """One page of `events.list`. Items stay raw so one unreadable event can be told apart."""

    items: list[JsonValue] = Field(default_factory=list)
    next_page_token: str | None = Field(default=None, alias="nextPageToken")


class UnreadableEventError(ValueError):
    """An event Google sent that cannot be read. The message names the event id and the problem,
    never the event's content: titles, descriptions and attendees can be private."""

    def __init__(self, event_id: str | None, problem: str) -> None:
        super().__init__(f"Calendar event {event_id or '(no id)'} is unreadable: {problem}")
        self.event_id = event_id


_RESPONSE_STATUS: dict[str, ResponseStatus] = {
    "accepted": "accepted",
    "tentative": "tentative",
    "declined": "declined",
    "needsAction": "needs_action",
}


def read_event(item: JsonValue, *, provider: CalendarProviderName) -> CalendarEvent | None:
    """One raw `events.list` item as a `CalendarEvent`; None for a cancelled event.

    Raises `UnreadableEventError` for an item that is not an event or whose times cannot be read.
    """
    event_id = item.get("id") if isinstance(item, dict) else None
    known_id = event_id if isinstance(event_id, str) and event_id else None
    try:
        event = GoogleEvent.model_validate(item)
    except ValidationError as exc:
        # The location and type of each error only: `str(exc)` would quote the input.
        problem = "; ".join(
            f"{'.'.join(str(part) for part in error['loc']) or 'event'}: {error['msg']}"
            for error in exc.errors(include_url=False, include_input=False)
        )
        raise UnreadableEventError(known_id, problem) from exc
    return normalize_event(event, provider=provider)


def normalize_event(event: GoogleEvent, *, provider: CalendarProviderName) -> CalendarEvent | None:
    """`event` in the API's shape; None for a cancelled event."""
    if event.status == "cancelled":
        return None
    if event.start is None or event.end is None:
        raise UnreadableEventError(event.id, "no start or end")

    all_day = event.start.date is not None
    if all_day:
        if event.end.date is None:
            raise UnreadableEventError(event.id, "an all-day start with a timed end")
        start, end = None, None
        start_date, end_date = event.start.date, event.end.date
    else:
        start, end = _instant(event, event.start), _instant(event, event.end)
        start_date, end_date = None, None

    attendees, attendees_omitted = _attendees(event)
    video_link, video_link_source = _video_link(event)
    return CalendarEvent(
        provider=provider,
        id=event.id,
        ical_uid=event.ical_uid,
        recurring_event_id=event.recurring_event_id,
        title=(event.summary or "").strip(),
        status="tentative" if event.status == "tentative" else "confirmed",
        all_day=all_day,
        start=start,
        end=end,
        start_date=start_date,
        end_date=end_date,
        self_response=_self_response(event),
        attendees=attendees,
        attendees_omitted=attendees_omitted,
        video_link=video_link,
        video_link_source=video_link_source,
        html_link=event.html_link,
    )


def _instant(event: GoogleEvent, time: GoogleEventTime) -> dt.datetime:
    value = time.date_time
    if value is None:
        raise UnreadableEventError(event.id, "a timed start with an all-day end")
    if value.tzinfo is None:
        # Google sends an offset in practice; its docs allow a local time named by `timeZone`.
        if not time.time_zone:
            raise UnreadableEventError(event.id, "a local time with no time zone")
        try:
            value = value.replace(tzinfo=ZoneInfo(time.time_zone))
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise UnreadableEventError(event.id, f"unknown time zone {time.time_zone!r}") from exc
    return value.astimezone(dt.UTC)


def _response(google_status: str | None) -> ResponseStatus:
    return _RESPONSE_STATUS.get(google_status or "", "needs_action")


def _self_response(event: GoogleEvent) -> SelfResponse:
    me = next((attendee for attendee in event.attendees if attendee.is_self), None)
    if me is not None:
        response = _response(me.response_status)
        # Checked before `organizer`: declining your own event means you are not attending it.
        if response == "declined":
            return "declined"
        return "organizer" if me.organizer else response
    # An event with no guests has no attendee list, only `organizer.self`.
    if event.organizer is not None and event.organizer.is_self:
        return "organizer"
    return "unknown"


def _attendees(event: GoogleEvent) -> tuple[tuple[CalendarAttendee, ...], bool]:
    """The people on the invite in invite order, and whether some were left out."""
    attendees: list[CalendarAttendee] = []
    omitted = event.attendees_omitted
    for attendee in event.attendees:
        if attendee.resource:
            continue  # A room is not a person on the call.
        if not attendee.email:
            # Another person on the call, which the desktop counts as evidence of a call, but the
            # contract lists attendees by email: flag them as left out rather than drop them.
            omitted = True
            continue
        attendees.append(
            CalendarAttendee(
                email=attendee.email,
                display_name=attendee.display_name or None,
                response_status=_response(attendee.response_status),
                is_self=attendee.is_self,
                is_organizer=attendee.organizer,
            )
        )
    return tuple(attendees), omitted


def _video_link(event: GoogleEvent) -> tuple[str | None, VideoLinkSource | None]:
    conference = [event.hangout_link] + [
        entry_point.uri
        for entry_point in (event.conference_data.entry_points if event.conference_data else [])
        if entry_point.entry_point_type == "video"
    ]
    for candidate in conference:
        if candidate and (link := parse_join_link(candidate)):
            return link.url, "conference"
    texts: tuple[tuple[str | None, VideoLinkSource], ...] = (
        (event.location, "location"),
        (event.description, "description"),
    )
    for text, source in texts:
        if text and (link := find_join_link(text)):
            return link.url, source
    return None, None
