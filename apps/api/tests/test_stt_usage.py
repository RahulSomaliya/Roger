"""STT usage per meeting and cost per meeting hour: `PUT /v1/stt-usage/meetings/{id}` and
`GET /v1/stt-usage/summary` (M3-T19a)."""

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select

from roger_api.config import Settings
from roger_api.db.engine import Database
from roger_api.db.models import Meeting, Workspace
from roger_api.db.models_stt_usage import MeetingSttUsage
from roger_api.services.stt_usage import MAX_NAMED_UNPRICED_MEETINGS
from tests.helpers import TEST_TOKEN, Json, assert_error, create_meeting

SUMMARY_PATH = "/v1/stt-usage/summary"
INT4_MAX = 2_147_483_647
INT8_MAX = 9_223_372_036_854_775_807
ROW_FIELDS = {
    "meeting_id",
    "provider",
    "sessions_opened",
    "connected_ms",
    "audio_sent_ms",
    "dropped_chunks",
    "gated_ms",
    "estimated_cost_usd",
    "by_source",
    "stop_reason",
    "created_at",
    "updated_at",
}
EMPTY_SUMMARY: Json = {
    "meetings": 0,
    "stream_hours": 0.0,
    "meeting_hours": 0.0,
    "estimated_cost_usd": 0.0,
    "cost_per_meeting_hour": None,
    "gated_hours": 0.0,
    "estimated_saved_usd": 0.0,
    "unpriced_meetings": 0,
    "unpriced_meeting_ids": [],
}
HOUR_MS = 3_600_000


def usage_path(meeting_id: UUID | str) -> str:
    return f"/v1/stt-usage/meetings/{meeting_id}"


def source_usage(**overrides: object) -> Json:
    return {
        "sessions_opened": 1,
        "connected_ms": 1_800_000,
        "audio_sent_ms": 1_790_000,
        "dropped_chunks": 1,
        "gated_ms": 0,
        "estimated_cost_usd": 0.095,
        **overrides,
    }


def usage_body(**overrides: object) -> Json:
    """One meeting's usage as the desktop sends it: two streams of 30 minutes each."""
    return {
        "provider": "assemblyai",
        "sessions_opened": 2,
        "connected_ms": HOUR_MS,
        "audio_sent_ms": 3_580_000,
        "dropped_chunks": 2,
        "gated_ms": 0,
        "estimated_cost_usd": 0.19,
        "by_source": {"mic": source_usage(), "system": source_usage()},
        "stop_reason": "user",
        **overrides,
    }


def database_of(app: FastAPI) -> Database:
    database = app.state.database
    assert isinstance(database, Database)
    return database


async def put_usage(client: httpx.AsyncClient, meeting_id: UUID | str, body: Json) -> Json:
    response = await client.put(usage_path(meeting_id), json=body)
    assert response.status_code == 200, response.text
    stored: Json = response.json()
    assert set(stored) == ROW_FIELDS
    return stored


async def get_summary(client: httpx.AsyncClient, since: datetime | None = None) -> Json:
    params = {} if since is None else {"since": since.isoformat()}
    response = await client.get(SUMMARY_PATH, params=params)
    assert response.status_code == 200, response.text
    summary: Json = response.json()
    return summary


async def stored_rows(app: FastAPI) -> list[tuple[UUID, UUID, str, int]]:
    """(workspace_id, meeting_id, provider, connected_ms) of every row, of every workspace."""
    async with database_of(app).session() as session:
        rows = await session.execute(
            select(
                MeetingSttUsage.workspace_id,
                MeetingSttUsage.meeting_id,
                MeetingSttUsage.provider,
                MeetingSttUsage.connected_ms,
            ).order_by(MeetingSttUsage.workspace_id, MeetingSttUsage.meeting_id)
        )
        return [(workspace, meeting, provider, ms) for workspace, meeting, provider, ms in rows]


async def add_workspace(app: FastAPI) -> UUID:
    workspace_id = uuid4()
    async with database_of(app).session() as session:
        session.add(Workspace(id=workspace_id, name="Someone else"))
        await session.commit()
    return workspace_id


async def add_usage_rows(app: FastAPI, *rows: MeetingSttUsage) -> None:
    """Rows written straight to the table, for another workspace or a set `created_at`."""
    async with database_of(app).session() as session:
        session.add_all(rows)
        await session.commit()


def usage_row(workspace_id: UUID, meeting_id: UUID, **values: Any) -> MeetingSttUsage:
    columns: dict[str, Any] = {
        "provider": "assemblyai",
        "sessions_opened": 2,
        "connected_ms": HOUR_MS,
        "audio_sent_ms": HOUR_MS,
        "dropped_chunks": 0,
        "gated_ms": 0,
        "estimated_cost_usd": Decimal("0.19"),
        "by_source": {"mic": source_usage(), "system": source_usage()},
        "stop_reason": "user",
        **values,
    }
    return MeetingSttUsage(workspace_id=workspace_id, meeting_id=meeting_id, **columns)


async def add_meeting(
    client: httpx.AsyncClient, started_at: datetime, ended_at: datetime | None
) -> UUID:
    """A meeting row through the API, ended at `ended_at` unless it is None (still recording)."""
    meeting = await create_meeting(client, started_at=started_at.isoformat())
    if ended_at is not None:
        response = await client.post(
            f"/v1/meetings/{meeting['id']}/end", json={"ended_at": ended_at.isoformat()}
        )
        assert response.status_code == 200, response.text
    return UUID(meeting["id"])


async def add_foreign_meeting(app: FastAPI, started_at: datetime, ended_at: datetime) -> UUID:
    """An ended meeting in another workspace, written straight to the tables."""
    workspace_id, meeting_id = await add_workspace(app), uuid4()
    async with database_of(app).session() as session:
        session.add(
            Meeting(
                id=meeting_id,
                workspace_id=workspace_id,
                title="Not yours",
                status="ended",
                started_at=started_at,
                ended_at=ended_at,
            )
        )
        await session.commit()
    return meeting_id


def without(body: Json, *fields: str) -> Json:
    return {field: value for field, value in body.items() if field not in fields}


# ---------------------------------------------------------------------------- PUT


async def test_put_stores_the_meetings_usage_and_answers_with_it(
    client: httpx.AsyncClient,
) -> None:
    meeting_id = uuid4()
    body = usage_body(gated_ms=600_000, stop_reason="no-speech")

    stored = await put_usage(client, meeting_id, body)

    assert stored["meeting_id"] == str(meeting_id)
    assert {field: stored[field] for field in body} == body
    assert stored["created_at"].endswith("Z")
    assert stored["updated_at"].endswith("Z")


async def test_put_is_idempotent_and_keeps_one_row_per_meeting(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings
) -> None:
    meeting_id = uuid4()
    first = await put_usage(client, meeting_id, usage_body())

    again = await put_usage(client, meeting_id, usage_body())

    assert without(again, "updated_at") == without(first, "updated_at")
    workspace = settings.default_workspace_id
    assert await stored_rows(app) == [(workspace, meeting_id, "assemblyai", HOUR_MS)]

    # The desktop sends the meeting's whole usage every time: a later send replaces the row.
    later = await put_usage(client, meeting_id, usage_body(connected_ms=2 * HOUR_MS))

    assert later["connected_ms"] == 2 * HOUR_MS
    assert later["created_at"] == first["created_at"]
    assert await stored_rows(app) == [(workspace, meeting_id, "assemblyai", 2 * HOUR_MS)]


async def test_put_needs_no_meeting_row(client: httpx.AsyncClient) -> None:
    # A meeting with no lines is deleted, but its sessions were billed: its usage still counts.
    meeting_id = uuid4()

    stored = await put_usage(client, meeting_id, usage_body())

    assert stored["meeting_id"] == str(meeting_id)
    response = await client.get(f"/v1/meetings/{meeting_id}")
    assert_error(response, 404, "not_found")


async def test_gated_ms_reads_as_zero_when_it_is_missing(client: httpx.AsyncClient) -> None:
    # The silence gate (M3-T20) lands after the uploader: its time is 0 until then.
    without_gate = without(source_usage(), "gated_ms")
    body = without(usage_body(by_source={"mic": without_gate, "system": without_gate}), "gated_ms")

    stored = await put_usage(client, uuid4(), body)

    assert stored["gated_ms"] == 0
    assert stored["by_source"] == {"mic": source_usage(), "system": source_usage()}


async def test_a_missing_stop_reason_reads_as_null(client: httpx.AsyncClient) -> None:
    # A recording still running has no stop reason yet.
    stored = await put_usage(client, uuid4(), without(usage_body(), "stop_reason"))

    assert stored["stop_reason"] is None


@pytest.mark.parametrize(
    "stop_reason",
    [
        pytest.param("page-reloaded", id="retired-by-M2-T12"),
        pytest.param("start-failed", id="not-a-StopReason"),
        pytest.param("call-ended", id="added-by-M2-T17b"),
        pytest.param("x" * 64, id="64-characters"),
        pytest.param(None, id="null"),
    ],
)
async def test_stop_reason_takes_any_short_text(
    client: httpx.AsyncClient, stop_reason: str | None
) -> None:
    # Free text, never a list: the desktop's stop reasons change across releases, and a row the
    # API refused is never sent again (M3-T19b marks a 422 as rejected).
    stored = await put_usage(client, uuid4(), usage_body(stop_reason=stop_reason))

    assert stored["stop_reason"] == stop_reason


@pytest.mark.parametrize(
    ("field", "value"),
    [
        pytest.param("stop_reason", "", id="empty-stop-reason"),
        pytest.param("stop_reason", "   ", id="blank-stop-reason"),
        pytest.param("stop_reason", "\x00", id="nul-only-stop-reason"),
        pytest.param("stop_reason", "x" * 65, id="over-long-stop-reason"),
        pytest.param("provider", "", id="empty-provider"),
        pytest.param("provider", "x" * 65, id="over-long-provider"),
    ],
)
async def test_blank_or_over_long_text_is_refused(
    app: FastAPI, client: httpx.AsyncClient, field: str, value: str
) -> None:
    response = await client.put(usage_path(uuid4()), json=usage_body(**{field: value}))

    message = assert_error(response, 422, "validation_error")
    assert f"body.{field}" in message
    assert await stored_rows(app) == []


async def test_provider_is_free_text(client: httpx.AsyncClient) -> None:
    # A vendor the API no longer offers, or one it does not know yet, still made a billed row.
    stored = await put_usage(client, uuid4(), usage_body(provider="some-later-vendor"))

    assert stored["provider"] == "some-later-vendor"


async def test_text_is_trimmed_and_loses_nul(client: httpx.AsyncClient) -> None:
    # Postgres `text` cannot hold U+0000: kept, it would fail the insert with a 500.
    stored = await put_usage(
        client, uuid4(), usage_body(provider=" assembly\x00ai ", stop_reason="no-\x00speech")
    )

    assert (stored["provider"], stored["stop_reason"]) == ("assemblyai", "no-speech")


def _bad_bodies() -> list[Any]:
    without_system = usage_body(by_source={"mic": source_usage()})
    return [
        pytest.param(usage_body(sessions_opened=-1), "body.sessions_opened", id="negative-count"),
        pytest.param(
            usage_body(sessions_opened=INT4_MAX + 1), "body.sessions_opened", id="count-over-int4"
        ),
        pytest.param(
            usage_body(connected_ms=INT8_MAX + 1), "body.connected_ms", id="duration-over-int8"
        ),
        pytest.param(usage_body(gated_ms=-1), "body.gated_ms", id="negative-gated-time"),
        pytest.param(
            usage_body(estimated_cost_usd=-0.01), "body.estimated_cost_usd", id="negative-cost"
        ),
        pytest.param(
            usage_body(estimated_cost_usd=float("nan")), "body.estimated_cost_usd", id="nan-cost"
        ),
        pytest.param(without_system, "body.by_source.system", id="one-source-missing"),
        pytest.param(
            usage_body(by_source={"mic": source_usage(), "system": source_usage(connected_ms=-1)}),
            "body.by_source.system.connected_ms",
            id="negative-source-time",
        ),
        pytest.param(
            without(usage_body(), "connected_ms"), "body.connected_ms", id="total-missing"
        ),
        pytest.param(
            without(usage_body(), "estimated_cost_usd"),
            "body.estimated_cost_usd",
            # Unknown is null, sent on purpose; a client that forgot the cost must not have its
            # meeting read as one with an unknown price.
            id="cost-missing",
        ),
        pytest.param(usage_body(provider="\ud800"), "body.provider", id="unpaired-surrogate"),
    ]


@pytest.mark.parametrize(("body", "field"), _bad_bodies())
async def test_bad_numbers_and_shapes_are_refused(
    app: FastAPI, client: httpx.AsyncClient, body: Json, field: str
) -> None:
    # Sent as raw JSON: httpx refuses NaN and an unpaired surrogate, which Python's json accepts.
    response = await client.put(
        usage_path(uuid4()),
        content=json.dumps(body),
        headers={"Content-Type": "application/json"},
    )

    message = assert_error(response, 422, "validation_error")
    assert field in message
    assert await stored_rows(app) == []


async def test_another_workspaces_row_is_never_read_or_overwritten(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings
) -> None:
    other_workspace = await add_workspace(app)
    meeting_id = uuid4()
    await add_usage_rows(
        app,
        usage_row(other_workspace, meeting_id, provider="deepgram", estimated_cost_usd=None),
    )

    stored = await put_usage(client, meeting_id, usage_body(connected_ms=2 * HOUR_MS))

    assert stored["provider"] == "assemblyai"
    assert sorted(await stored_rows(app)) == sorted(
        [
            (other_workspace, meeting_id, "deepgram", HOUR_MS),
            (settings.default_workspace_id, meeting_id, "assemblyai", 2 * HOUR_MS),
        ]
    )
    summary = await get_summary(client)
    assert (summary["meetings"], summary["stream_hours"], summary["unpriced_meetings"]) == (1, 2, 0)


# ---------------------------------------------------------------------------- summary


async def test_summary_is_empty_without_usage(client: httpx.AsyncClient) -> None:
    assert await get_summary(client) == EMPTY_SUMMARY


async def test_summary_sums_cost_and_hours_and_names_unpriced_meetings(
    client: httpx.AsyncClient,
) -> None:
    start = datetime(2026, 10, 5, 10, 0, tzinfo=UTC)
    # One hour, both streams open throughout, half of one stream's time closed while silent.
    priced = await add_meeting(client, start, start + timedelta(hours=1))
    await put_usage(
        client,
        priced,
        usage_body(connected_ms=2 * HOUR_MS, gated_ms=HOUR_MS // 2, estimated_cost_usd=0.38),
    )
    # Half an hour at a price the API did not know when it issued the token.
    unpriced = await add_meeting(client, start, start + timedelta(minutes=30))
    await put_usage(client, unpriced, usage_body(connected_ms=HOUR_MS, estimated_cost_usd=None))
    # Billed sessions, but no meeting row: it had no lines.
    await put_usage(client, uuid4(), usage_body(connected_ms=600_000, estimated_cost_usd=0.03))

    summary = await get_summary(client)

    assert summary == {
        "meetings": 3,
        "stream_hours": 3.1667,  # 2 + 1 + 1/6
        "meeting_hours": 1.5,  # only meetings with a start and an end
        "estimated_cost_usd": 0.41,  # the known prices; never the unknown one as 0
        # Only meetings with both a price and hours: 0.38 over 1 hour. Counting the unpriced
        # meeting's half hour as free would read 0.2533; the lineless meeting's cost over the
        # others' hours, 0.41.
        "cost_per_meeting_hour": 0.38,
        "gated_hours": 0.5,
        "estimated_saved_usd": 0.095,  # half a stream hour at the meeting's 0.19 per stream hour
        "unpriced_meetings": 1,
        "unpriced_meeting_ids": [str(unpriced)],
    }


async def test_summary_with_only_unknown_prices_has_no_cost(client: httpx.AsyncClient) -> None:
    start = datetime(2026, 10, 5, 10, 0, tzinfo=UTC)
    meeting = await add_meeting(client, start, start + timedelta(hours=1))
    await put_usage(
        client,
        meeting,
        usage_body(connected_ms=2 * HOUR_MS, gated_ms=HOUR_MS, estimated_cost_usd=None),
    )

    summary = await get_summary(client)

    assert summary == {
        **EMPTY_SUMMARY,
        "meetings": 1,
        "stream_hours": 2.0,
        "meeting_hours": 1.0,
        "estimated_cost_usd": None,
        "cost_per_meeting_hour": None,
        "gated_hours": 1.0,
        "estimated_saved_usd": None,
        "unpriced_meetings": 1,
        "unpriced_meeting_ids": [str(meeting)],
    }


async def test_meeting_hours_come_only_from_this_workspaces_ended_meetings(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    start = datetime(2026, 10, 5, 10, 0, tzinfo=UTC)
    still_recording = await add_meeting(client, start, None)
    await put_usage(client, still_recording, usage_body())
    # An end before the start (a skewed clock) is no hours, never minus one.
    backwards = await add_meeting(client, start, start - timedelta(hours=1))
    await put_usage(client, backwards, usage_body())
    # Another workspace's ended meeting, under the id this workspace's row names, lends it nothing.
    foreign = await add_foreign_meeting(app, start, start + timedelta(hours=1))
    await put_usage(client, foreign, usage_body())

    summary = await get_summary(client)

    assert (summary["meetings"], summary["meeting_hours"]) == (3, 0.0)
    assert summary["cost_per_meeting_hour"] is None


async def test_since_counts_a_meeting_from_its_start(client: httpx.AsyncClient) -> None:
    now = datetime.now(UTC)
    since = now - timedelta(days=1)
    recent = await add_meeting(client, now - timedelta(hours=2), now - timedelta(hours=1))
    await put_usage(client, recent, usage_body(estimated_cost_usd=0.19))
    # Uploaded now, but held ten days ago: outside the window.
    old_start = now - timedelta(days=10)
    old = await add_meeting(client, old_start, old_start + timedelta(hours=1))
    await put_usage(client, old, usage_body(estimated_cost_usd=5.0))
    # No meeting row: it counts from when its usage first arrived, which is now.
    lineless = uuid4()
    await put_usage(client, lineless, usage_body(estimated_cost_usd=0.01))

    summary = await get_summary(client, since=since)

    assert (summary["meetings"], summary["estimated_cost_usd"], summary["meeting_hours"]) == (
        2,
        0.2,
        1.0,
    )
    assert (await get_summary(client, since=now + timedelta(minutes=5)))["meetings"] == 0
    assert (await get_summary(client))["meetings"] == 3


@pytest.mark.parametrize(
    "since",
    [
        pytest.param("2026-10-01T00:00:00", id="no-offset"),
        pytest.param("last week", id="not-an-instant"),
    ],
)
async def test_since_must_be_an_instant(client: httpx.AsyncClient, since: str) -> None:
    response = await client.get(SUMMARY_PATH, params={"since": since})

    assert "query.since" in assert_error(response, 422, "validation_error")


async def test_summary_names_the_newest_unpriced_meetings_and_counts_them_all(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings
) -> None:
    first = datetime(2026, 10, 1, tzinfo=UTC)
    count = MAX_NAMED_UNPRICED_MEETINGS + 1
    rows = [
        usage_row(
            settings.default_workspace_id,
            uuid4(),
            estimated_cost_usd=None,
            created_at=first + timedelta(minutes=minute),
        )
        for minute in range(count)
    ]
    await add_usage_rows(app, *rows)

    summary = await get_summary(client)

    assert summary["unpriced_meetings"] == count
    newest_first = [str(row.meeting_id) for row in reversed(rows)]
    assert summary["unpriced_meeting_ids"] == newest_first[:MAX_NAMED_UNPRICED_MEETINGS]


# ---------------------------------------------------------------------------- auth


@pytest.mark.parametrize(
    "headers",
    [
        pytest.param({}, id="missing"),
        pytest.param({"Authorization": f"Bearer {TEST_TOKEN}x"}, id="wrong-token"),
    ],
)
async def test_stt_usage_needs_the_bearer_token(
    app: FastAPI, anonymous_client: httpx.AsyncClient, headers: dict[str, str]
) -> None:
    put = await anonymous_client.put(usage_path(uuid4()), headers=headers, json=usage_body())
    summary = await anonymous_client.get(SUMMARY_PATH, headers=headers)

    assert_error(put, 401, "unauthorized")
    assert_error(summary, 401, "unauthorized")
    assert await stored_rows(app) == []
