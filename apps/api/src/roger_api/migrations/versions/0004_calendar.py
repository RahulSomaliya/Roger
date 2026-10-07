"""Create calendar connections and meeting attendees, and link meetings to their event

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-06 12:00:00.000000+00:00

Owned by M5-T1, filled in place of P2-F2's stub, in the same commit as db/models_calendar.py and
the new Meeting columns in db/models.py: `pgcrypto`, `calendar_connections`, `meeting_attendees`,
and on `meetings` the five-value `start_source` and the calendar event link.

The id, this file's name and down_revision are fixed in docs/plans/phase-2-build-order.md,
section 2, so every Phase 2 worktree has the whole chain and one head. Never re-point
down_revision: tests/test_migrations.py pins the chain.

Filled in place, so a database migrated while this stub was empty already sits past it:
`alembic upgrade head` skips the new tables and `downgrade` fails on them (UndefinedTable).
tests/conftest.py rebuilds its database every run (prepare_test_database). Any other
database, the dev `roger` included, needs one repair once the fill lands:
`alembic stamp 0003`, then `alembic upgrade head`. Stamp further back when an earlier stub
was also filled since that database was last migrated (apps/api/README.md, Migrations).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # pgp_sym_encrypt and pgp_sym_decrypt for calendar_connections.refresh_token. A trusted
    # extension since Postgres 13, so the database owner may create it; IF NOT EXISTS because the
    # downgrade below leaves it in place.
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    op.create_table(
        "calendar_connections",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("account_email", sa.Text(), nullable=False),
        sa.Column("scopes", sa.Text(), nullable=False),
        sa.Column("refresh_token", sa.LargeBinary(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("connected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "provider IN ('google', 'fake')", name=op.f("ck_calendar_connections_provider")
        ),
        sa.CheckConstraint(
            "status IN ('active', 'reconnect_required')",
            name=op.f("ck_calendar_connections_status"),
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_calendar_connections_workspace_id_workspaces"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_calendar_connections")),
        # NULLS NOT DISTINCT (Postgres 15+): user_id is NULL on every row until M6, and a plain
        # unique constraint would let one workspace hold any number of connections.
        sa.UniqueConstraint(
            "workspace_id",
            "user_id",
            name=op.f("uq_calendar_connections_workspace_id_user_id"),
            postgresql_nulls_not_distinct=True,
        ),
    )
    # NOT NULL with a server default, so every meeting already in the table reads `manual`.
    # Without the default this ADD COLUMN fails on any database that has meetings, and the tests,
    # which migrate an empty one, would never show it
    # (test_calendar_schema.py::test_existing_meetings_read_manual_after_the_upgrade).
    op.add_column(
        "meetings",
        sa.Column("start_source", sa.Text(), server_default=sa.text("'manual'"), nullable=False),
    )
    op.create_check_constraint(
        op.f("ck_meetings_start_source"),
        "meetings",
        "start_source IN ('manual', 'notification', 'home', 'tray', 'call_detected')",
    )
    # The calendar event link, all nullable: a meeting started without an event has none.
    op.add_column("meetings", sa.Column("calendar_provider", sa.Text(), nullable=True))
    op.add_column("meetings", sa.Column("calendar_event_id", sa.Text(), nullable=True))
    op.add_column("meetings", sa.Column("calendar_ical_uid", sa.Text(), nullable=True))
    op.add_column("meetings", sa.Column("calendar_recurring_event_id", sa.Text(), nullable=True))
    op.add_column(
        "meetings", sa.Column("scheduled_start_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "meetings", sa.Column("scheduled_end_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_table(
        "meeting_attendees",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=True),
        sa.Column("response_status", sa.Text(), nullable=False),
        sa.Column("is_self", sa.Boolean(), nullable=False),
        sa.Column("is_organizer", sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(
            ["meeting_id"],
            ["meetings.id"],
            name=op.f("fk_meeting_attendees_meeting_id_meetings"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_meeting_attendees_workspace_id_workspaces"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_meeting_attendees")),
        sa.UniqueConstraint(
            "meeting_id", "position", name=op.f("uq_meeting_attendees_meeting_id_position")
        ),
    )


def downgrade() -> None:
    op.drop_table("meeting_attendees")
    op.drop_column("meetings", "scheduled_end_at")
    op.drop_column("meetings", "scheduled_start_at")
    op.drop_column("meetings", "calendar_recurring_event_id")
    op.drop_column("meetings", "calendar_ical_uid")
    op.drop_column("meetings", "calendar_event_id")
    op.drop_column("meetings", "calendar_provider")
    op.drop_constraint(op.f("ck_meetings_start_source"), "meetings", type_="check")
    op.drop_column("meetings", "start_source")
    op.drop_table("calendar_connections")
    # pgcrypto stays: an extension belongs to the database, not to this revision, and dropping it
    # would break anything else in the database that calls pgp_sym_*. The upgrade's IF NOT EXISTS
    # makes upgrading again safe.
