"""The fake calendar provider (M5-T2): `CALENDAR_PROVIDER=fake`, the default.

The whole sign-in round trip and every calendar screen run on it with no Google client (M5 plan,
Design, "Fake provider").
"""

import json
import time
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from roger_api.errors import CalendarReconnectRequiredError
from roger_api.services.calendar.fake import (
    FAKE_ACCOUNT_EMAIL,
    FAKE_CODE,
    FakeCalendarProvider,
)
from roger_api.services.calendar.google import CALENDAR_SCOPE
from roger_api.services.calendar.provider import CalendarEvent, CalendarProvider

FIXTURE = Path(__file__).parent / "fixtures" / "calendar" / "fake_calendar.json"
IST = timezone(timedelta(hours=5, minutes=30))
# The API started at 09:41:17.250 in Bangalore.
STARTED_AT = datetime(2026, 10, 6, 4, 11, 17, 250_000, tzinfo=UTC)
ANCHOR = STARTED_AT.replace(microsecond=0)
REDIRECT_URI = "http://127.0.0.1:53682/oauth/callback"
WIDE_MIN = STARTED_AT - timedelta(hours=36)
WIDE_MAX = STARTED_AT + timedelta(hours=36)


def fake(events_file: Path | None = None) -> FakeCalendarProvider:
    return FakeCalendarProvider(started_at=STARTED_AT, local_zone=IST, events_file=events_file)


async def built_in_events() -> dict[str, CalendarEvent]:
    events = await fake().list_events("fake-token", time_min=WIDE_MIN, time_max=WIDE_MAX)
    return {event.id: event for event in events}


def test_fake_is_a_calendar_provider() -> None:
    calendar: CalendarProvider = fake()

    assert calendar.provider == "fake"


# Sign-in -----------------------------------------------------------------------------------------


def test_authorization_url_is_the_redirect_with_code_fake_and_the_same_state() -> None:
    url = fake().authorization_url(
        redirect_uri=REDIRECT_URI, code_challenge="challenge", state="st-8f2c"
    )

    parts = urlsplit(url)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == REDIRECT_URI
    assert parse_qs(parts.query, strict_parsing=True) == {"code": ["fake"], "state": ["st-8f2c"]}
    assert FAKE_CODE == "fake"


def test_authorization_url_keeps_a_query_the_redirect_already_has() -> None:
    url = fake().authorization_url(
        redirect_uri=f"{REDIRECT_URI}?attempt=2", code_challenge="challenge", state="s 1&x"
    )

    assert parse_qs(urlsplit(url).query, strict_parsing=True) == {
        "attempt": ["2"],
        "code": ["fake"],
        "state": ["s 1&x"],
    }


async def test_exchange_of_the_fake_code_is_a_grant_with_no_refresh_token() -> None:
    grant = await fake().exchange_code(
        code=FAKE_CODE, code_verifier="verifier", redirect_uri=REDIRECT_URI
    )

    assert grant.account_email == FAKE_ACCOUNT_EMAIL
    assert CALENDAR_SCOPE in grant.scopes
    # calendar_connections.refresh_token is NULL only for the fake provider (M5 plan, Postgres).
    assert grant.refresh_token is None
    assert grant.access_token.expires_in_seconds > 0


async def test_exchange_of_another_code_is_refused_like_google() -> None:
    with pytest.raises(CalendarReconnectRequiredError):
        await fake().exchange_code(code="4/real", code_verifier="v", redirect_uri=REDIRECT_URI)


async def test_refresh_and_revoke_need_no_stored_token() -> None:
    token = await fake().refresh(None)

    assert token.expires_in_seconds > 0
    await fake().revoke(None)


# Built-in events ---------------------------------------------------------------------------------


async def test_events_are_stable_between_calls() -> None:
    calendar = fake()

    first = await calendar.list_events("t", time_min=WIDE_MIN, time_max=WIDE_MAX)
    second = await calendar.list_events("t", time_min=WIDE_MIN, time_max=WIDE_MAX)

    assert first == second
    assert len(first) == 7


async def test_a_call_two_minutes_after_start_with_three_attendees_and_a_meet_link() -> None:
    call = (await built_in_events())["fake-call"]

    assert call.start == ANCHOR + timedelta(minutes=2)
    assert call.end == ANCHOR + timedelta(minutes=32)
    assert len(call.attendees) == 3
    assert call.self_response == "accepted"
    assert call.video_link is not None
    assert call.video_link.startswith("https://meet.google.com/")
    assert call.video_link_source == "conference"
    assert call.provider == "fake"


async def test_an_all_day_item_on_todays_local_date() -> None:
    all_day = (await built_in_events())["fake-all-day"]

    assert all_day.all_day is True
    assert all_day.start_date == date(2026, 10, 6)
    assert all_day.end_date == date(2026, 10, 7)


async def test_a_declined_call() -> None:
    declined = (await built_in_events())["fake-declined"]

    assert declined.self_response == "declined"
    assert len(declined.attendees) > 1


async def test_a_solo_block_with_an_auto_added_meet_link() -> None:
    focus = (await built_in_events())["fake-focus"]

    assert focus.attendees == ()
    assert focus.attendees_omitted is False
    assert focus.self_response == "organizer"
    assert focus.video_link_source == "conference"


async def test_a_solo_block_with_a_zoom_link_in_the_location() -> None:
    # The script gives it an auto-added Meet link too: the typed Zoom link must still win.
    solo = (await built_in_events())["fake-solo-zoom"]

    assert solo.attendees == ()
    assert solo.video_link is not None
    assert solo.video_link.startswith("https://us02web.zoom.us/j/")
    assert solo.video_link_source == "location"


async def test_a_moved_recurring_instance() -> None:
    events = await built_in_events()
    [standup] = [event for event in events.values() if event.recurring_event_id is not None]

    original = ANCHOR + timedelta(minutes=30)
    assert standup.recurring_event_id == "fake-standup"
    # Google names an instance after its original start; this one was moved 15 minutes later.
    assert standup.id == f"fake-standup_{original:%Y%m%dT%H%M%SZ}"
    assert standup.start == original + timedelta(minutes=15)


async def test_one_tomorrow() -> None:
    tomorrow = (await built_in_events())["fake-tomorrow"]

    assert tomorrow.start == ANCHOR + timedelta(days=1)
    assert tomorrow.video_link_source == "description"


async def test_events_are_ordered_by_start() -> None:
    events = await fake().list_events("t", time_min=WIDE_MIN, time_max=WIDE_MAX)

    assert [event.id for event in events] == [
        "fake-all-day",
        "fake-call",
        f"fake-standup_{ANCHOR + timedelta(minutes=30):%Y%m%dT%H%M%SZ}",
        "fake-declined",
        "fake-focus",
        "fake-solo-zoom",
        "fake-tomorrow",
    ]


async def test_window_bounds_are_exclusive_like_google() -> None:
    # Google: an event is listed when it ends after timeMin and starts before timeMax.
    call_start, call_end = ANCHOR + timedelta(minutes=2), ANCHOR + timedelta(minutes=32)

    ids_ending = {e.id for e in await fake().list_events("t", time_min=call_end, time_max=WIDE_MAX)}
    ids_starting = {
        e.id for e in await fake().list_events("t", time_min=WIDE_MIN, time_max=call_start)
    }

    assert "fake-call" not in ids_ending
    assert "fake-call" not in ids_starting
    assert "fake-all-day" in ids_starting


async def test_all_day_item_spans_local_midnight_to_midnight() -> None:
    # 2026-10-06 in IST is 2026-10-05T18:30Z to 2026-10-06T18:30Z.
    local_midnight = datetime(2026, 10, 6, 0, 0, tzinfo=IST)

    before = await fake().list_events(
        "t", time_min=local_midnight - timedelta(hours=1), time_max=local_midnight
    )
    after = await fake().list_events(
        "t",
        time_min=local_midnight + timedelta(days=1),
        time_max=local_midnight + timedelta(days=1, hours=1),
    )

    assert "fake-all-day" not in {event.id for event in before}
    assert "fake-all-day" not in {event.id for event in after}


async def test_naive_bound_is_refused() -> None:
    with pytest.raises(ValueError, match="time zone"):
        await fake().list_events(
            "t",
            time_min=datetime(2026, 10, 6),  # noqa: DTZ001 - the naive bound under test
            time_max=WIDE_MAX,
        )


def test_start_time_must_carry_a_zone() -> None:
    with pytest.raises(ValueError, match="time zone"):
        FakeCalendarProvider(started_at=datetime(2026, 10, 6, 9, 0))  # noqa: DTZ001


def test_local_zone_defaults_to_the_machines() -> None:
    calendar = FakeCalendarProvider(started_at=STARTED_AT)

    assert calendar.today == STARTED_AT.astimezone().date()


@pytest.fixture
def machine_in_los_angeles(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("TZ", "America/Los_Angeles")
    time.tzset()
    # Proof the switch took, or the test passes with nothing to prove.
    assert datetime(2026, 7, 1, tzinfo=UTC).astimezone().utcoffset() == timedelta(hours=-7)
    yield
    monkeypatch.undo()
    time.tzset()


@pytest.mark.usefixtures("machine_in_los_angeles")
async def test_default_zone_reads_each_date_with_its_own_daylight_saving(tmp_path: Path) -> None:
    # Started on 2026-10-31 (PDT, -07:00). 2026-11-02 falls after the change to PST (-08:00), so
    # its local midnight is 08:00Z; the offset at start-up would put it at 07:00Z.
    path = tmp_path / "calendar.json"
    holiday = {"id": "holiday", "start": {"date": "2026-11-02"}, "end": {"date": "2026-11-03"}}
    path.write_text(json.dumps({"items": [holiday]}), encoding="utf-8")
    calendar = FakeCalendarProvider(
        started_at=datetime(2026, 10, 31, 18, 0, tzinfo=UTC), events_file=path
    )
    midnight = datetime(2026, 11, 2, 8, 0, tzinfo=UTC)
    window_start = midnight - timedelta(hours=36)

    before = await calendar.list_events(
        "t", time_min=window_start, time_max=midnight - timedelta(minutes=30)
    )
    after = await calendar.list_events(
        "t", time_min=window_start, time_max=midnight + timedelta(minutes=30)
    )

    assert before == []
    assert [event.id for event in after] == ["holiday"]


# FAKE_CALENDAR_FILE ------------------------------------------------------------------------------


async def test_file_replaces_the_built_in_events() -> None:
    events = await fake(FIXTURE).list_events(
        "t",
        time_min=datetime(2026, 10, 1, tzinfo=UTC),
        time_max=datetime(2026, 12, 1, tzinfo=UTC),
    )

    assert [event.id for event in events] == ["file-retro", "file-board-meeting", "file-holiday"]
    assert {event.provider for event in events} == {"fake"}
    board = events[1]
    assert board.start == datetime(2026, 10, 6, 9, 30, tzinfo=UTC)
    assert board.video_link == "https://example.zoom.us/j/81234567890?pwd=board"


async def test_file_events_are_filtered_by_the_window() -> None:
    events = await fake(FIXTURE).list_events(
        "t",
        time_min=datetime(2026, 10, 6, 9, 0, tzinfo=UTC),
        time_max=datetime(2026, 10, 6, 10, 0, tzinfo=UTC),
    )

    assert [event.id for event in events] == ["file-board-meeting"]


@pytest.mark.parametrize(
    ("content", "problem"),
    [
        pytest.param(None, "cannot be read", id="missing"),
        pytest.param("{not json", "not an events.list page", id="not json"),
        pytest.param('{"items": "x"}', "not an events.list page", id="items not a list"),
        pytest.param(
            json.dumps({"items": [{"id": "e1", "status": "confirmed"}]}),
            "item 0",
            id="an unreadable event",
        ),
    ],
)
def test_a_bad_file_fails_at_startup_naming_the_file(
    tmp_path: Path, content: str | None, problem: str
) -> None:
    path = tmp_path / "calendar.json"
    if content is not None:
        path.write_text(content, encoding="utf-8")

    with pytest.raises(ValueError, match="FAKE_CALENDAR_FILE") as raised:
        fake(path)

    assert str(path) in str(raised.value)
    assert problem in str(raised.value)
