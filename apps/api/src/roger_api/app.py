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
from roger_api.routers import (
    calendar,
    chat,
    health,
    meetings,
    note_templates,
    notes,
    notes_runs,
    stt,
    stt_usage,
    vocabulary,
)
from roger_api.services.workspaces import ensure_workspace
from roger_api.stt_vendors import open_stt_token_issuer

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
                    stt_price_per_hour_usd=settings.stt_stream_price_per_hour_usd,
                )
                if settings.stt_stream_price_per_hour_usd is None:
                    logger.warning(
                        "stt_price_unknown",
                        stt_provider=settings.stt_provider,
                        stt_model=settings.stt_stream_model,
                        hint="Set STT_PRICE_PER_HOUR_USD so the desktop can meter cost",
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
    # Phase 2 feature routers, each a stub until its owner fills it (phase-2-build-order.md,
    # section 1). The owner sets prefix, tags and routes in its own module; nobody adds or moves
    # an include here (tests/test_app_layout.py).
    app.include_router(vocabulary.router)
    app.include_router(stt_usage.router)
    app.include_router(note_templates.router)
    app.include_router(notes.router)
    app.include_router(notes_runs.router)
    app.include_router(chat.router)
    app.include_router(calendar.router)
    # A plain route keeps the endpoint at exactly /mcp (no slash redirect) and leaves every
    # other path to FastAPI, so unknown paths still get the 404 envelope.
    app.router.routes.append(Route(MCP_PATH, endpoint=mcp_http_app))
    return app
