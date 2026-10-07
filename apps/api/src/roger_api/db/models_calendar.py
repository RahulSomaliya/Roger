"""Calendar tables (M5-T1, revision 0004): `calendar_connections` and `meeting_attendees`.

The new `meetings` columns (`start_source` and the calendar event link) are on `Meeting` in
db/models.py. That module imports this one at its end, so Alembic and the test truncation see every
table declared here. Every row carries `workspace_id` (house rule 2).
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from roger_api.config_calendar import CalendarProviderName
from roger_api.db.base import Base

# Also the `status` check constraint below and in revision 0004; change the three together.
type CalendarConnectionStatus = Literal["active", "reconnect_required"]
# The contract's ResponseStatus.
type AttendeeResponseStatus = Literal["accepted", "tentative", "declined", "needs_action"]


class CalendarConnection(Base):
    """One account's calendar access for a workspace (and, from M6, a user)."""

    __tablename__ = "calendar_connections"
    __table_args__ = (
        CheckConstraint("provider IN ('google', 'fake')", name="provider"),
        CheckConstraint("status IN ('active', 'reconnect_required')", name="status"),
        # One connection per workspace and user; connecting again replaces it. NULLS NOT DISTINCT
        # because user_id is NULL on every row until M6: a plain unique constraint counts two
        # NULLs as different and would let one workspace pile up connections.
        UniqueConstraint("workspace_id", "user_id", postgresql_nulls_not_distinct=True),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True)
    workspace_id: Mapped[UUID] = mapped_column(ForeignKey("workspaces.id"))
    # M6 brings users (and this foreign key); until then a connection is the workspace's.
    user_id: Mapped[UUID | None] = mapped_column()
    provider: Mapped[CalendarProviderName] = mapped_column(Text)
    account_email: Mapped[str] = mapped_column(Text)
    # The scopes Google granted, space separated, as its token endpoint returns them.
    scopes: Mapped[str] = mapped_column(Text)
    # pgp_sym_encrypt(refresh token, CALENDAR_TOKEN_KEY), never the token itself. NULL only for the
    # fake provider, which has no token.
    refresh_token: Mapped[bytes | None] = mapped_column(LargeBinary)
    status: Mapped[CalendarConnectionStatus] = mapped_column(Text)
    last_error: Mapped[str | None] = mapped_column(Text)
    connected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class MeetingAttendee(Base):
    """One invitee of the calendar event a meeting was started for, in invite order."""

    __tablename__ = "meeting_attendees"
    # Also the index for the one attendee query a page of meetings makes
    # (WHERE meeting_id IN (...) ORDER BY meeting_id, position); M5 adds no other.
    __table_args__ = (UniqueConstraint("meeting_id", "position"),)

    id: Mapped[UUID] = mapped_column(primary_key=True)
    workspace_id: Mapped[UUID] = mapped_column(ForeignKey("workspaces.id"))
    meeting_id: Mapped[UUID] = mapped_column(ForeignKey("meetings.id", ondelete="CASCADE"))
    # 0-based place in the invite's attendee list.
    position: Mapped[int] = mapped_column(Integer)
    email: Mapped[str] = mapped_column(Text)
    display_name: Mapped[str | None] = mapped_column(Text)
    response_status: Mapped[AttendeeResponseStatus] = mapped_column(Text)
    is_self: Mapped[bool] = mapped_column()
    is_organizer: Mapped[bool] = mapped_column()
