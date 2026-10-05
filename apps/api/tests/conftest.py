"""Fixtures. API tests run against a real Postgres at TEST_DATABASE_URL, migrated by Alembic."""

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from alembic import command
from alembic.config import Config
from asgi_lifespan import LifespanManager
from fastapi import FastAPI
from pydantic_settings import BaseSettings, PydanticBaseSettingsSource, SettingsConfigDict
from sqlalchemy import NullPool, text
from sqlalchemy.ext.asyncio import create_async_engine

from roger_api.app import create_app
from roger_api.config import REPO_ROOT_ENV_FILE, Settings
from roger_api.db.base import Base
from roger_api.db.engine import Database
from roger_api.db.models import Meeting, TranscriptSegment, Workspace
from tests.helpers import AUTH_HEADERS, BASE_URL, TEST_TOKEN

ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"


class TestDatabaseSettings(BaseSettings):
    """TEST_DATABASE_URL from the environment or the repo-root `.env`."""

    __test__ = False  # Not a test class, despite the name.
    model_config = SettingsConfigDict(env_file=REPO_ROOT_ENV_FILE, extra="ignore")

    test_database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/roger_test"


class IsolatedSettings(Settings):
    """Settings from constructor arguments only: no environment, no `.env`."""

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        return (init_settings,)


def alembic_config(database_url: str) -> Config:
    config = Config(str(ALEMBIC_INI))
    config.attributes["database_url"] = database_url
    config.attributes["configure_logger"] = False
    return config


@pytest.fixture(scope="session")
def database_url() -> str:
    """The test database, with the schema built by the real migrations (down, then up)."""
    url = TestDatabaseSettings().test_database_url
    config = alembic_config(url)
    command.upgrade(config, "head")
    command.downgrade(config, "base")
    command.upgrade(config, "head")
    return url


@pytest.fixture
async def clean_database(database_url: str) -> None:
    tables = ", ".join(table.name for table in Base.metadata.sorted_tables)
    engine = create_async_engine(database_url, poolclass=NullPool)
    async with engine.begin() as connection:
        await connection.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    await engine.dispose()


def make_settings(database_url: str, **overrides: object) -> Settings:
    values: dict[str, object] = {
        "database_url": database_url,
        "roger_api_token": TEST_TOKEN,
        "stt_provider": "fake",
        **overrides,
    }
    return IsolatedSettings.model_validate(values)


@pytest.fixture
def settings(database_url: str) -> Settings:
    return make_settings(database_url)


@pytest.fixture
async def app(settings: Settings, clean_database: None) -> AsyncIterator[FastAPI]:
    application = create_app(settings)
    async with LifespanManager(application):
        yield application


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    """An authenticated client."""
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=BASE_URL, headers=AUTH_HEADERS
    ) as http:
        yield http


@pytest.fixture
async def anonymous_client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=BASE_URL) as http:
        yield http


@pytest.fixture
async def foreign_meeting_id(app: FastAPI) -> UUID:
    """A meeting, with one segment, that belongs to a different workspace."""
    database = app.state.database
    assert isinstance(database, Database)
    workspace_id, meeting_id = uuid4(), uuid4()
    async with database.session() as session:
        session.add(Workspace(id=workspace_id, name="Someone else"))
        await session.flush()
        session.add(
            Meeting(
                id=meeting_id,
                workspace_id=workspace_id,
                title="Not yours",
                status="recording",
                started_at=datetime.now(UTC) + timedelta(days=1),
            )
        )
        await session.flush()
        session.add(
            TranscriptSegment(
                id=uuid4(),
                meeting_id=meeting_id,
                workspace_id=workspace_id,
                source="mic",
                speaker="me",
                start_ms=0,
                end_ms=10,
                text="Private.",
            )
        )
        await session.commit()
    return meeting_id
