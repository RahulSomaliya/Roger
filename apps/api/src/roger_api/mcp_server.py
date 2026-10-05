"""The MCP server: one tool, `get_transcript`, served over Streamable HTTP at `/mcp`."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from mcp.server import MCPServer
from mcp.server.mcpserver import Context
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from roger_api import __version__
from roger_api.auth import UNAUTHORIZED_MESSAGE, Principal, verify_bearer
from roger_api.config import Settings
from roger_api.db.engine import Database
from roger_api.error_handlers import unauthorized_response
from roger_api.errors import NotFoundError
from roger_api.services import meetings, segments
from roger_api.services.transcript_render import render_transcript

SERVER_NAME = "roger"

SERVER_INSTRUCTIONS = (
    "Roger holds the full, word-for-word transcripts of the team's meetings. "
    "When you report what someone said, quote the transcript's exact words; never paraphrase "
    "inside quotation marks and never invent a quote. Never invent or guess a meeting id: omit "
    "meeting_id to get the most recent meeting, or use an id the user gave you or a previous "
    "result showed you."
)

# Part of the API contract (docs/api-contract.md). Change it there first.
GET_TRANSCRIPT_DESCRIPTION = (
    "Get the full, word-for-word transcript of a meeting as plain text with timestamps and "
    "speakers. Use this when you need what was actually said: quote the transcript's exact "
    "words rather than paraphrasing. If `meeting_id` is omitted, returns the most recent meeting."
)

MEETING_NOT_FOUND = "Meeting not found"
NO_MEETINGS_YET = "No meetings yet"

# The SDK's own localhost allowlist, kept when MCP_ALLOWED_HOSTS adds deployment hostnames.
_LOCAL_HOSTS = ["127.0.0.1:*", "localhost:*", "[::1]:*"]
_LOCAL_ORIGINS = ["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*"]


@dataclass(frozen=True, slots=True)
class McpDependencies:
    database: Database
    principal: Principal


async def read_transcript_text(
    session: AsyncSession, principal: Principal, meeting_id: str | None
) -> str:
    """The rendered transcript for `meeting_id`, or for the latest meeting when it is None."""
    if meeting_id is None:
        latest = await meetings.list_meetings(session, principal, limit=1)
        if not latest:
            return NO_MEETINGS_YET
        target = latest[0].meeting.id
    else:
        try:
            target = UUID(meeting_id)
        except ValueError as exc:
            raise ToolError(MEETING_NOT_FOUND) from exc
    try:
        transcript = await segments.get_transcript_lines(session, principal, target)
    except NotFoundError as exc:
        raise ToolError(MEETING_NOT_FOUND) from exc
    return render_transcript(transcript)


def build_mcp_server(dependencies: McpDependencies) -> MCPServer[McpDependencies]:
    @asynccontextmanager
    async def lifespan(_: MCPServer[McpDependencies]) -> AsyncIterator[McpDependencies]:
        yield dependencies

    mcp = MCPServer(
        SERVER_NAME, version=__version__, instructions=SERVER_INSTRUCTIONS, lifespan=lifespan
    )

    @mcp.tool(
        description=GET_TRANSCRIPT_DESCRIPTION,
        annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False),
        structured_output=False,
    )
    # Returns every line in one text block, so a multi-hour call can exceed an MCP client's
    # output cap and get cut off. "Full or a slice" is an M7 item (docs/roadmap.md).
    async def get_transcript(
        ctx: Context[McpDependencies],
        meeting_id: Annotated[
            str | None,
            Field(description="Meeting UUID. Omit it to get the most recent meeting."),
        ] = None,
    ) -> str:
        deps = ctx.request_context.lifespan_context
        async with deps.database.session() as session:
            return await read_transcript_text(session, deps.principal, meeting_id)

    return mcp


class BearerAuthMiddleware:
    """Rejects HTTP requests without `Authorization: Bearer <token>` with the 401 envelope."""

    def __init__(self, app: ASGIApp, *, token: str) -> None:
        self.app = app
        self._token = token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and not verify_bearer(
            Headers(scope=scope).get("Authorization"), self._token
        ):
            await unauthorized_response(UNAUTHORIZED_MESSAGE)(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _transport_security(settings: Settings) -> TransportSecuritySettings | None:
    if not settings.mcp_allowed_hosts:
        return None  # The SDK default: DNS-rebinding protection, localhost only.
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=[*_LOCAL_HOSTS, *settings.mcp_allowed_hosts],
        allowed_origins=_LOCAL_ORIGINS,
    )


def build_mcp_http_app(mcp: MCPServer[McpDependencies], settings: Settings) -> ASGIApp:
    """The Streamable HTTP app (endpoint `/mcp`) behind bearer auth.

    Stateless: no session lives in one process's memory, so any worker can serve any request.
    The host app's lifespan must enter `mcp.session_manager.run()`.
    """
    http_app = mcp.streamable_http_app(
        stateless_http=True, transport_security=_transport_security(settings)
    )
    return BearerAuthMiddleware(http_app, token=settings.roger_api_token.get_secret_value())
