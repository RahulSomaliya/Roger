"""The calendar schema (M5-T1, revision 0004): pgcrypto, `calendar_connections`,
`meeting_attendees` and the new `meetings` columns, checked against the real database the
migrations built. tests/test_migrations.py checks that the migrations build exactly the models."""

import asyncio
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import get_args
from uuid import UUID, uuid4

import pytest
from alembic import command
from sqlalchemy import NullPool, delete, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from roger_api.config_calendar import CalendarProviderName
from roger_api.db.engine import Database
from roger_api.db.models import Meeting, Workspace
from roger_api.db.models_calendar import CalendarConnection, MeetingAttendee
from roger_api.domain import StartSource
from tests.conftest import alembic_config

START_SOURCES = ["manual", "notification", "home", "tray", "call_detected"]
STARTED_AT = datetime(2026, 10, 6, 9, 58, tzinfo=UTC)


@pytest.fixture
async def session(database_url: str, clean_database: None) -> AsyncIterator[AsyncSession]:
    database = Database(database_url)
    async with database.session() as db_session:
        yield db_session
    await database.dispose()


async def add_workspace(session: AsyncSession) -> UUID:
    workspace_id = uuid4()
    session.add(Workspace(id=workspace_id, name="Linkt"))
    await session.flush()
    return workspace_id


async def add_meeting(session: AsyncSession, workspace_id: UUID, **columns: object) -> UUID:
    meeting_id = uuid4()
    session.add(
        Meeting(
            id=meeting_id,
            workspace_id=workspace_id,
            title="Weekly sync",
            status="recording",
            started_at=STARTED_AT,
            **columns,
        )
    )
    await session.flush()
    return meeting_id


def connection_row(workspace_id: UUID, **overrides: object) -> CalendarConnection:
    values: dict[str, object] = {
        "id": uuid4(),
        "workspace_id": workspace_id,
        "user_id": None,
        "provider": "fake",
        "account_email": "rahul@linkt.ai",
        "scopes": "openid email https://www.googleapis.com/auth/calendar.events.readonly",
        "refresh_token": None,
        "status": "active",
        "connected_at": STARTED_AT,
        **overrides,
    }
    return CalendarConnection(**values)


def attendee_row(workspace_id: UUID, meeting_id: UUID, position: int) -> MeetingAttendee:
    return MeetingAttendee(
        id=uuid4(),
        workspace_id=workspace_id,
        meeting_id=meeting_id,
        position=position,
        email=f"person{position}@example.com",
        display_name=None,
        response_status="accepted",
        is_self=False,
        is_organizer=position == 0,
    )


# pgcrypto


async def test_pgcrypto_is_installed(session: AsyncSession) -> None:
    installed = await session.scalar(
        text("SELECT count(*) FROM pg_extension WHERE extname = 'pgcrypto'")
    )

    assert installed == 1


async def test_refresh_token_column_holds_pgcrypto_ciphertext(session: AsyncSession) -> None:
    workspace_id = await add_workspace(session)
    token, key = "1//refresh-token-value", "k" * 32
    row = connection_row(
        workspace_id, provider="google", refresh_token=func.pgp_sym_encrypt(token, key)
    )
    session.add(row)
    await session.flush()

    stored = await session.scalar(
        select(CalendarConnection.refresh_token).where(CalendarConnection.id == row.id)
    )
    decrypted = await session.scalar(
        select(func.pgp_sym_decrypt(CalendarConnection.refresh_token, key)).where(
            CalendarConnection.id == row.id
        )
    )

    assert isinstance(stored, bytes)
    assert token.encode() not in stored
    assert decrypted == token


# calendar_connections


async def test_one_connection_per_workspace_while_user_id_is_null(session: AsyncSession) -> None:
    # Until M6 every connection has user_id NULL. A plain unique constraint treats two NULLs as
    # different values and would let a workspace pile up connections; NULLS NOT DISTINCT does not.
    workspace_id = await add_workspace(session)
    session.add(connection_row(workspace_id))
    await session.flush()

    session.add(connection_row(workspace_id))
    with pytest.raises(IntegrityError, match="uq_calendar_connections_workspace_id_user_id"):
        await session.flush()


async def test_one_connection_per_workspace_and_user(session: AsyncSession) -> None:
    workspace_id, other_workspace_id = await add_workspace(session), await add_workspace(session)
    user_id = uuid4()
    session.add_all(
        [
            connection_row(workspace_id, user_id=user_id),
            connection_row(workspace_id, user_id=uuid4()),  # another user, same workspace
            connection_row(workspace_id),  # the workspace's own (M6 users come later)
            connection_row(other_workspace_id, user_id=user_id),  # same user, another workspace
            connection_row(other_workspace_id),
        ]
    )
    await session.flush()

    session.add(connection_row(workspace_id, user_id=user_id))
    with pytest.raises(IntegrityError, match="uq_calendar_connections_workspace_id_user_id"):
        await session.flush()


@pytest.mark.parametrize("provider", get_args(CalendarProviderName.__value__))
async def test_every_calendar_provider_is_accepted(session: AsyncSession, provider: str) -> None:
    workspace_id = await add_workspace(session)
    session.add(connection_row(workspace_id, provider=provider))

    await session.flush()


async def test_unknown_calendar_provider_is_refused_by_the_database(session: AsyncSession) -> None:
    # M5-T3's test that a database error never leaks the token or key relies on this check
    # failing on the statement that carries both.
    workspace_id = await add_workspace(session)
    session.add(connection_row(workspace_id, provider="outlook"))

    with pytest.raises(IntegrityError, match="ck_calendar_connections_provider"):
        await session.flush()


@pytest.mark.parametrize("status", ["active", "reconnect_required"])
async def test_every_connection_status_is_accepted(session: AsyncSession, status: str) -> None:
    workspace_id = await add_workspace(session)
    session.add(connection_row(workspace_id, status=status))

    await session.flush()


async def test_unknown_connection_status_is_refused_by_the_database(session: AsyncSession) -> None:
    workspace_id = await add_workspace(session)
    session.add(connection_row(workspace_id, status="expired"))

    with pytest.raises(IntegrityError, match="ck_calendar_connections_status"):
        await session.flush()


# meetings: start_source and the calendar event link


def test_start_source_has_five_values_call_detected_included() -> None:
    # The check constraint in revision 0004 lists the same five; M2's call offer stores
    # `call_detected`, and it is in the constraint from the start so M2 needs no migration.
    assert list(get_args(StartSource.__value__)) == START_SOURCES


async def test_start_source_defaults_to_manual(session: AsyncSession) -> None:
    workspace_id = await add_workspace(session)
    meeting_id = await add_meeting(session, workspace_id)

    stored = await session.scalar(select(Meeting.start_source).where(Meeting.id == meeting_id))

    assert stored == "manual"


@pytest.mark.parametrize("start_source", START_SOURCES)
async def test_every_start_source_is_accepted(session: AsyncSession, start_source: str) -> None:
    workspace_id = await add_workspace(session)
    meeting_id = await add_meeting(session, workspace_id, start_source=start_source)

    stored = await session.scalar(select(Meeting.start_source).where(Meeting.id == meeting_id))

    assert stored == start_source


async def test_unknown_start_source_is_refused_by_the_database(session: AsyncSession) -> None:
    workspace_id = await add_workspace(session)

    with pytest.raises(IntegrityError, match="ck_meetings_start_source"):
        await add_meeting(session, workspace_id, start_source="calendar")


async def test_a_meeting_without_an_event_has_no_link(session: AsyncSession) -> None:
    workspace_id = await add_workspace(session)
    meeting_id = await add_meeting(session, workspace_id)

    link = (
        await session.execute(
            select(
                Meeting.calendar_provider,
                Meeting.calendar_event_id,
                Meeting.calendar_ical_uid,
                Meeting.calendar_recurring_event_id,
                Meeting.scheduled_start_at,
                Meeting.scheduled_end_at,
            ).where(Meeting.id == meeting_id)
        )
    ).one()

    assert tuple(link) == (None, None, None, None, None, None)


async def test_a_meeting_keeps_its_calendar_event_link(session: AsyncSession) -> None:
    workspace_id = await add_workspace(session)
    scheduled_start = datetime(2026, 10, 6, 10, 0, tzinfo=UTC)
    meeting_id = await add_meeting(
        session,
        workspace_id,
        start_source="notification",
        calendar_provider="google",
        calendar_event_id="abc123_20261006T100000Z",
        calendar_ical_uid="abc123@google.com",
        calendar_recurring_event_id="abc123",
        scheduled_start_at=scheduled_start,
        scheduled_end_at=scheduled_start + timedelta(minutes=30),
    )
    session.expunge_all()

    meeting = await session.get_one(Meeting, meeting_id)

    assert meeting.start_source == "notification"
    assert meeting.calendar_provider == "google"
    assert meeting.calendar_event_id == "abc123_20261006T100000Z"
    assert meeting.calendar_ical_uid == "abc123@google.com"
    assert meeting.calendar_recurring_event_id == "abc123"
    assert meeting.scheduled_start_at == scheduled_start
    assert meeting.scheduled_end_at == scheduled_start + timedelta(minutes=30)


# meeting_attendees


async def test_attendees_go_with_their_meeting(session: AsyncSession) -> None:
    workspace_id = await add_workspace(session)
    meeting_id, kept_meeting_id = (
        await add_meeting(session, workspace_id),
        await add_meeting(session, workspace_id),
    )
    session.add_all([attendee_row(workspace_id, meeting_id, position) for position in range(3)])
    session.add(attendee_row(workspace_id, kept_meeting_id, 0))
    await session.flush()

    await session.execute(delete(Meeting).where(Meeting.id == meeting_id))
    left = (await session.scalars(select(MeetingAttendee.meeting_id))).all()

    assert left == [kept_meeting_id]


async def test_attendee_positions_are_unique_per_meeting(session: AsyncSession) -> None:
    workspace_id = await add_workspace(session)
    meeting_id, other_meeting_id = (
        await add_meeting(session, workspace_id),
        await add_meeting(session, workspace_id),
    )
    session.add_all(
        [attendee_row(workspace_id, meeting_id, 0), attendee_row(workspace_id, other_meeting_id, 0)]
    )
    await session.flush()

    session.add(attendee_row(workspace_id, meeting_id, 0))
    with pytest.raises(IntegrityError, match="uq_meeting_attendees_meeting_id_position"):
        await session.flush()


# The upgrade in place, on a database that already has meetings


async def _execute(url: str, statement: str, parameters: dict[str, object] | None = None) -> None:
    # AUTOCOMMIT: CREATE and DROP DATABASE refuse to run inside a transaction.
    engine = create_async_engine(url, poolclass=NullPool, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as connection:
            await connection.execute(text(statement), parameters or {})
    finally:
        await engine.dispose()


async def _scalar(url: str, query: str) -> object:
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as connection:
            return await connection.scalar(text(query))
    finally:
        await engine.dispose()


def test_existing_meetings_read_manual_after_the_upgrade(database_url: str) -> None:
    """The session's own database is migrated while empty, so it cannot show that 0004 adds a NOT
    NULL column to a table that already has rows: without its server default, ADD COLUMN fails on
    the dev database and passes every other test. Sync on purpose: Alembic runs its own loop."""
    name = f"roger_test_calendar_upgrade_{uuid4().hex[:12]}"
    server = make_url(database_url)
    scratch = server.set(database=name).render_as_string(hide_password=False)
    maintenance = server.set(database="postgres").render_as_string(hide_password=False)
    config = alembic_config(scratch)

    def scalar(query: str) -> object:
        return asyncio.run(_scalar(scratch, query))

    asyncio.run(_execute(maintenance, f'CREATE DATABASE "{name}"'))
    try:
        command.upgrade(config, "0003")
        workspace_id = uuid4()
        asyncio.run(
            _execute(
                scratch,
                "INSERT INTO workspaces (id, name) VALUES (:id, 'Linkt')",
                {"id": workspace_id},
            )
        )
        asyncio.run(
            _execute(
                scratch,
                "INSERT INTO meetings (id, workspace_id, title, status, started_at) "
                "VALUES (:id, :workspace_id, 'Before M5', 'ended', now())",
                {"id": uuid4(), "workspace_id": workspace_id},
            )
        )

        command.upgrade(config, "0004")

        assert scalar("SELECT start_source FROM meetings") == "manual"
        assert scalar("SELECT calendar_event_id FROM meetings") is None

        command.downgrade(config, "0003")

        assert scalar("SELECT count(*) FROM meetings") == 1
        assert scalar("SELECT to_regclass('calendar_connections')") is None
        assert scalar("SELECT to_regclass('meeting_attendees')") is None
        columns = (
            "SELECT count(*) FROM information_schema.columns "
            "WHERE table_name = 'meetings' AND column_name = 'start_source'"
        )
        assert scalar(columns) == 0
        # Left in place on purpose (0004's downgrade says why): upgrading again must not trip on it.
        assert scalar("SELECT count(*) FROM pg_extension WHERE extname = 'pgcrypto'") == 1

        command.upgrade(config, "head")

        assert scalar("SELECT start_source FROM meetings") == "manual"
    finally:
        asyncio.run(_execute(maintenance, f'DROP DATABASE IF EXISTS "{name}"'))
