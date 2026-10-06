from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy.exc import SQLAlchemyError
from starlette.routing import Route

from roger_api.auth import default_principal
from roger_api.config import Settings, get_settings
from roger_api.db.engine import Database
from roger_api.error_handlers import register_error_handlers
from roger_api.log import configure_logging, get_logger
from roger_api.mcp_server import McpDependencies, build_mcp_http_app, build_mcp_server
from roger_api.middleware import RequestContextMiddleware
from roger_api.routers import health, meetings, stt
from roger_api.services.stt_tokens import open_stt_token_issuer
from roger_api.services.workspaces import ensure_workspace

logger = get_logger(__name__)

MCP_PATH = "/mcp"


async def _prepare_database(database: Database, settings: Settings) -> None:
    try:
        async with database.session() as session:
            await ensure_workspace(
                session, settings.default_workspace_id, settings.default_workspace_name
            )
    except (SQLAlchemyError, OSError):
        logger.error(
            "database_not_ready",
            hint="Is Postgres running and migrated? Try: make dev-db && make migrate",
        )
        raise


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings)

    # Building these does no I/O; connections are opened on first use, closed in the lifespan.
    database = Database(settings.database_url)
    # The MCP principal is fixed here, once: right for M1, where one shared secret means one
    # principal. When M6 gives each user a token, `get_principal` (auth.py) will resolve REST
    # callers per request, but this line would still hand every MCP caller the default
    # workspace. Resolve it per request in `BearerAuthMiddleware` (mcp_server.py) in that change.
    mcp = build_mcp_server(
        McpDependencies(database=database, principal=default_principal(settings))
    )
    mcp_http_app = build_mcp_http_app(mcp, settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            await _prepare_database(database, settings)
            async with open_stt_token_issuer(settings) as issuer, mcp.session_manager.run():
                app.state.stt_token_issuer = issuer
                logger.info(
                    "api_started",
                    version=settings.app_version,
                    app_env=settings.app_env,
                    stt_provider=settings.stt_provider,
                    stt_model=settings.stt_stream_model,
                )
                yield
        finally:
            await database.dispose()

    app = FastAPI(title="Roger API", version=settings.app_version, lifespan=lifespan)
    app.state.settings = settings
    app.state.database = database
    app.add_middleware(RequestContextMiddleware)
    register_error_handlers(app)
    app.include_router(health.router)
    app.include_router(meetings.router)
    app.include_router(stt.router)
    # A plain route keeps the endpoint at exactly /mcp (no slash redirect) and leaves every
    # other path to FastAPI, so unknown paths still get the 404 envelope.
    app.router.routes.append(Route(MCP_PATH, endpoint=mcp_http_app))
    return app
