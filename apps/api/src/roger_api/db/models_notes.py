"""Notes, LLM run and chat tables (M4-T1, revision 0003; docs/plans/M4-notes-and-ai.md, Data model).

`meeting_notes` holds two TipTap JSON docs per meeting, the user's and the AI's, each with its own
version. `llm_runs` is one row per notes or chat generation: what went in, what came out, and what
it cost. `chat_messages` is one thread per meeting.

`db/models.py` imports this module at its end, so Alembic and the test truncation see every table
declared here without anyone editing that file. Every row carries `workspace_id` (house rule 2).
Every value list used here is also a check constraint in `0003_notes.py`; change the two together.
"""

from datetime import datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from roger_api.db.base import Base
from roger_api.domain import NoteKind, RunKind, RunStatus

# chat_messages' value lists. They live here, not in domain.py, because domain.py has other owners
# in Phase 2 (phase-2-build-order.md, section 3.1).
type ChatRole = Literal["user", "assistant"]
type ChatMessageStatus = Literal["complete", "streaming", "failed"]

# The partial unique index that lets one notes run per meeting be `running`. A second claim
# violates it: catch the IntegrityError by this name and answer 409.
ONE_RUNNING_NOTES_RUN_INDEX = "uq_llm_runs_meeting_id_running_notes"


def _now() -> Mapped[datetime]:
    """A timestamptz column that Postgres fills with now() when an insert leaves it out."""
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class LlmRun(Base):
    __tablename__ = "llm_runs"
    __table_args__ = (
        CheckConstraint("kind IN ('notes', 'chat')", name="kind"),
        CheckConstraint("status IN ('running', 'succeeded', 'failed', 'cancelled')", name="status"),
        # The stale sweep: running rows whose heartbeat is old.
        Index(
            "ix_llm_runs_heartbeat_at",
            "heartbeat_at",
            postgresql_where=text("status = 'running'"),
        ),
        # A running row whose heartbeat died holds this index forever, and every later Generate for
        # its meeting is a 409. So the stale sweep (services/llm_runs.py) fails dead rows before
        # any claim inserts, never only at startup.
        Index(
            ONE_RUNNING_NOTES_RUN_INDEX,
            "meeting_id",
            unique=True,
            postgresql_where=text("kind = 'notes' AND status = 'running'"),
        ),
    )

    # For a notes run, the id the desktop made before its first attempt: a retry re-sends it and
    # attaches to this run instead of starting a second paid one.
    id: Mapped[UUID] = mapped_column(primary_key=True)
    workspace_id: Mapped[UUID] = mapped_column(ForeignKey("workspaces.id"))
    meeting_id: Mapped[UUID] = mapped_column(ForeignKey("meetings.id", ondelete="CASCADE"))
    kind: Mapped[RunKind] = mapped_column(Text)
    status: Mapped[RunStatus] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    prompt_version: Mapped[str] = mapped_column(Text)
    template_id: Mapped[str | None] = mapped_column(Text)
    line_count: Mapped[int] = mapped_column(Integer)
    # The note versions the run was asked to build on; a stale one is a 409 before it starts.
    user_notes_version: Mapped[int | None] = mapped_column(Integer)
    ai_base_version: Mapped[int | None] = mapped_column(Integer)
    # The prompt's short refs (`L12`, `N3`) to what they stand for, so every citation the model
    # writes is checked against exactly the sources it was shown. `none_as_null` on a NOT NULL
    # column too: plain JSONB writes a Python None as the JSON literal `null`, which NOT NULL lets
    # through, and the 'required' map reads back as None. Here the insert fails instead.
    ref_map: Mapped[dict[str, Any]] = mapped_column(JSONB(none_as_null=True))
    output_text: Mapped[str | None] = mapped_column(Text)
    # Python None is stored as SQL NULL, not as the JSON literal `null` (`IS NULL` misses that).
    output_doc: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    # The AI doc this run replaced, read under the meeting row lock when the new doc is written:
    # "Restore previous notes" puts it back.
    replaced_doc: Mapped[dict[str, Any] | None] = mapped_column(JSONB(none_as_null=True))
    dropped: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB(none_as_null=True))
    flagged_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    from_notes_count: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    error_code: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cached_tokens: Mapped[int | None] = mapped_column(Integer)
    # None when the vendor sent no usage, never 0: a 0 reads as a free run. The characters / 4
    # budget estimate is never stored here either.
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric)
    # Both default to the database clock. Write later heartbeats with now() too and sweep against
    # now() - 2 minutes: with one clock, a skewed API host clock cannot fail a live run.
    heartbeat_at: Mapped[datetime] = _now()
    started_at: Mapped[datetime] = _now()
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# Run history per meeting, newest first.
Index("ix_llm_runs_meeting_id_started_at", LlmRun.meeting_id, LlmRun.started_at.desc())


class MeetingNote(Base):
    """One doc per meeting and kind. The run claim and every write of the `ai` row lock the
    meeting row first (`SELECT ... FOR UPDATE`): the meeting row exists before any note row, so it
    is the one lock both paths can take, and a PUT lands wholly before a claim or after it."""

    __tablename__ = "meeting_notes"
    __table_args__ = (
        CheckConstraint("kind IN ('user', 'ai')", name="kind"),
        UniqueConstraint("meeting_id", "kind"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    workspace_id: Mapped[UUID] = mapped_column(ForeignKey("workspaces.id"))
    meeting_id: Mapped[UUID] = mapped_column(ForeignKey("meetings.id", ondelete="CASCADE"))
    kind: Mapped[NoteKind] = mapped_column(Text)
    # NOT NULL, and `none_as_null` so a None doc fails the insert (see `LlmRun.ref_map`).
    doc: Mapped[dict[str, Any]] = mapped_column(JSONB(none_as_null=True))
    version: Mapped[int] = mapped_column(Integer)
    # The revision of the write that made this version: the same id sent again is a re-send.
    last_revision_id: Mapped[UUID]
    template_id: Mapped[str | None] = mapped_column(Text)
    last_run_id: Mapped[UUID | None] = mapped_column(ForeignKey("llm_runs.id", ondelete="SET NULL"))
    # The version `last_run_id` wrote (ai only). A higher `version` means the AI notes were edited
    # since that run, so regenerating asks first.
    generated_version: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    __table_args__ = (
        CheckConstraint("role IN ('user', 'assistant')", name="role"),
        CheckConstraint("status IN ('complete', 'streaming', 'failed')", name="status"),
        # The thread, oldest first.
        Index("ix_chat_messages_meeting_id_created_at", "meeting_id", "created_at"),
    )

    # The message id the desktop made, so a re-sent question never stores a second message.
    id: Mapped[UUID] = mapped_column(primary_key=True)
    workspace_id: Mapped[UUID] = mapped_column(ForeignKey("workspaces.id"))
    meeting_id: Mapped[UUID] = mapped_column(ForeignKey("meetings.id", ondelete="CASCADE"))
    role: Mapped[ChatRole] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text)
    citations: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB(none_as_null=True))
    # The question an answer replies to.
    reply_to: Mapped[UUID | None]
    run_id: Mapped[UUID | None] = mapped_column(ForeignKey("llm_runs.id"))
    status: Mapped[ChatMessageStatus] = mapped_column(Text)
    created_at: Mapped[datetime] = _now()
