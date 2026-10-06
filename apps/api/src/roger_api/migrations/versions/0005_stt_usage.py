"""Create STT usage (stub, empty until M3-T19a)

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-06 12:00:00.000000+00:00

Stub from P2-F2; owned by M3-T19a, which fills upgrade() and downgrade() (`stt_usage`) in the
same commit as db/models_stt_usage.py.

The id, this file's name and down_revision are fixed in docs/plans/phase-2-build-order.md,
section 2, so every Phase 2 worktree has the whole chain and one head. Never re-point
down_revision: tests/test_migrations.py pins the chain.
"""

from collections.abc import Sequence

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
