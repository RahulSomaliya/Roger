"""Create meeting notes, LLM runs and chat messages (stub, empty until M4-T1)

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-06 12:00:00.000000+00:00

Stub from P2-F2; owned by M4-T1, which fills upgrade() and downgrade() (`meeting_notes`,
`llm_runs`, `chat_messages`) in the same commit as db/models_notes.py.

The id, this file's name and down_revision are fixed in docs/plans/phase-2-build-order.md,
section 2, so every Phase 2 worktree has the whole chain and one head. Never re-point
down_revision: tests/test_migrations.py pins the chain.
"""

from collections.abc import Sequence

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
