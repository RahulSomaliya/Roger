"""Create workspaces, meetings and transcript segments

Revision ID: 0001
Revises:
Create Date: 2026-10-05 12:21:33.307642+00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "workspaces",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_workspaces")),
    )
    op.create_table(
        "meetings",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.CheckConstraint("status IN ('recording', 'ended')", name=op.f("ck_meetings_status")),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_meetings_workspace_id_workspaces"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_meetings")),
    )
    op.create_index(
        "ix_meetings_workspace_id_started_at",
        "meetings",
        ["workspace_id", sa.literal_column("started_at DESC")],
        unique=False,
    )
    op.create_table(
        "transcript_segments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("speaker", sa.Text(), nullable=False),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("end_ms", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("confidence", sa.REAL(), nullable=True),
        sa.Column("words", postgresql.JSONB(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "source IN ('mic', 'system')", name=op.f("ck_transcript_segments_source")
        ),
        sa.ForeignKeyConstraint(
            ["meeting_id"],
            ["meetings.id"],
            name=op.f("fk_transcript_segments_meeting_id_meetings"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_transcript_segments_workspace_id_workspaces"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_transcript_segments")),
    )
    op.create_index(
        "ix_transcript_segments_meeting_id_start_ms",
        "transcript_segments",
        ["meeting_id", "start_ms"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_transcript_segments_meeting_id_start_ms", table_name="transcript_segments")
    op.drop_table("transcript_segments")
    op.drop_index("ix_meetings_workspace_id_started_at", table_name="meetings")
    op.drop_table("meetings")
    op.drop_table("workspaces")
