"""Create vocabulary terms

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-06 12:00:00.000000+00:00

The workspace jargon list (M3-T2), filled in place of P2-F2's empty stub, in the same commit as
db/models_vocabulary.py.

The id, this file's name and down_revision are fixed in docs/plans/phase-2-build-order.md,
section 2, so every Phase 2 worktree has the whole chain and one head. Never re-point
down_revision: tests/test_migrations.py pins the chain.

Filled in place, so a database migrated while this stub was empty already sits past it:
`alembic upgrade head` skips the new tables and `downgrade` fails on them (UndefinedTable).
tests/conftest.py rebuilds its database every run (prepare_test_database). Any other
database, the dev `roger` included, needs one repair once the fill lands:
`alembic stamp 0001`, then `alembic upgrade head`. Stamp further back when an earlier stub
was also filled since that database was last migrated (apps/api/README.md, Migrations).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "vocabulary_terms",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("term", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        # 50 is MAX_TERM_LENGTH in db/models_vocabulary.py, copied: a migration never imports
        # models, which keep changing after it has run.
        sa.CheckConstraint(
            "char_length(term) BETWEEN 1 AND 50", name=op.f("ck_vocabulary_terms_term_length")
        ),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            name=op.f("fk_vocabulary_terms_workspace_id_workspaces"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_vocabulary_terms")),
    )
    op.create_index(
        "ix_vocabulary_terms_workspace_id_lower_term",
        "vocabulary_terms",
        ["workspace_id", sa.literal_column("lower(term)")],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_vocabulary_terms_workspace_id_lower_term", table_name="vocabulary_terms")
    op.drop_table("vocabulary_terms")
