import asyncio

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from roger_api.log import get_logger

logger = get_logger(__name__)


class Database:
    """The async engine and its session factory.

    Building it does no I/O: connections are opened on first use and closed by `dispose()`,
    which the app lifespan calls on shutdown.
    """

    def __init__(self, url: str) -> None:
        # hide_parameters: a failed statement renders its bind parameters into the error's text
        # ("[parameters: (...)]"), and middleware.py logs that text with every unhandled error.
        # The calendar store binds the Google refresh token and CALENDAR_TOKEN_KEY
        # (services/calendar/connections.py, which also keeps them out of production tracebacks).
        # Never turn it off: debug a statement with its SQL and SQLSTATE instead.
        self.engine = create_async_engine(url, pool_pre_ping=True, hide_parameters=True)
        self.session_factory = async_sessionmaker(self.engine, expire_on_commit=False)

    def session(self) -> AsyncSession:
        return self.session_factory()

    async def ping(self, timeout_s: float = 3.0) -> bool:
        try:
            async with asyncio.timeout(timeout_s), self.engine.connect() as connection:
                await connection.execute(text("SELECT 1"))
        except (SQLAlchemyError, OSError, TimeoutError) as exc:
            logger.warning("database_ping_failed", error=repr(exc))
            return False
        return True

    async def dispose(self) -> None:
        await self.engine.dispose()
