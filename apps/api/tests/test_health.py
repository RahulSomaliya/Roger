from collections.abc import AsyncIterator

import httpx
from fastapi import FastAPI

from roger_api import __version__
from roger_api.db.engine import Database
from roger_api.dependencies import get_database

UNREACHABLE_DATABASE_URL = "postgresql+asyncpg://postgres@127.0.0.1:1/unreachable"


async def test_health_reports_ok_without_auth(anonymous_client: httpx.AsyncClient) -> None:
    response = await anonymous_client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "version": __version__, "database": "ok"}


async def test_health_is_503_when_postgres_is_unreachable(
    app: FastAPI, anonymous_client: httpx.AsyncClient
) -> None:
    unreachable = Database(UNREACHABLE_DATABASE_URL)

    async def override() -> AsyncIterator[Database]:
        yield unreachable

    app.dependency_overrides[get_database] = override
    try:
        response = await anonymous_client.get("/health")
    finally:
        await unreachable.dispose()

    assert response.status_code == 503
    assert response.json() == {"status": "error", "version": __version__, "database": "error"}
