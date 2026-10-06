from pathlib import Path

from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection, NullPool
from sqlalchemy.ext.asyncio import create_async_engine

from roger_api.db.base import Base
from tests.conftest import ALEMBIC_INI

# revision: (file name, down_revision). Fixed in docs/plans/phase-2-build-order.md, section 2, so
# parallel worktrees never grow two heads. An owner fills its stub's upgrade() and downgrade() and
# never renames the file or re-points down_revision; a new revision adds a row there and here.
FIXED_CHAIN = {
    "0001": ("0001_initial_schema.py", None),
    "0002": ("0002_vocabulary_terms.py", "0001"),  # M3-T2
    "0003": ("0003_notes.py", "0002"),  # M4-T1
    "0004": ("0004_calendar.py", "0003"),  # M5-T1
    "0005": ("0005_stt_usage.py", "0004"),  # M3-T19a
}


def _scripts() -> ScriptDirectory:
    return ScriptDirectory.from_config(Config(str(ALEMBIC_INI)))


def _diff(connection: Connection) -> list[object]:
    context = MigrationContext.configure(connection)
    return list(compare_metadata(context, Base.metadata))


async def test_models_match_the_migrations(database_url: str) -> None:
    """`alembic upgrade head` (run by the `database_url` fixture) builds exactly the models."""
    engine = create_async_engine(database_url, poolclass=NullPool)
    async with engine.connect() as connection:
        diff = await connection.run_sync(_diff)
    await engine.dispose()

    assert diff == []


def test_alembic_has_one_head() -> None:
    heads = _scripts().get_heads()

    assert len(heads) == 1, f"two branches of migrations: {heads}"


def test_revision_chain_is_fixed() -> None:
    chain = {
        script.revision: (Path(script.path).name, script.down_revision)
        for script in _scripts().walk_revisions()
    }

    assert chain == FIXED_CHAIN
