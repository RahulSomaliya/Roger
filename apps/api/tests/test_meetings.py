from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text

from roger_api.auth import default_principal
from roger_api.config import Settings
from roger_api.db.engine import Database
from roger_api.services.meetings import _with_segment_count
from tests.helpers import Json, append_segments, assert_error, create_meeting, segment_payload

STARTED_AT = "2026-10-05T10:00:00Z"


def parse_instant(value: str) -> datetime:
    assert value.endswith("Z"), value
    return datetime.fromisoformat(value)


# ---------------------------------------------------------------------------- create


async def test_create_is_201_then_200_for_the_same_id(client: httpx.AsyncClient) -> None:
    meeting_id = str(uuid4())
    body = {"id": meeting_id, "title": "Weekly sync with Acme", "started_at": STARTED_AT}

    created = await client.post("/v1/meetings", json=body)
    again = await client.post("/v1/meetings", json={**body, "title": "Retried with a new title"})

    assert created.status_code == 201
    assert again.status_code == 200
    assert again.json() == created.json()
    meeting = created.json()
    assert meeting["id"] == meeting_id
    assert meeting["title"] == "Weekly sync with Acme"
    assert meeting["status"] == "recording"
    assert meeting["started_at"] == STARTED_AT
    assert meeting["ended_at"] is None
    assert meeting["segment_count"] == 0
    assert set(meeting) == {
        "id",
        "workspace_id",
        "title",
        "status",
        "started_at",
        "ended_at",
        "segment_count",
        "start_source",
        "calendar_event",
        "created_at",
        "updated_at",
    }
    parse_instant(meeting["created_at"])
    parse_instant(meeting["updated_at"])


async def test_create_fills_defaults(client: httpx.AsyncClient) -> None:
    before = datetime.now(UTC)

    meeting = await create_meeting(client)

    UUID(meeting["id"])
    assert meeting["title"] == "Untitled meeting"
    assert (
        before - timedelta(seconds=1) <= parse_instant(meeting["started_at"]) <= datetime.now(UTC)
    )


@pytest.mark.parametrize("title", ["", "   ", None])
async def test_blank_title_gets_the_default(client: httpx.AsyncClient, title: str | None) -> None:
    meeting = await create_meeting(client, title=title)

    assert meeting["title"] == "Untitled meeting"


async def test_started_at_is_returned_in_utc(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client, started_at="2026-10-05T12:00:00+02:00")

    assert meeting["started_at"] == "2026-10-05T10:00:00Z"


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({"id": "not-a-uuid"}, "body.id"),
        ({"started_at": "2026-10-05T10:00:00"}, "body.started_at"),
        ({"title": "x" * 501}, "body.title"),
    ],
)
async def test_create_validation_errors(client: httpx.AsyncClient, body: Json, field: str) -> None:
    message = assert_error(await client.post("/v1/meetings", json=body), 422, "validation_error")

    assert field in message


# ---------------------------------------------------------------------------- list and get


async def test_list_is_newest_first_and_pages_with_before(client: httpx.AsyncClient) -> None:
    base = datetime(2026, 10, 5, 9, 0, tzinfo=UTC)
    for hour in (1, 3, 2):
        await create_meeting(
            client, title=f"Meeting {hour}", started_at=(base + timedelta(hours=hour)).isoformat()
        )

    everything = (await client.get("/v1/meetings")).json()["items"]
    first_page = (await client.get("/v1/meetings", params={"limit": 2})).json()["items"]
    second_page = (
        await client.get(
            "/v1/meetings", params={"limit": 2, "before": first_page[-1]["started_at"]}
        )
    ).json()["items"]

    assert [m["title"] for m in everything] == ["Meeting 3", "Meeting 2", "Meeting 1"]
    assert [m["title"] for m in first_page] == ["Meeting 3", "Meeting 2"]
    assert [m["title"] for m in second_page] == ["Meeting 1"]


async def page_through(client: httpx.AsyncClient, *, limit: int) -> list[Json]:
    """Every meeting, following the contract's cursor: the last item's started_at and id."""
    params: dict[str, str | int] = {"limit": limit}
    seen: list[Json] = []
    for _ in range(20):
        page: list[Json] = (await client.get("/v1/meetings", params=params)).json()["items"]
        if not page:
            return seen
        seen.extend(page)
        params = {"limit": limit, "before": page[-1]["started_at"], "before_id": page[-1]["id"]}
    raise AssertionError(f"paging did not end after 20 pages: {[m['id'] for m in seen]}")


async def test_paging_keeps_meetings_that_share_a_started_at(client: httpx.AsyncClient) -> None:
    # A cursor of started_at alone skipped the second of two meetings that started together.
    created = [await create_meeting(client, started_at=STARTED_AT) for _ in range(3)]
    later = await create_meeting(client, started_at="2026-10-05T11:00:00Z")

    paged = await page_through(client, limit=1)

    same_start_newest_id_first = sorted((m["id"] for m in created), reverse=True)
    assert [m["id"] for m in paged] == [later["id"], *same_start_newest_id_first]


async def test_paging_with_microsecond_start_times(client: httpx.AsyncClient) -> None:
    # The cursor is the started_at the API returned, so it must round-trip at full precision.
    # All three start inside one millisecond: a started_at cut to milliseconds sorts before every
    # one of them, so page 2 comes back empty and the oldest meeting is never listed.
    starts = [f"2026-10-05T10:00:00.000{n}00Z" for n in (1, 2, 3)]
    created = [await create_meeting(client, started_at=start) for start in starts]

    paged = await page_through(client, limit=2)

    assert [m["id"] for m in paged] == [m["id"] for m in reversed(created)]
    assert [m["started_at"] for m in paged] == starts[::-1]


@pytest.mark.parametrize(
    ("params", "field"),
    [
        ({"limit": 0}, "query.limit"),
        ({"limit": 201}, "query.limit"),
        ({"before": "yesterday"}, "query.before"),
        ({"before": STARTED_AT, "before_id": "not-a-uuid"}, "query.before_id"),
        ({"before_id": "7f3c2d1e-0000-4000-8000-000000000001"}, "query.before"),
    ],
)
async def test_list_validation_errors(
    client: httpx.AsyncClient, params: dict[str, str | int], field: str
) -> None:
    response = await client.get("/v1/meetings", params=params)

    assert field in assert_error(response, 422, "validation_error")


async def test_segment_counts_are_read_from_the_meeting_index(
    app: FastAPI, settings: Settings, client: httpx.AsyncClient
) -> None:
    # Pins the plan, not the numbers: joining on workspace_id in the count made Postgres read
    # every segment row of every listed meeting instead of counting index entries.
    meeting = await create_meeting(client)
    await append_segments(client, meeting["id"], segment_payload(), segment_payload())
    database = app.state.database
    assert isinstance(database, Database)
    query = _with_segment_count(default_principal(settings))
    sql = query.compile(dialect=database.engine.dialect, compile_kwargs={"literal_binds": True})

    async with database.session() as session:
        # A test table is tiny, so without these the planner scans it whole and proves nothing.
        await session.execute(text("SET LOCAL enable_seqscan = off"))
        await session.execute(text("SET LOCAL enable_bitmapscan = off"))
        plan = "\n".join((await session.execute(text(f"EXPLAIN {sql}"))).scalars())

    assert "Index Only Scan using ix_transcript_segments_meeting_id_start_ms" in plan, plan


async def test_get_meeting(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client, title="Design review")

    response = await client.get(f"/v1/meetings/{meeting['id']}")

    assert response.status_code == 200
    assert response.json() == meeting


async def test_get_unknown_meeting_is_404(client: httpx.AsyncClient) -> None:
    meeting_id = uuid4()

    message = assert_error(await client.get(f"/v1/meetings/{meeting_id}"), 404, "not_found")

    assert message == f"Meeting {meeting_id} not found"


async def test_get_malformed_id_is_422(client: httpx.AsyncClient) -> None:
    assert_error(await client.get("/v1/meetings/not-a-uuid"), 422, "validation_error")


# ---------------------------------------------------------------------------- end


async def test_end_is_idempotent(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client, started_at=STARTED_AT)
    url = f"/v1/meetings/{meeting['id']}/end"

    first = await client.post(url, json={"ended_at": "2026-10-05T10:31:12Z"})
    second = await client.post(url, json={"ended_at": "2026-10-05T11:00:00Z"})

    assert first.status_code == 200
    assert first.json()["status"] == "ended"
    assert first.json()["ended_at"] == "2026-10-05T10:31:12Z"
    assert second.status_code == 200
    assert second.json() == first.json()


async def test_end_without_body_uses_now(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client)
    before = datetime.now(UTC)

    response = await client.post(f"/v1/meetings/{meeting['id']}/end")

    assert response.status_code == 200
    ended_at = parse_instant(response.json()["ended_at"])
    assert before - timedelta(seconds=1) <= ended_at <= datetime.now(UTC)
    assert parse_instant(response.json()["updated_at"]) >= parse_instant(meeting["updated_at"])


async def test_end_unknown_meeting_is_404(client: httpx.AsyncClient) -> None:
    assert_error(await client.post(f"/v1/meetings/{uuid4()}/end"), 404, "not_found")


# ---------------------------------------------------------------------------- segments


async def test_segments_are_idempotent(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client)
    first, second, third = (segment_payload(start_ms=n * 1000, end_ms=n * 1000) for n in (1, 2, 3))

    initial = await append_segments(client, meeting["id"], first, second)
    retried = await append_segments(client, meeting["id"], first, second, third)
    repeated_in_batch = await append_segments(client, meeting["id"], third, third)

    assert initial == {"accepted": 2, "duplicates": 0}
    assert retried == {"accepted": 1, "duplicates": 2}
    assert repeated_in_batch == {"accepted": 0, "duplicates": 2}
    counted = (await client.get(f"/v1/meetings/{meeting['id']}")).json()
    assert counted["segment_count"] == 3


async def test_resent_segment_with_new_text_is_a_duplicate_and_keeps_the_stored_text(
    client: httpx.AsyncClient,
) -> None:
    # The contract matches re-sends by id alone: no 409 for a changed body.
    meeting = await create_meeting(client)
    original = segment_payload(text="First take.")
    await append_segments(client, meeting["id"], original)

    resent = await append_segments(client, meeting["id"], {**original, "text": "Second take."})

    assert resent == {"accepted": 0, "duplicates": 1}
    transcript = (await client.get(f"/v1/meetings/{meeting['id']}/transcript")).json()
    assert [s["text"] for s in transcript["segments"]] == ["First take."]


async def test_segment_id_from_another_meeting_is_409_and_nothing_is_stored(
    client: httpx.AsyncClient,
) -> None:
    first_meeting = await create_meeting(client)
    second_meeting = await create_meeting(client)
    shared = segment_payload()
    await append_segments(client, first_meeting["id"], shared)

    response = await client.post(
        f"/v1/meetings/{second_meeting['id']}/segments",
        json={"segments": [segment_payload(), shared]},
    )

    assert_error(response, 409, "conflict")
    second = (await client.get(f"/v1/meetings/{second_meeting['id']}")).json()
    assert second["segment_count"] == 0


async def test_segments_for_unknown_meeting_is_404(client: httpx.AsyncClient) -> None:
    response = await client.post(
        f"/v1/meetings/{uuid4()}/segments", json={"segments": [segment_payload()]}
    )

    assert_error(response, 404, "not_found")


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"text": "   "}, "body.segments[0].text: String should have at least 1 character"),
        ({"text": ""}, "body.segments[0].text"),
        ({"start_ms": 3000, "end_ms": 2999}, "body.segments[0]: end_ms must be >= start_ms"),
        ({"start_ms": -1}, "body.segments[0].start_ms"),
        ({"source": "speaker"}, "body.segments[0].source"),
        ({"confidence": 1.5}, "body.segments[0].confidence"),
        ({"speaker": ""}, "body.segments[0].speaker"),
        (
            {"words": [{"text": "Hi", "start_ms": 10, "end_ms": 5, "confidence": None}]},
            "body.segments[0].words[0]: end_ms must be >= start_ms",
        ),
        (
            {"words": [{"text": " ", "start_ms": 1, "end_ms": 5, "confidence": 0.5}]},
            "body.segments[0].words[0].text",
        ),
    ],
)
async def test_segment_validation_errors_use_the_envelope(
    client: httpx.AsyncClient, overrides: Json, expected: str
) -> None:
    meeting = await create_meeting(client)

    response = await client.post(
        f"/v1/meetings/{meeting['id']}/segments",
        json={"segments": [segment_payload(**overrides)]},
    )

    message = assert_error(response, 422, "validation_error")
    assert expected in message


@pytest.mark.parametrize("count", [0, 501])
async def test_segment_batch_size_is_limited(client: httpx.AsyncClient, count: int) -> None:
    meeting = await create_meeting(client)

    response = await client.post(
        f"/v1/meetings/{meeting['id']}/segments",
        json={"segments": [segment_payload() for _ in range(count)]},
    )

    assert "body.segments" in assert_error(response, 422, "validation_error")


async def test_a_full_batch_of_500_is_accepted(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client)
    batch = [segment_payload(start_ms=n, end_ms=n + 1) for n in range(500)]

    assert await append_segments(client, meeting["id"], *batch) == {
        "accepted": 500,
        "duplicates": 0,
    }


async def test_segment_text_is_trimmed(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client)
    await append_segments(client, meeting["id"], segment_payload(text="  Hello.  "))

    transcript = (await client.get(f"/v1/meetings/{meeting['id']}/transcript")).json()

    assert transcript["segments"][0]["text"] == "Hello."


# ---------------------------------------------------------------------------- transcript


async def test_transcript_order_and_shape(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client, title="Weekly sync", started_at=STARTED_AT)
    late = segment_payload(start_ms=9000, end_ms=9500, text="Bye.", words=None, confidence=None)
    them = segment_payload(source="system", speaker="them", start_ms=3000, end_ms=4000, text="Hi.")
    me = segment_payload(source="mic", speaker="me", start_ms=3000, end_ms=3500, text="Hello.")
    first = segment_payload(start_ms=0, end_ms=500, text="Testing.")
    await append_segments(client, meeting["id"], late, them, me, first)

    response = await client.get(f"/v1/meetings/{meeting['id']}/transcript")

    assert response.status_code == 200
    body = response.json()
    assert body["meeting"]["id"] == meeting["id"]
    assert body["meeting"]["segment_count"] == 4
    assert [s["text"] for s in body["segments"]] == ["Testing.", "Hello.", "Hi.", "Bye."]
    stored_late = body["segments"][-1]
    assert stored_late["words"] is None
    assert stored_late["confidence"] is None
    stored_first = body["segments"][0]
    assert stored_first == {
        **first,
        "meeting_id": meeting["id"],
        "created_at": stored_first["created_at"],
    }
    parse_instant(stored_first["created_at"])


async def test_transcript_ties_break_by_id(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client)
    ids = sorted(str(uuid4()) for _ in range(3))
    await append_segments(
        client, meeting["id"], *(segment_payload(id=i, start_ms=5, end_ms=6) for i in reversed(ids))
    )

    body = (await client.get(f"/v1/meetings/{meeting['id']}/transcript")).json()

    assert [s["id"] for s in body["segments"]] == ids


async def test_transcript_of_unknown_meeting_is_404(client: httpx.AsyncClient) -> None:
    assert_error(await client.get(f"/v1/meetings/{uuid4()}/transcript"), 404, "not_found")


# ---------------------------------------------------------------------------- workspaces


async def test_other_workspaces_are_invisible(
    client: httpx.AsyncClient, foreign_meeting_id: UUID
) -> None:
    url = f"/v1/meetings/{foreign_meeting_id}"

    listed = (await client.get("/v1/meetings")).json()["items"]
    assert listed == []
    assert_error(await client.get(url), 404, "not_found")
    assert_error(await client.get(f"{url}/transcript"), 404, "not_found")
    assert_error(await client.post(f"{url}/end"), 404, "not_found")
    appended = await client.post(f"{url}/segments", json={"segments": [segment_payload()]})
    assert_error(appended, 404, "not_found")
    # Reusing another workspace's meeting id is reported as 404, never 409.
    created = await client.post("/v1/meetings", json={"id": str(foreign_meeting_id)})
    assert_error(created, 404, "not_found")
