"""Meetings that carry their calendar event and how they were started (M5-T4).

`POST /v1/meetings` takes `start_source` and an optional `calendar_event`; every meeting the API
returns carries both (docs/api-contract.md, `Meeting` and `POST /v1/meetings`). The event's ids and
times are columns of `meetings`, its attendees rows of `meeting_attendees`.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import event, func, select

from roger_api.db.engine import Database
from roger_api.db.models import Meeting, Workspace
from roger_api.db.models_calendar import MeetingAttendee
from roger_api.schemas.meetings import MAX_CALENDAR_TEXT_LENGTH, MAX_MEETING_ATTENDEES
from tests.helpers import (
    Json,
    append_segments,
    assert_error,
    create_meeting,
    post_ascii_json,
    segment_payload,
)

START_SOURCES = ["manual", "notification", "home", "tray", "call_detected"]


def attendee(name: str, **overrides: object) -> Json:
    return {
        "email": f"{name.lower()}@acme.com",
        "display_name": name,
        "response_status": "accepted",
        "is_self": False,
        "is_organizer": False,
        **overrides,
    }


def calendar_event(**overrides: object) -> Json:
    # Attendees out of alphabetical order, so a list sorted by email or name reads differently.
    return {
        "provider": "google",
        "event_id": "4kq0v9e8b1_20261006T100000Z",
        "ical_uid": "4kq0v9e8b1@google.com",
        "recurring_event_id": "4kq0v9e8b1",
        "scheduled_start": "2026-10-06T10:00:00Z",
        "scheduled_end": "2026-10-06T10:30:00Z",
        "attendees": [
            attendee("Zoe", email="rahul@linkt.ai", is_self=True, is_organizer=True),
            attendee("Jane", response_status="tentative"),
            attendee("Ali", display_name=None, response_status="needs_action"),
            attendee("Bo", response_status="declined"),
        ],
        **overrides,
    }


def database_of(app: FastAPI) -> Database:
    database = app.state.database
    assert isinstance(database, Database)
    return database


async def stored_attendees(app: FastAPI, meeting_id: str | UUID) -> list[MeetingAttendee]:
    async with database_of(app).session() as session:
        rows = await session.scalars(
            select(MeetingAttendee)
            .where(MeetingAttendee.meeting_id == UUID(str(meeting_id)))
            .order_by(MeetingAttendee.position)
        )
        return list(rows)


@contextmanager
def recorded_statements(database: Database) -> Iterator[list[str]]:
    """The SQL of every statement the API sends to Postgres while the block runs."""
    statements: list[str] = []

    def record(
        connection: object,
        cursor: object,
        statement: str,
        parameters: object,
        context: object,
        executemany: bool,
    ) -> None:
        statements.append(statement)

    engine = database.engine.sync_engine
    event.listen(engine, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", record)


# ---------------------------------------------------------------------------- create


async def test_create_with_an_event_stores_its_ids_times_and_attendees_in_order(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    event_link = calendar_event()

    created = await client.post(
        "/v1/meetings",
        json={"title": "Weekly sync", "start_source": "notification", "calendar_event": event_link},
    )

    assert created.status_code == 201, created.text
    meeting = created.json()
    assert meeting["start_source"] == "notification"
    assert meeting["calendar_event"] == event_link
    assert (await client.get(f"/v1/meetings/{meeting['id']}")).json() == meeting
    rows = await stored_attendees(app, meeting["id"])
    assert [(row.position, row.email) for row in rows] == [
        (0, "rahul@linkt.ai"),
        (1, "jane@acme.com"),
        (2, "ali@acme.com"),
        (3, "bo@acme.com"),
    ]
    # House rule 2: each attendee row carries its meeting's workspace.
    assert {row.workspace_id for row in rows} == {UUID(meeting["workspace_id"])}


async def test_scheduled_times_are_returned_in_utc(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(
        client,
        calendar_event=calendar_event(
            scheduled_start="2026-10-06T15:30:00+05:30", scheduled_end="2026-10-06T06:30:00-04:00"
        ),
    )

    assert meeting["calendar_event"]["scheduled_start"] == "2026-10-06T10:00:00Z"
    assert meeting["calendar_event"]["scheduled_end"] == "2026-10-06T10:30:00Z"


async def test_an_event_with_no_attendees_keeps_an_empty_list(client: httpx.AsyncClient) -> None:
    # A solo block with a Zoom link in its location still prompts, and has nobody on the invite.
    meeting = await create_meeting(client, calendar_event=calendar_event(attendees=[]))

    assert meeting["calendar_event"]["attendees"] == []


async def test_without_a_link_start_source_is_manual_and_the_event_null(
    client: httpx.AsyncClient,
) -> None:
    meeting = await create_meeting(client)

    assert meeting["start_source"] == "manual"
    assert meeting["calendar_event"] is None


@pytest.mark.parametrize("start_source", START_SOURCES)
async def test_every_start_source_is_accepted(client: httpx.AsyncClient, start_source: str) -> None:
    # `call_detected` is M2's call offer: accepted from the start, so M2 adds no migration.
    meeting = await create_meeting(client, start_source=start_source)

    assert meeting["start_source"] == start_source


async def test_blank_optional_ids_and_names_are_stored_as_null(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    # M6 matches two teammates' notes of one call by iCal UID: two "" UIDs would match calls that
    # have nothing to do with each other.
    meeting = await create_meeting(
        client,
        calendar_event=calendar_event(
            ical_uid="  ", recurring_event_id="", attendees=[attendee("Jane", display_name=" ")]
        ),
    )

    link = meeting["calendar_event"]
    assert link["ical_uid"] is None
    assert link["recurring_event_id"] is None
    assert link["attendees"][0]["display_name"] is None
    async with database_of(app).session() as session:
        stored = await session.get_one(Meeting, UUID(meeting["id"]))
    assert stored.calendar_ical_uid is None
    assert stored.calendar_recurring_event_id is None


async def test_nul_characters_are_dropped_from_the_link(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    # Postgres `text` cannot hold U+0000: kept, it failed the insert with a 500, and the uploader
    # retried a create that could never succeed. A hand-built client or a FAKE_CALENDAR_FILE can
    # send one; Google does not.
    meeting = await create_meeting(
        client,
        calendar_event=calendar_event(
            event_id="evt\x00-1",
            ical_uid="uid\x00@google.com",
            recurring_event_id=" \x00 ",
            attendees=[
                attendee("Jane", email="jane\x00@acme.com", display_name="Ja\x00ne"),
                attendee("Ali", display_name="\x00"),
            ],
        ),
    )

    link = meeting["calendar_event"]
    assert link["event_id"] == "evt-1"
    assert link["ical_uid"] == "uid@google.com"
    # NUL and whitespace only is blank, so null, as in the test above.
    assert link["recurring_event_id"] is None
    assert [(guest["email"], guest["display_name"]) for guest in link["attendees"]] == [
        ("jane@acme.com", "Jane"),
        ("ali@acme.com", None),
    ]
    assert [row.display_name for row in await stored_attendees(app, meeting["id"])] == [
        "Jane",
        None,
    ]


async def test_unpaired_surrogates_in_the_link_are_stored_as_u_fffd(
    client: httpx.AsyncClient,
) -> None:
    # UTF-8 cannot hold half an emoji, which JSON.stringify sends as an escape. Refused with a 422,
    # it kept the meeting off the server, as a U+0000 did (the test above).
    link = calendar_event(
        event_id="evt-\ud83d",
        attendees=[attendee("Jane", display_name="Jane \udc00")],
    )

    response = await post_ascii_json(client, "/v1/meetings", {"calendar_event": link})

    assert response.status_code == 201, response.text
    stored = response.json()["calendar_event"]
    assert stored["event_id"] == "evt-\ufffd"
    assert stored["attendees"][0]["display_name"] == "Jane \ufffd"


def with_attendee(**overrides: object) -> Json:
    return calendar_event(attendees=[attendee("Jane"), attendee("Ali", **overrides)])


def without(field: str) -> Json:
    link = calendar_event()
    del link[field]
    return link


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({"start_source": "calendar"}, "body.start_source"),
        ({"start_source": None}, "body.start_source"),
        ({"calendar_event": calendar_event(provider="outlook")}, "body.calendar_event.provider"),
        ({"calendar_event": without("provider")}, "body.calendar_event.provider"),
        ({"calendar_event": calendar_event(event_id="")}, "body.calendar_event.event_id"),
        ({"calendar_event": calendar_event(event_id="\x00")}, "body.calendar_event.event_id"),
        ({"calendar_event": without("event_id")}, "body.calendar_event.event_id"),
        (
            {"calendar_event": calendar_event(event_id="x" * (MAX_CALENDAR_TEXT_LENGTH + 1))},
            "body.calendar_event.event_id",
        ),
        (
            {"calendar_event": calendar_event(ical_uid="x" * (MAX_CALENDAR_TEXT_LENGTH + 1))},
            "body.calendar_event.ical_uid",
        ),
        (
            {"calendar_event": calendar_event(scheduled_start="2026-10-06T10:00:00")},
            "body.calendar_event.scheduled_start",
        ),
        ({"calendar_event": without("scheduled_end")}, "body.calendar_event.scheduled_end"),
        ({"calendar_event": without("attendees")}, "body.calendar_event.attendees"),
        (
            {"calendar_event": with_attendee(response_status="maybe")},
            "body.calendar_event.attendees[1].response_status",
        ),
        ({"calendar_event": with_attendee(email=" ")}, "body.calendar_event.attendees[1].email"),
        (
            {"calendar_event": with_attendee(email="\x00 ")},
            "body.calendar_event.attendees[1].email",
        ),
        (
            {"calendar_event": with_attendee(display_name="x" * (MAX_CALENDAR_TEXT_LENGTH + 1))},
            "body.calendar_event.attendees[1].display_name",
        ),
        (
            {"calendar_event": with_attendee(is_self=None)},
            "body.calendar_event.attendees[1].is_self",
        ),
    ],
)
async def test_create_validation_errors(client: httpx.AsyncClient, body: Json, field: str) -> None:
    # meetings.calendar_provider and meeting_attendees.response_status have no check constraint:
    # these refusals are the only guard on what they hold.
    message = assert_error(await client.post("/v1/meetings", json=body), 422, "validation_error")

    assert field in message


async def test_attendees_are_limited_to_200(app: FastAPI, client: httpx.AsyncClient) -> None:
    everyone = [attendee(f"Person{n:03}") for n in range(MAX_MEETING_ATTENDEES + 1)]

    refused = await client.post(
        "/v1/meetings", json={"calendar_event": calendar_event(attendees=everyone)}
    )
    accepted = await create_meeting(
        client, calendar_event=calendar_event(attendees=everyone[:MAX_MEETING_ATTENDEES])
    )

    assert MAX_MEETING_ATTENDEES == 200
    assert "body.calendar_event.attendees" in assert_error(refused, 422, "validation_error")
    assert accepted["calendar_event"]["attendees"] == everyone[:MAX_MEETING_ATTENDEES]
    assert len(await stored_attendees(app, accepted["id"])) == MAX_MEETING_ATTENDEES


# ---------------------------------------------------------------------------- re-sends


async def test_a_resend_with_another_link_returns_the_stored_row_unchanged(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    meeting_id = str(uuid4())
    first = await create_meeting(
        client, id=meeting_id, start_source="notification", calendar_event=calendar_event()
    )
    other_event = calendar_event(
        event_id="other-event", ical_uid=None, attendees=[attendee("Someone")]
    )

    relinked = await client.post(
        "/v1/meetings",
        json={"id": meeting_id, "start_source": "tray", "calendar_event": other_event},
    )
    unlinked = await client.post("/v1/meetings", json={"id": meeting_id})

    assert relinked.status_code == 200
    assert relinked.json() == first
    assert unlinked.status_code == 200
    assert unlinked.json() == first
    assert len(await stored_attendees(app, meeting_id)) == len(calendar_event()["attendees"])


async def test_a_link_sent_only_on_a_resend_is_not_stored(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    first = await create_meeting(client)

    again = await client.post(
        "/v1/meetings",
        json={
            "id": first["id"],
            "start_source": "notification",
            "calendar_event": calendar_event(),
        },
    )

    assert again.status_code == 200
    assert again.json() == first
    assert await stored_attendees(app, first["id"]) == []


# ---------------------------------------------------------------------------- reads


async def test_every_meeting_response_carries_the_link(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(
        client,
        start_source="home",
        calendar_event=calendar_event(),
        started_at="2026-10-06T10:01:00Z",
    )
    await append_segments(client, meeting["id"], segment_payload())
    expected = {"start_source": "home", "calendar_event": calendar_event()}

    listed = (await client.get("/v1/meetings")).json()["items"][0]
    fetched = (await client.get(f"/v1/meetings/{meeting['id']}")).json()
    transcript = (await client.get(f"/v1/meetings/{meeting['id']}/transcript")).json()["meeting"]
    ended = (await client.post(f"/v1/meetings/{meeting['id']}/end")).json()

    for returned in (listed, fetched, transcript, ended):
        assert {key: returned[key] for key in expected} == expected


async def test_a_page_loads_attendees_in_one_extra_query(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    # One query per page, never one per meeting: a page of 200 linked meetings would otherwise be
    # 201 round trips.
    sent: dict[str, Json] = {}
    for n in range(3):
        link = calendar_event(
            event_id=f"event-{n}", attendees=[attendee(f"Guest{n}"), attendee(f"Other{n}")]
        )
        meeting = await create_meeting(
            client, calendar_event=link, started_at=f"2026-10-06T1{n}:00:00Z"
        )
        sent[meeting["id"]] = link
    unlinked = await create_meeting(client, started_at="2026-10-06T09:00:00Z")

    with recorded_statements(database_of(app)) as statements:
        response = await client.get("/v1/meetings")

    items = response.json()["items"]
    assert [item["calendar_event"] for item in items] == [*reversed(sent.values()), None]
    assert items[-1]["id"] == unlinked["id"]
    attendee_reads = [sql for sql in statements if "meeting_attendees" in sql]
    assert len(attendee_reads) == 1, statements
    assert len(statements) == 2, statements


async def test_attendees_never_cross_workspaces(app: FastAPI, client: httpx.AsyncClient) -> None:
    mine = await create_meeting(client, calendar_event=calendar_event())
    foreign_workspace_id, foreign_meeting_id = uuid4(), uuid4()
    async with database_of(app).session() as session:
        session.add(Workspace(id=foreign_workspace_id, name="Someone else"))
        await session.flush()
        session.add(
            Meeting(
                id=foreign_meeting_id,
                workspace_id=foreign_workspace_id,
                title="Not yours",
                status="recording",
                started_at=datetime(2026, 10, 7, tzinfo=UTC),
                calendar_provider="google",
                calendar_event_id="their-event",
                scheduled_start_at=datetime(2026, 10, 7, tzinfo=UTC),
                scheduled_end_at=datetime(2026, 10, 7, 1, tzinfo=UTC),
            )
        )
        await session.flush()
        for meeting_id, position in ((foreign_meeting_id, 0), (UUID(mine["id"]), 99)):
            # The second row hangs off this workspace's meeting but belongs to another workspace:
            # only the workspace filter keeps it out (house rule 2).
            session.add(
                MeetingAttendee(
                    id=uuid4(),
                    workspace_id=foreign_workspace_id,
                    meeting_id=meeting_id,
                    position=position,
                    email="secret@elsewhere.com",
                    display_name="Secret",
                    response_status="accepted",
                    is_self=False,
                    is_organizer=False,
                )
            )
        await session.commit()

    listed = (await client.get("/v1/meetings")).json()["items"]
    fetched = (await client.get(f"/v1/meetings/{mine['id']}")).json()
    taken = await client.post(
        "/v1/meetings", json={"id": str(foreign_meeting_id), "calendar_event": calendar_event()}
    )

    assert [item["id"] for item in listed] == [mine["id"]]
    assert listed[0]["calendar_event"] == calendar_event()
    assert fetched["calendar_event"] == calendar_event()
    # Another workspace's meeting id is a 404, and the link in that create is not stored under it.
    assert_error(taken, 404, "not_found")
    async with database_of(app).session() as session:
        foreign_rows = await session.scalar(
            select(func.count())
            .select_from(MeetingAttendee)
            .where(MeetingAttendee.meeting_id == foreign_meeting_id)
        )
    assert foreign_rows == 1
