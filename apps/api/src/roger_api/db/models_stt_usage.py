"""The STT usage table: what each meeting's speech-to-text sessions used (`stt_usage`, revision
0005, M3-T19a).

`db/models.py` imports this module at its end, so Alembic and the test truncation see every table
declared here without anyone editing that file. Every row carries `workspace_id` (house rule 2).
"""

from datetime import datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from roger_api.db.base import Base

# `provider` and `stop_reason` are free text up to this many characters, never a list: the desktop
# names its vendors and stop reasons, and both change across releases (`page-reloaded` retired by
# M2-T12, `call-ended` added by M2-T17b). A list would refuse an older or newer Mac's rows with a
# 422 forever. The API refuses a longer text (schemas/stt_usage.py); this check is the database's
# own backstop. Migration 0005 copies the number, as migrations never import models.
MAX_USAGE_LABEL_LENGTH = 64


class MeetingSttUsage(Base):
    """One meeting's speech-to-text usage, as the desktop metered it: its totals and, in
    `by_source`, the same numbers per audio source (`mic`, `system`).

    No foreign key to `meetings`, on purpose: the desktop deletes a meeting that never got a line,
    but its sessions were billed, so its usage stays. Upserted whole by the desktop (one row per
    workspace and meeting), never added to here.
    """

    __tablename__ = "stt_usage"
    __table_args__ = (
        CheckConstraint(
            f"char_length(provider) BETWEEN 1 AND {MAX_USAGE_LABEL_LENGTH}", name="provider_length"
        ),
        CheckConstraint(
            f"char_length(stop_reason) BETWEEN 1 AND {MAX_USAGE_LABEL_LENGTH}",
            name="stop_reason_length",
        ),
        CheckConstraint(
            "sessions_opened >= 0 AND connected_ms >= 0 AND audio_sent_ms >= 0"
            " AND dropped_chunks >= 0 AND gated_ms >= 0 AND estimated_cost_usd >= 0",
            name="not_negative",
        ),
    )

    workspace_id: Mapped[UUID] = mapped_column(ForeignKey("workspaces.id"), primary_key=True)
    meeting_id: Mapped[UUID] = mapped_column(primary_key=True)
    provider: Mapped[str] = mapped_column(Text)
    sessions_opened: Mapped[int] = mapped_column(Integer)
    connected_ms: Mapped[int] = mapped_column(BigInteger)
    audio_sent_ms: Mapped[int] = mapped_column(BigInteger)
    dropped_chunks: Mapped[int] = mapped_column(Integer)
    # Stream time the silence gate kept closed (M3-T20); 0 for a meeting recorded without it.
    gated_ms: Mapped[int] = mapped_column(BigInteger, server_default="0")
    # The desktop's estimate at the price the API named in each session's token. None when a
    # session opened with no known price, never 0: a 0 reads as a free meeting, and the summary
    # names such meetings instead of summing them (services/stt_usage.py).
    estimated_cost_usd: Mapped[Decimal | None] = mapped_column(Numeric)
    by_source: Mapped[dict[str, Any]] = mapped_column(JSONB)
    stop_reason: Mapped[str | None] = mapped_column(Text)
    # The first upload. The summary's `since` counts a meeting the API has no row for (one with no
    # lines) from this instant; a later upload never moves it.
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
