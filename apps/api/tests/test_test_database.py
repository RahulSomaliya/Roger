"""The suite's own database guard: it only runs against a `roger_test*` database, made if missing.

Parallel worktrees share one Postgres (`make dev-db`), each with `make check TEST_DB=<name>`. The
session migrates that database down to base and truncates it, so a name like `roger` (the dev
database) must be refused before anything connects.
"""

import asyncio
from uuid import uuid4

import pytest
from sqlalchemy import NullPool, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from tests.conftest import ensure_test_database, require_test_database_name

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
        ensure_test_database("postgresql+asyncpg://postgres:postgres@127.0.0.1:1/roger")


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


async def _drop_database(server_url: str, name: str) -> None:
    engine = create_async_engine(server_url, poolclass=NullPool, isolation_level="AUTOCOMMIT")
    try:
        async with engine.connect() as connection:
            quoted = connection.dialect.identifier_preparer.quote_identifier(name)
            await connection.execute(text(f"DROP DATABASE IF EXISTS {quoted}"))
    finally:
        await engine.dispose()


def test_a_missing_test_database_is_created(database_url: str) -> None:
    """Sync on purpose: `ensure_test_database` runs its own event loop, like the session fixture."""
    name = f"roger_test_created_{uuid4().hex[:12]}"
    url = make_url(database_url)
    missing = url.set(database=name).render_as_string(hide_password=False)
    maintenance = url.set(database="postgres").render_as_string(hide_password=False)
    assert not asyncio.run(_database_exists(maintenance, name))
    try:
        ensure_test_database(missing)
        assert asyncio.run(_database_exists(maintenance, name))

        ensure_test_database(missing)  # a second run finds it and creates nothing
    finally:
        asyncio.run(_drop_database(maintenance, name))
