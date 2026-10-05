from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import (
    REAL,
    CheckConstraint,
    DateTime,
    Dialect,
    ForeignKey,
    Index,
    Integer,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import TypeDecorator

from roger_api.db.base import Base
from roger_api.domain import AudioSource, MeetingStatus


class Real(TypeDecorator[float]):
    """Postgres `real` (float4). Reads drop float32 noise: 0.98, not 0.9800000190734863."""

    impl = REAL
    cache_ok = True

    def process_result_value(self, value: float | None, dialect: Dialect) -> float | None:
        return None if value is None else float(f"{value:.7g}")


def _created_at() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[UUID] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = _created_at()


class Meeting(Base):
    __tablename__ = "meetings"
    __table_args__ = (CheckConstraint("status IN ('recording', 'ended')", name="status"),)

    id: Mapped[UUID] = mapped_column(primary_key=True)
    workspace_id: Mapped[UUID] = mapped_column(ForeignKey("workspaces.id"))
    title: Mapped[str] = mapped_column(Text)
    status: Mapped[MeetingStatus] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


# Newest-first listing per workspace.
Index("ix_meetings_workspace_id_started_at", Meeting.workspace_id, Meeting.started_at.desc())


class TranscriptSegment(Base):
    __tablename__ = "transcript_segments"
    __table_args__ = (
        CheckConstraint("source IN ('mic', 'system')", name="source"),
        Index("ix_transcript_segments_meeting_id_start_ms", "meeting_id", "start_ms"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    meeting_id: Mapped[UUID] = mapped_column(ForeignKey("meetings.id", ondelete="CASCADE"))
    workspace_id: Mapped[UUID] = mapped_column(ForeignKey("workspaces.id"))
    source: Mapped[AudioSource] = mapped_column(Text)
    speaker: Mapped[str] = mapped_column(Text)
    start_ms: Mapped[int] = mapped_column(Integer)
    end_ms: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    confidence: Mapped[float | None] = mapped_column(Real)
    # Python None is stored as SQL NULL, not as the JSON literal `null`.
    words: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB(none_as_null=True))
    created_at: Mapped[datetime] = _created_at()
