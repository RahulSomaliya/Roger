"""The suite's own database guard: it only runs against a `roger_test*` database, rebuilt each run.

Parallel worktrees share one Postgres (`make dev-db`), each with `make check TEST_DB=<name>`. The
session drops and recreates that database, so a name like `roger` (the dev database) must be
refused before anything connects.
"""

import asyncio
from uuid import uuid4

import pytest
from alembic import command
from sqlalchemy import NullPool, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from tests.conftest import alembic_config, prepare_test_database, require_test_database_name

SERVER = "postgresql+asyncpg://postgres:secret-password@localhost:5432"


@pytest.mark.parametrize(
    "name",
    [
        pytest.param("roger", id="dev-database"),
        pytest.param("postgres", id="maintenance-database"),
        pytest.param("rogertest", id="no-underscore"),
        pytest.param("my_roger_test", id="prefix-elsewhere"),
        pytest.param("Roger_test", id="other-case"),
    ],
)
def test_a_database_not_named_roger_test_is_refused(name: str) -> None:
    with pytest.raises(ValueError, match=f"'{name}'") as raised:
        require_test_database_name(f"{SERVER}/{name}")

    assert "roger_test" in str(raised.value)
    assert "secret-password" not in str(raised.value)


def test_a_url_without_a_database_is_refused() -> None:
    with pytest.raises(ValueError, match="names no database"):
        require_test_database_name(SERVER)


@pytest.mark.parametrize("name", ["roger_test", "roger_test_p2_f2", "roger_test_integration"])
def test_a_roger_test_database_is_accepted(name: str) -> None:
    assert require_test_database_name(f"{SERVER}/{name}") == name


def test_the_refusal_comes_before_any_connection() -> None:
    # Nothing listens on port 1: a connection attempt would raise OSError, not the refusal.
    with pytest.raises(ValueError, match="'roger'"):
        prepare_test_database("postgresql+asyncpg://postgres:postgres@127.0.0.1:1/roger")


async def _database_exists(server_url: str, name: str) -> bool:
    engine = create_async_engine(server_url, poolclass=NullPool)
    try:
        async with engine.connect() as connection:
            found = await connection.scalar(
                text("SELECT 1 FROM pg_database WHERE datname = :name"), {"name": name}
            )
    finally:
        await engine.dispose()
    return found is not None


async def _execute(url: str, statement: str) -> None:
    # AUTOCOMMIT: CREATE and DROP DATABASE refuse to run inside a transaction.
    engine = create_async_engine(url, poolclass=NullPool, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as connection:
            await connection.execute(text(statement))
    finally:
        await engine.dispose()


async def _scalar(url: str, query: str) -> object:
    engine = create_async_engine(url, poolclass=NullPool)
    try:
        async with engine.connect() as connection:
            return await connection.scalar(text(query))
    finally:
        await engine.dispose()


def _scratch_database(database_url: str, label: str) -> tuple[str, str, str]:
    """(name, its URL, the maintenance URL) for a throwaway roger_test_<label>_<hex> database."""
    name = f"roger_test_{label}_{uuid4().hex[:12]}"
    url = make_url(database_url)
    return (
        name,
        url.set(database=name).render_as_string(hide_password=False),
        url.set(database="postgres").render_as_string(hide_password=False),
    )


def test_a_missing_test_database_is_created_and_migrated(database_url: str) -> None:
    """Sync on purpose: `prepare_test_database` runs its own event loop, as in the session."""
    name, missing, maintenance = _scratch_database(database_url, "created")
    assert not asyncio.run(_database_exists(maintenance, name))
    try:
        prepare_test_database(missing)

        assert asyncio.run(_database_exists(maintenance, name))
        assert asyncio.run(_scalar(missing, "SELECT to_regclass('workspaces') IS NOT NULL"))
    finally:
        asyncio.run(_execute(maintenance, f'DROP DATABASE IF EXISTS "{name}"'))


def test_a_database_migrated_before_a_stub_was_filled_is_rebuilt_from_empty(
    database_url: str,
) -> None:
    """The stubs 0002 to 0005 are filled in place. A database migrated while one was still empty
    sits at head without that stub's tables, so migrating it from there skips the filled upgrade()
    and runs the filled downgrade() against tables that were never created (UndefinedTable), and
    every test in the run errors. `alembic stamp head` on an empty database is that state with
    every table missing (0001's downgrade() fails the same way); the stray table stands for
    anything else an earlier run left."""
    name, stale, maintenance = _scratch_database(database_url, "stale")
    asyncio.run(_execute(maintenance, f'CREATE DATABASE "{name}"'))
    try:
        command.stamp(alembic_config(stale), "head")
        asyncio.run(_execute(stale, "CREATE TABLE left_by_an_earlier_run (id integer)"))

        prepare_test_database(stale)

        assert asyncio.run(_scalar(stale, "SELECT to_regclass('workspaces') IS NOT NULL"))
        assert asyncio.run(_scalar(stale, "SELECT to_regclass('left_by_an_earlier_run') IS NULL"))
    finally:
        asyncio.run(_execute(maintenance, f'DROP DATABASE IF EXISTS "{name}"'))
