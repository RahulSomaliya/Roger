from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import Connection, NullPool
from sqlalchemy.ext.asyncio import create_async_engine

from roger_api.db.base import Base


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
