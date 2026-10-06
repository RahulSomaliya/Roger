"""The notes, LLM run and chat tables (revision 0003): the rules the database itself enforces.

These rows are written straight through the models, not the routes: the constraints are the last
line behind every service that writes them, so they are checked on their own.
"""

from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any, TypeAliasType, get_args
from uuid import UUID, uuid4

import pytest
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.exc import IntegrityError

from roger_api.db.base import Base
from roger_api.db.engine import Database
from roger_api.db.models import Meeting, Workspace
from roger_api.db.models_notes import (
    ONE_RUNNING_NOTES_RUN_INDEX,
    ChatMessage,
    ChatMessageStatus,
    ChatRole,
    LlmRun,
    MeetingNote,
)
from roger_api.domain import NoteKind, RunKind, RunStatus

DOC: dict[str, Any] = {"type": "doc", "content": [{"type": "paragraph"}]}


@pytest.fixture
async def database(database_url: str, clean_database: None) -> AsyncIterator[Database]:
    database = Database(database_url)
    yield database
    await database.dispose()


def values_of(alias: TypeAliasType) -> tuple[str, ...]:
    return get_args(alias.__value__)


async def add_meeting(database: Database) -> Meeting:
    workspace = Workspace(id=uuid4(), name="Linkt")
    meeting = Meeting(
        id=uuid4(),
        workspace_id=workspace.id,
        title="Standup",
        status="ended",
        started_at=datetime.now(UTC),
    )
    async with database.session() as session:
        session.add(workspace)
        await session.flush()
        session.add(meeting)
        await session.commit()
    return meeting


def note(meeting: Meeting, **overrides: Any) -> MeetingNote:
    values: dict[str, Any] = {
        "id": uuid4(),
        "workspace_id": meeting.workspace_id,
        "meeting_id": meeting.id,
        "kind": "user",
        "doc": DOC,
        "version": 1,
        "last_revision_id": uuid4(),
        **overrides,
    }
    return MeetingNote(**values)


def run(meeting: Meeting, **overrides: Any) -> LlmRun:
    values: dict[str, Any] = {
        "id": uuid4(),
        "workspace_id": meeting.workspace_id,
        "meeting_id": meeting.id,
        "kind": "notes",
        "status": "running",
        "model": "fake",
        "prompt_version": "notes-test",
        "line_count": 2,
        "ref_map": {"L1": str(uuid4()), "L2": str(uuid4())},
        **overrides,
    }
    return LlmRun(**values)


def message(meeting: Meeting, **overrides: Any) -> ChatMessage:
    values: dict[str, Any] = {
        "id": uuid4(),
        "workspace_id": meeting.workspace_id,
        "meeting_id": meeting.id,
        "role": "user",
        "text": "What did we decide about the beta?",
        "status": "complete",
        **overrides,
    }
    return ChatMessage(**values)


async def add(database: Database, *rows: Base) -> None:
    """Commits `rows` in the order given, flushing after each (a run before the rows citing it)."""
    async with database.session() as session:
        for row in rows:
            session.add(row)
            await session.flush()
        await session.commit()


async def assert_refused(database: Database, row: Base, constraint: str) -> None:
    async with database.session() as session:
        session.add(row)
        with pytest.raises(IntegrityError, match=constraint):
            await session.commit()


async def count_rows(database: Database, meeting_id: UUID) -> dict[str, int]:
    counts: dict[str, int] = {}
    async with database.session() as session:
        for name in ("meeting_notes", "llm_runs", "chat_messages"):
            table = Base.metadata.tables[name]
            query = select(func.count()).select_from(table).where(table.c.meeting_id == meeting_id)
            counts[name] = await session.scalar(query) or 0
    return counts


async def test_only_one_notes_run_per_meeting_can_be_running(database: Database) -> None:
    meeting = await add_meeting(database)
    other = await add_meeting(database)
    running = run(meeting)
    # Finished notes runs, a running chat run and another meeting's notes run never count.
    await add(
        database,
        running,
        run(meeting, status="succeeded"),
        run(meeting, status="failed"),
        run(meeting, kind="chat"),
        run(other),
    )

    await assert_refused(database, run(meeting), ONE_RUNNING_NOTES_RUN_INDEX)

    async with database.session() as session:
        await session.execute(
            update(LlmRun).where(LlmRun.id == running.id).values(status="succeeded")
        )
        await session.commit()
    await add(database, run(meeting))


async def test_deleting_a_meeting_deletes_its_notes_runs_and_chat(database: Database) -> None:
    meeting = await add_meeting(database)
    kept = await add_meeting(database)
    for each in (meeting, kept):
        notes_run, chat_run = run(each, status="succeeded"), run(each, kind="chat")
        question = message(each)
        await add(
            database,
            notes_run,
            chat_run,
            note(each),
            note(each, kind="ai", last_run_id=notes_run.id, generated_version=1),
            question,
            message(
                each, role="assistant", reply_to=question.id, run_id=chat_run.id, status="streaming"
            ),
        )
    stored = {"meeting_notes": 2, "llm_runs": 2, "chat_messages": 2}
    assert await count_rows(database, meeting.id) == stored

    async with database.session() as session:
        await session.execute(delete(Meeting).where(Meeting.id == meeting.id))
        await session.commit()

    assert await count_rows(database, meeting.id) == dict.fromkeys(stored, 0)
    assert await count_rows(database, kept.id) == stored


async def test_note_kind_and_run_status_are_checked(database: Database) -> None:
    meeting = await add_meeting(database)
    # Every value the domain lists is stored. Each list is also a check constraint in
    # 0003_notes.py, so this fails when a value is added to one side only.
    await add(
        database,
        *(note(meeting, kind=kind) for kind in values_of(NoteKind)),
        *(
            run(meeting, kind=kind, status=status)
            for kind in values_of(RunKind)
            for status in values_of(RunStatus)
        ),
        *(
            message(meeting, role=role, status=status)
            for role in values_of(ChatRole)
            for status in values_of(ChatMessageStatus)
        ),
    )

    refused = [
        (note(meeting, kind="summary"), "ck_meeting_notes_kind"),
        (run(meeting, kind="summary", status="failed"), "ck_llm_runs_kind"),
        (run(meeting, status="queued"), "ck_llm_runs_status"),
        (message(meeting, role="system"), "ck_chat_messages_role"),
        (message(meeting, status="sent"), "ck_chat_messages_status"),
    ]
    for row, constraint in refused:
        await assert_refused(database, row, constraint)


async def test_a_meeting_has_one_note_of_each_kind(database: Database) -> None:
    meeting = await add_meeting(database)
    await add(database, note(meeting), note(meeting, kind="ai"))

    await assert_refused(database, note(meeting), "uq_meeting_notes_meeting_id_kind")


async def test_deleting_a_run_keeps_its_note_and_clears_last_run_id(database: Database) -> None:
    meeting = await add_meeting(database)
    notes_run = run(meeting, status="succeeded")
    ai_note = note(meeting, kind="ai", last_run_id=notes_run.id, generated_version=1)
    await add(database, notes_run, ai_note)

    async with database.session() as session:
        await session.execute(delete(LlmRun).where(LlmRun.id == notes_run.id))
        await session.commit()

    async with database.session() as session:
        stored = await session.get_one(MeetingNote, ai_note.id)
        assert stored.last_run_id is None
        assert stored.generated_version == 1


async def test_a_new_run_starts_now_with_zero_counts_and_no_usage(database: Database) -> None:
    meeting = await add_meeting(database)
    claimed = run(meeting)
    await add(database, claimed)

    async with database.session() as session:
        stored = await session.get_one(LlmRun, claimed.id)
        database_now = await session.scalar(select(func.now()))
    # Postgres fills both from now(): the stale sweep compares heartbeats with the same clock.
    assert stored.started_at == stored.heartbeat_at
    assert database_now is not None
    assert stored.started_at <= database_now
    assert (stored.flagged_count, stored.from_notes_count) == (0, 0)
    # Unknown until the vendor reports usage. Never 0: a 0 cost would read as a free run.
    assert stored.input_tokens is None
    assert stored.output_tokens is None
    assert stored.cached_tokens is None
    assert stored.cost_usd is None
    assert stored.finished_at is None


async def test_none_is_stored_as_sql_null_not_json_null(database: Database) -> None:
    """`IS NULL` must find a run with no output and a message with no citations. Without
    `none_as_null` a Python None is written as the JSON literal `null`, which is not NULL."""
    meeting = await add_meeting(database)
    await add(
        database,
        run(meeting, output_doc=None, replaced_doc=None, dropped=None),
        message(meeting, citations=None),
    )

    async with database.session() as session:
        runs = await session.scalar(
            text(
                "SELECT count(*) FROM llm_runs WHERE output_doc IS NULL "
                "AND replaced_doc IS NULL AND dropped IS NULL"
            )
        )
        messages = await session.scalar(
            text("SELECT count(*) FROM chat_messages WHERE citations IS NULL")
        )
    assert (runs, messages) == (1, 1)
