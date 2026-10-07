"""Create meeting notes, LLM runs and chat messages

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-06 12:00:00.000000+00:00

The tables of db/models_notes.py (M4-T1). Every value list in a check constraint here is also a
Literal type (domain.py, db/models_notes.py); change the two together.

The id, this file's name and down_revision are fixed in docs/plans/phase-2-build-order.md,
section 2, so every Phase 2 worktree has the whole chain and one head. Never re-point
down_revision: tests/test_migrations.py pins the chain.

Filled in place, so a database migrated while this stub was empty already sits past it:
`alembic upgrade head` skips the new tables and `downgrade` fails on them (UndefinedTable).
tests/conftest.py rebuilds its database every run (prepare_test_database). Any other
database, the dev `roger` included, needs one repair once the fill lands:
`alembic stamp 0002`, then `alembic upgrade head`. Stamp further back when an earlier stub
was also filled since that database was last migrated (apps/api/README.md, Migrations).
"""

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import SchemaItem

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _now(name: str) -> sa.Column[datetime]:
    return sa.Column(
        name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def _owner_columns(table: str) -> list[SchemaItem]:
    """id, workspace_id and meeting_id, with the meeting's rows going when the meeting goes."""
    return [
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["meeting_id"],
            ["meetings.id"],
            name=op.f(f"fk_{table}_meeting_id_meetings"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f(f"fk_{table}_workspace_id_workspaces"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{table}")),
    ]


def upgrade() -> None:
    # llm_runs first: meeting_notes and chat_messages point at it.
    op.create_table(
        "llm_runs",
        *_owner_columns("llm_runs"),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("prompt_version", sa.Text(), nullable=False),
        sa.Column("template_id", sa.Text(), nullable=True),
        sa.Column("line_count", sa.Integer(), nullable=False),
        sa.Column("user_notes_version", sa.Integer(), nullable=True),
        sa.Column("ai_base_version", sa.Integer(), nullable=True),
        sa.Column("ref_map", postgresql.JSONB(), nullable=False),
        sa.Column("output_text", sa.Text(), nullable=True),
        sa.Column("output_doc", postgresql.JSONB(), nullable=True),
        sa.Column("replaced_doc", postgresql.JSONB(), nullable=True),
        sa.Column("dropped", postgresql.JSONB(), nullable=True),
        sa.Column("flagged_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("from_notes_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("cached_tokens", sa.Integer(), nullable=True),
        # NULL when the vendor sent no usage, never 0.
        sa.Column("cost_usd", sa.Numeric(), nullable=True),
        _now("heartbeat_at"),
        _now("started_at"),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("kind IN ('notes', 'chat')", name=op.f("ck_llm_runs_kind")),
        sa.CheckConstraint(
            "status IN ('running', 'succeeded', 'failed', 'cancelled')",
            name=op.f("ck_llm_runs_status"),
        ),
    )
    op.create_index(
        "ix_llm_runs_meeting_id_started_at",
        "llm_runs",
        ["meeting_id", sa.literal_column("started_at DESC")],
        unique=False,
    )
    op.create_index(
        "ix_llm_runs_heartbeat_at",
        "llm_runs",
        ["heartbeat_at"],
        unique=False,
        postgresql_where=sa.text("status = 'running'"),
    )
    # One running notes run per meeting (db/models_notes.py, ONE_RUNNING_NOTES_RUN_INDEX).
    op.create_index(
        "uq_llm_runs_meeting_id_running_notes",
        "llm_runs",
        ["meeting_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'notes' AND status = 'running'"),
    )
    op.create_table(
        "meeting_notes",
        *_owner_columns("meeting_notes"),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("doc", postgresql.JSONB(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("last_revision_id", sa.Uuid(), nullable=False),
        sa.Column("template_id", sa.Text(), nullable=True),
        sa.Column("last_run_id", sa.Uuid(), nullable=True),
        sa.Column("generated_version", sa.Integer(), nullable=True),
        _now("created_at"),
        _now("updated_at"),
        sa.CheckConstraint("kind IN ('user', 'ai')", name=op.f("ck_meeting_notes_kind")),
        sa.ForeignKeyConstraint(
            ["last_run_id"],
            ["llm_runs.id"],
            name=op.f("fk_meeting_notes_last_run_id_llm_runs"),
            ondelete="SET NULL",
        ),
        sa.UniqueConstraint("meeting_id", "kind", name=op.f("uq_meeting_notes_meeting_id_kind")),
    )
    op.create_table(
        "chat_messages",
        *_owner_columns("chat_messages"),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("citations", postgresql.JSONB(), nullable=True),
        sa.Column("reply_to", sa.Uuid(), nullable=True),
        sa.Column("run_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        _now("created_at"),
        sa.CheckConstraint("role IN ('user', 'assistant')", name=op.f("ck_chat_messages_role")),
        sa.CheckConstraint(
            "status IN ('complete', 'streaming', 'failed')", name=op.f("ck_chat_messages_status")
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["llm_runs.id"], name=op.f("fk_chat_messages_run_id_llm_runs")
        ),
    )
    op.create_index(
        "ix_chat_messages_meeting_id_created_at",
        "chat_messages",
        ["meeting_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_chat_messages_meeting_id_created_at", table_name="chat_messages")
    op.drop_table("chat_messages")
    op.drop_table("meeting_notes")
    op.drop_index("uq_llm_runs_meeting_id_running_notes", table_name="llm_runs")
    op.drop_index("ix_llm_runs_heartbeat_at", table_name="llm_runs")
    op.drop_index("ix_llm_runs_meeting_id_started_at", table_name="llm_runs")
    op.drop_table("llm_runs")
