"""Create calendar connections and meeting attendees (stub, empty until M5-T1)

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-06 12:00:00.000000+00:00

Stub from P2-F2; owned by M5-T1, which fills upgrade() and downgrade() (`pgcrypto`,
`calendar_connections`, `meeting_attendees`, the new `meetings` columns) in the same commit as
db/models_calendar.py and the new Meeting columns in db/models.py.

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

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
