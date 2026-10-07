"""Create STT usage

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-06 12:00:00.000000+00:00

What each meeting's speech-to-text sessions used, one row per workspace and meeting (M3-T19a),
filled in place of P2-F2's empty stub, in the same commit as db/models_stt_usage.py. No foreign
key to `meetings`: a meeting deleted for having no lines was still billed.

The id, this file's name and down_revision are fixed in docs/plans/phase-2-build-order.md,
section 2, so every Phase 2 worktree has the whole chain and one head. Never re-point
down_revision: tests/test_migrations.py pins the chain.

Filled in place, so a database migrated while this stub was empty already sits past it:
`alembic upgrade head` skips the new tables and `downgrade` fails on them (UndefinedTable).
tests/conftest.py rebuilds its database every run (prepare_test_database). Any other
database, the dev `roger` included, needs one repair once the fill lands:
`alembic stamp 0004`, then `alembic upgrade head`. Stamp further back when an earlier stub
was also filled since that database was last migrated (apps/api/README.md, Migrations).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "stt_usage",
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("meeting_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("sessions_opened", sa.Integer(), nullable=False),
        sa.Column("connected_ms", sa.BigInteger(), nullable=False),
        sa.Column("audio_sent_ms", sa.BigInteger(), nullable=False),
        sa.Column("dropped_chunks", sa.Integer(), nullable=False),
        sa.Column("gated_ms", sa.BigInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("estimated_cost_usd", sa.Numeric(), nullable=True),
        sa.Column("by_source", postgresql.JSONB(), nullable=False),
        sa.Column("stop_reason", sa.Text(), nullable=True),
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
        # 64 is MAX_USAGE_LABEL_LENGTH in db/models_stt_usage.py, copied: a migration never imports
        # models, which keep changing after it has run.
        sa.CheckConstraint(
            "char_length(provider) BETWEEN 1 AND 64", name=op.f("ck_stt_usage_provider_length")
        ),
        sa.CheckConstraint(
            "char_length(stop_reason) BETWEEN 1 AND 64",
            name=op.f("ck_stt_usage_stop_reason_length"),
        ),
        sa.CheckConstraint(
            "sessions_opened >= 0 AND connected_ms >= 0 AND audio_sent_ms >= 0"
            " AND dropped_chunks >= 0 AND gated_ms >= 0 AND estimated_cost_usd >= 0",
            name=op.f("ck_stt_usage_not_negative"),
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"], ["workspaces.id"], name=op.f("fk_stt_usage_workspace_id_workspaces")
        ),
        sa.PrimaryKeyConstraint("workspace_id", "meeting_id", name=op.f("pk_stt_usage")),
    )


def downgrade() -> None:
    op.drop_table("stt_usage")
