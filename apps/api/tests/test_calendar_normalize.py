"""Google Calendar events in the API's shape (M5-T2): `services/calendar/normalize.py`.

`tests/fixtures/calendar/google_events.json` is an `events.list` page as Google sends it for a
calendar in Asia/Kolkata; the small dicts below vary one field at a time.
"""

import json
from dataclasses import replace
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest
from pydantic import JsonValue

from roger_api.services.calendar.normalize import (
    GoogleEventsPage,
    UnreadableEventError,
    read_event,
)
from roger_api.services.calendar.provider import CalendarAttendee, CalendarEvent

FIXTURE = Path(__file__).parent / "fixtures" / "calendar" / "google_events.json"

type Json = dict[str, Any]


def fixture_items() -> dict[str, Json]:
    page = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return {item["id"]: item for item in page["items"]}


def google_event(**fields: object) -> Json:
    """A timed, confirmed event with one other attendee; `fields` replace or add Google fields."""
    event: Json = {
        "id": "evt1",
        "status": "confirmed",
        "summary": "Sync",
        "start": {"dateTime": "2026-10-06T10:00:00Z"},
        "end": {"dateTime": "2026-10-06T10:30:00Z"},
        "attendees": [
            {"email": "me@linkt.ai", "self": True, "responseStatus": "accepted"},
            {"email": "jane@linkt.ai", "responseStatus": "accepted"},
        ],
    }
    event.update(fields)
    return event


def read(item: Json) -> CalendarEvent:
    event = read_event(item, provider="google")
    assert event is not None
    return event


def test_fixture_page_reads_in_order_without_the_cancelled_instance() -> None:
    page = GoogleEventsPage.model_validate_json(FIXTURE.read_text(encoding="utf-8"))

    events = [read_event(item, provider="google") for item in page.items]

    assert [event.id if event else None for event in events] == [
        "4k1offsite0001",
        "7q2standup0001_20261006T043000Z",
        None,
        "9v3vendor0001",
        "2m4review0001",
        "5h7allhands0001",
    ]
    assert page.next_page_token is None


def test_timed_event_offsets_become_utc() -> None:
    event = read(fixture_items()["7q2standup0001_20261006T043000Z"])

    assert event.all_day is False
    assert event.start == datetime(2026, 10, 6, 4, 45, tzinfo=UTC)
    assert event.end == datetime(2026, 10, 6, 5, 0, tzinfo=UTC)
    assert event.start_date is None
    assert event.end_date is None


def test_time_without_offset_is_read_in_its_time_zone() -> None:
    event = read(
        google_event(
            start={"dateTime": "2026-10-06T10:00:00", "timeZone": "America/Los_Angeles"},
            end={"dateTime": "2026-10-06T10:30:00", "timeZone": "America/Los_Angeles"},
        )
    )

    assert event.start == datetime(2026, 10, 6, 17, 0, tzinfo=UTC)
    assert event.end == datetime(2026, 10, 6, 17, 30, tzinfo=UTC)


def test_all_day_keeps_its_dates_and_is_never_midnight_utc() -> None:
    event = read(fixture_items()["4k1offsite0001"])

    assert event.all_day is True
    assert event.start_date == date(2026, 10, 6)
    assert event.end_date == date(2026, 10, 8)  # exclusive, as Google sends it
    assert event.start is None
    assert event.end is None


def test_cancelled_event_is_dropped() -> None:
    assert read_event(fixture_items()["7q2standup0001_20261007T043000Z"], provider="google") is None
    assert read_event(google_event(status="cancelled"), provider="google") is None


def test_declined_event_is_kept_as_declined() -> None:
    event = read(fixture_items()["9v3vendor0001"])

    assert event.self_response == "declined"
    assert event.title == "Vendor demo: Acme transcription"


def test_self_organizer_is_organizer() -> None:
    event = read(fixture_items()["2m4review0001"])

    assert event.self_response == "organizer"
    assert event.status == "tentative"


def test_solo_block_owned_by_the_user_is_organizer() -> None:
    # Google sends no attendee list for an event with no guests, only `organizer.self`.
    event = read(google_event(attendees=[], organizer={"email": "me@linkt.ai", "self": True}))

    assert event.self_response == "organizer"
    assert event.attendees == ()


def test_organizer_who_declined_is_declined() -> None:
    # Declining your own event means you are not attending it either.
    event = read(
        google_event(
            attendees=[
                {
                    "email": "me@linkt.ai",
                    "self": True,
                    "organizer": True,
                    "responseStatus": "declined",
                },
                {"email": "jane@linkt.ai", "responseStatus": "accepted"},
            ]
        )
    )

    assert event.self_response == "declined"


@pytest.mark.parametrize(
    ("google_status", "expected"),
    [
        ("accepted", "accepted"),
        ("tentative", "tentative"),
        ("needsAction", "needs_action"),
        (None, "needs_action"),
        ("somethingNew", "needs_action"),
    ],
)
def test_self_response_maps_google_names(google_status: str | None, expected: str) -> None:
    me: Json = {"email": "me@linkt.ai", "self": True}
    if google_status is not None:
        me["responseStatus"] = google_status

    event = read(google_event(attendees=[me]))

    assert event.self_response == expected
    assert event.attendees[0].response_status == expected


def test_self_response_is_unknown_when_the_user_is_not_listed() -> None:
    event = read(google_event(attendees=[{"email": "jane@linkt.ai"}]))

    assert event.self_response == "unknown"


def test_attendees_keep_invite_order_and_drop_rooms() -> None:
    event = read(fixture_items()["7q2standup0001_20261006T043000Z"])

    assert event.attendees == (
        CalendarAttendee(
            email="jane@linkt.ai",
            display_name="Jane Doe",
            response_status="accepted",
            is_self=False,
            is_organizer=True,
        ),
        CalendarAttendee(
            email="priya@linkt.ai",
            display_name=None,
            response_status="accepted",
            is_self=True,
            is_organizer=False,
        ),
        CalendarAttendee(
            email="ali@linkt.ai",
            display_name="Ali Khan",
            response_status="tentative",
            is_self=False,
            is_organizer=False,
        ),
        CalendarAttendee(
            email="sam@linkt.ai",
            display_name=None,
            response_status="needs_action",
            is_self=False,
            is_organizer=False,
        ),
    )
    assert event.attendees_omitted is False


def test_attendees_omitted_is_kept() -> None:
    event = read(fixture_items()["5h7allhands0001"])

    assert event.attendees_omitted is True
    assert [attendee.email for attendee in event.attendees] == ["priya@linkt.ai"]


def test_attendee_without_an_email_counts_as_omitted() -> None:
    # Still another person on the call (the desktop's evidence of a call), but with no address
    # the contract cannot list them.
    event = read(
        google_event(
            attendees=[
                {"email": "me@linkt.ai", "self": True},
                {"displayName": "Guest", "responseStatus": "accepted"},
            ]
        )
    )

    assert [attendee.email for attendee in event.attendees] == ["me@linkt.ai"]
    assert event.attendees_omitted is True


def test_missing_title_is_empty_and_spaces_are_trimmed() -> None:
    items = fixture_items()

    assert read(items["5h7allhands0001"]).title == ""
    assert read(items["2m4review0001"]).title == "Design review"


def test_ids_and_links_are_kept() -> None:
    event = read(fixture_items()["7q2standup0001_20261006T043000Z"])

    assert event.provider == "google"
    assert event.id == "7q2standup0001_20261006T043000Z"
    assert event.recurring_event_id == "7q2standup0001"
    assert event.ical_uid == "7q2standup0001@google.com"
    assert event.html_link is not None
    assert event.html_link.startswith("https://www.google.com/calendar/event?eid=")


def test_one_off_event_has_no_recurring_id() -> None:
    event = read(fixture_items()["9v3vendor0001"])

    assert event.recurring_event_id is None


def test_provider_name_is_the_callers() -> None:
    event = read_event(google_event(), provider="fake")

    assert event is not None
    assert event.provider == "fake"


# Video links: a link someone typed (the location, then the description) before the conference
# data Google adds (`hangoutLink`, then video entry points).

MEET = "https://meet.google.com/abc-defg-hij"
OTHER_MEET = "https://meet.google.com/xyz-wxyz-xyz"
ZOOM = "https://zoom.us/j/1234567890"
TEAMS = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0"


def conference(*entry_points: Json) -> Json:
    return {"entryPoints": list(entry_points)}


def test_video_link_typed_in_the_location_wins_over_an_auto_added_meet() -> None:
    # A Workspace org adds Meet to every new event; the user pasted the real call into the
    # location of a solo block. Conference first would hide the Zoom link: no prompt (a conference
    # link alone is not evidence of a call) and Join would open an empty Meet room.
    event = read(
        google_event(
            attendees=[],
            organizer={"email": "me@linkt.ai", "self": True},
            hangoutLink=MEET,
            conferenceData=conference({"entryPointType": "video", "uri": MEET}),
            location="https://us02web.zoom.us/j/81234567890?pwd=x",
        )
    )

    assert event.video_link == "https://us02web.zoom.us/j/81234567890?pwd=x"
    assert event.video_link_source == "location"


def test_video_link_typed_in_the_description_wins_over_conference_data() -> None:
    event = read(google_event(hangoutLink=MEET, description=f"Teams: {TEAMS}"))

    assert (event.video_link, event.video_link_source) == (TEAMS, "description")


def test_video_link_hangout_link_when_nothing_was_typed() -> None:
    event = read(
        google_event(
            hangoutLink=MEET,
            conferenceData=conference({"entryPointType": "video", "uri": OTHER_MEET}),
            location="Room 4B",
            description="Agenda in the doc",
        )
    )

    assert (event.video_link, event.video_link_source) == (MEET, "conference")


def test_video_link_entry_point_when_no_hangout_link() -> None:
    event = read(
        google_event(
            conferenceData=conference(
                {"entryPointType": "phone", "uri": "tel:+1-555-0100"},
                {"entryPointType": "video", "uri": ZOOM},
            ),
        )
    )

    assert (event.video_link, event.video_link_source) == (ZOOM, "conference")


def test_video_link_zoom_in_the_location() -> None:
    event = read(fixture_items()["9v3vendor0001"])

    assert event.video_link == "https://us02web.zoom.us/j/81234567890?pwd=AbC123"
    assert event.video_link_source == "location"


def test_video_link_teams_in_the_description() -> None:
    event = read(fixture_items()["2m4review0001"])

    assert event.video_link == (
        "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZmE0Y2Q%40thread.v2/0"
        "?context=%7b%22Tid%22%3a%22t1%22%7d&btype=a&role=a"
    )
    assert event.video_link_source == "description"


def test_video_link_location_before_description() -> None:
    event = read(google_event(location=f"Room 4 / {ZOOM}", description=f"Or {TEAMS}"))

    assert (event.video_link, event.video_link_source) == (ZOOM, "location")


def test_video_link_lookalike_host_in_the_description_is_ignored() -> None:
    event = read(fixture_items()["5h7allhands0001"])

    assert event.video_link is None
    assert event.video_link_source is None


def test_video_link_not_allowlisted_anywhere_is_none() -> None:
    event = read(
        google_event(
            hangoutLink="https://meet.google.com.evil.io/abc-defg-hij",
            conferenceData=conference({"entryPointType": "video", "uri": "https://evil.io/j/1"}),
            location="http://zoom.us/j/1234567890",
            description="https://zoom.us/s/1234567890",
        )
    )

    assert event.video_link is None
    assert event.video_link_source is None


# Unreadable events: the caller decides whether one bad event fails the whole answer.


@pytest.mark.parametrize(
    "item",
    [
        pytest.param(google_event(start=None), id="confirmed without a start"),
        pytest.param(google_event(end={"date": "2026-10-07"}), id="timed start, all-day end"),
        pytest.param(
            google_event(start={"dateTime": "2026-10-06T10:00:00"}), id="local time, no zone"
        ),
        pytest.param(
            google_event(start={"dateTime": "2026-10-06T10:00:00", "timeZone": "Mars/Olympus"}),
            id="unknown zone",
        ),
        pytest.param(google_event(start={"dateTime": "tomorrow"}), id="not a time"),
        pytest.param(google_event(id=""), id="empty id"),
        pytest.param({"summary": "no id"}, id="no id"),
        pytest.param(["not", "an", "event"], id="not an object"),
    ],
)
def test_unreadable_event_raises(item: JsonValue) -> None:
    with pytest.raises(UnreadableEventError) as raised:
        read_event(item, provider="google")

    # The message names the event and the problem, never its content (titles can be private).
    assert "Sync" not in str(raised.value)


def test_unreadable_event_names_its_id() -> None:
    with pytest.raises(UnreadableEventError) as raised:
        read_event(google_event(id="evt-42", start=None), provider="google")

    assert raised.value.event_id == "evt-42"
    assert "evt-42" in str(raised.value)


@pytest.mark.parametrize(
    "change",
    [
        pytest.param({"start_date": date(2026, 10, 6)}, id="timed with a date"),
        pytest.param({"start": datetime(2026, 10, 6, 10, 0)}, id="naive start"),  # noqa: DTZ001
        pytest.param({"all_day": True}, id="all-day with instants"),
        pytest.param({"video_link": None}, id="link source without a link"),
    ],
)
def test_event_type_refuses_inconsistent_fields(change: dict[str, object]) -> None:
    event = read(google_event(hangoutLink=MEET))

    with pytest.raises(ValueError, match="evt1"):
        replace(event, **change)  # type: ignore[arg-type]  # each value is right for its field
