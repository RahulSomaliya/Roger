"""The MCP server: two read-only tools, `get_transcript` and `get_notes`, served over Streamable
HTTP at `/mcp`."""

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
from roger_api.db.models import Meeting
from roger_api.error_handlers import unauthorized_response
from roger_api.errors import NotFoundError
from roger_api.services import meetings, notes, segments
from roger_api.services.notes import MeetingNotes
from roger_api.services.notes_markdown import (
    FROM_YOUR_NOTES_HEADING,
    AiNotesMarkdown,
    render_ai_notes,
    render_markdown,
)
from roger_api.services.transcript_render import format_instant, render_transcript

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

# Part of the API contract (docs/api-contract.md). Change it there first.
GET_NOTES_DESCRIPTION = (
    "Get the notes for a meeting: the AI-written notes and the user's own rough notes, as "
    "Markdown. Each AI line ends with the transcript times it came from, like [00:12:03]. Notes "
    "are a summary: to quote what someone said, call get_transcript and use its exact words. If "
    "meeting_id is omitted, returns the most recent meeting."
)

MEETING_NOT_FOUND = "Meeting not found"
NO_MEETINGS_YET = "No meetings yet"

# Every tool's one argument, resolved by `_target_meeting_id`.
MeetingIdArgument = Annotated[
    str | None, Field(description="Meeting UUID. Omit it to get the most recent meeting.")
]

AI_NOTES_HEADING = "AI notes"
MY_NOTES_HEADING = "My notes"
NO_AI_NOTES_YET = "(No AI notes yet.)"
# AI notes whose every line only the user's notes back (a meeting where nobody spoke): "yet" would
# say a run is still to come when it already ran.
NO_AI_NOTES_FROM_THE_TRANSCRIPT = f"(No lines from the transcript. See {FROM_YOUR_NOTES_HEADING}.)"
NO_NOTES_YET = "(No notes yet.)"

# The SDK's own localhost allowlist, kept when MCP_ALLOWED_HOSTS adds deployment hostnames.
_LOCAL_HOSTS = ["127.0.0.1:*", "localhost:*", "[::1]:*"]
_LOCAL_ORIGINS = ["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*"]


@dataclass(frozen=True, slots=True)
class McpDependencies:
    database: Database
    principal: Principal


async def _target_meeting_id(
    session: AsyncSession, principal: Principal, meeting_id: str | None
) -> UUID | None:
    """The meeting a tool reads: `meeting_id`, or the latest one in the workspace when it is None.

    None when it is None and the workspace has no meeting. An id that is not a UUID is a ToolError
    here, and the tool's own read raises NotFoundError for one outside the workspace, so every
    tool answers any unknown id with the same "Meeting not found".
    """
    if meeting_id is None:
        latest = await meetings.list_meetings(session, principal, limit=1)
        return latest[0].meeting.id if latest else None
    try:
        return UUID(meeting_id)
    except ValueError as exc:
        raise ToolError(MEETING_NOT_FOUND) from exc


async def read_transcript_text(
    session: AsyncSession, principal: Principal, meeting_id: str | None
) -> str:
    """The rendered transcript for `meeting_id`, or for the latest meeting when it is None."""
    target = await _target_meeting_id(session, principal, meeting_id)
    if target is None:
        return NO_MEETINGS_YET
    try:
        transcript = await segments.get_transcript_lines(session, principal, target)
    except NotFoundError as exc:
        raise ToolError(MEETING_NOT_FOUND) from exc
    return render_transcript(transcript)


async def read_notes_text(
    session: AsyncSession, principal: Principal, meeting_id: str | None
) -> str:
    """The rendered notes for `meeting_id`, or for the latest meeting when it is None."""
    target = await _target_meeting_id(session, principal, meeting_id)
    if target is None:
        return NO_MEETINGS_YET
    try:
        meeting = await meetings.require_meeting(session, principal, target)
        meeting_notes = await notes.get_notes(session, principal, target)
    except NotFoundError as exc:
        raise ToolError(MEETING_NOT_FOUND) from exc
    return render_notes(meeting, meeting_notes)


def render_notes(meeting: Meeting, meeting_notes: MeetingNotes) -> str:
    """A header, then "AI notes", "From your notes" (only when the AI notes end with that list)
    and "My notes", as Markdown.

    Each citation chip renders as the `[hh:mm:ss]` offset `get_transcript` prints for its line
    (`notes_markdown.py`), so an AI can find the words behind a note. A `weak` chip, the app's
    "check this" flag, renders like an `ok` one: a cue for MCP is a product call nobody has made
    (phase-2-build-order.md, section 10). Adding one changes the contract's get_notes output.
    """
    ended = format_instant(meeting.ended_at) if meeting.ended_at else "still recording"
    header = (
        f"Meeting: {meeting.title}\n"
        f"Meeting ID: {meeting.id}\n"
        f"Started: {format_instant(meeting.started_at)}   Ended: {ended}"
    )
    ai = (
        AiNotesMarkdown(notes="", from_your_notes="")
        if meeting_notes.ai is None
        else render_ai_notes(meeting_notes.ai.doc)
    )
    empty_ai = NO_AI_NOTES_FROM_THE_TRANSCRIPT if ai.from_your_notes else NO_AI_NOTES_YET
    parts = [header, f"# {AI_NOTES_HEADING}", ai.notes or empty_ai]
    if ai.from_your_notes:
        parts += [f"# {FROM_YOUR_NOTES_HEADING}", ai.from_your_notes]
    mine = "" if meeting_notes.user is None else render_markdown(meeting_notes.user.doc)
    parts += [f"# {MY_NOTES_HEADING}", mine or NO_NOTES_YET]
    return "\n\n".join(parts)


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
        ctx: Context[McpDependencies], meeting_id: MeetingIdArgument = None
    ) -> str:
        deps = ctx.request_context.lifespan_context
        async with deps.database.session() as session:
            return await read_transcript_text(session, deps.principal, meeting_id)

    @mcp.tool(
        description=GET_NOTES_DESCRIPTION,
        annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False),
        structured_output=False,
    )
    async def get_notes(ctx: Context[McpDependencies], meeting_id: MeetingIdArgument = None) -> str:
        deps = ctx.request_context.lifespan_context
        async with deps.database.session() as session:
            return await read_notes_text(session, deps.principal, meeting_id)

    return mcp


class BearerAuthMiddleware:
    """Rejects HTTP requests without `Authorization: Bearer <token>` with the 401 envelope.

    It checks the token, then forgets who sent it: every tool uses the one principal `create_app`
    (app.py) fixed at startup. Right for M1's single shared secret. When M6 adds per-user tokens
    to `get_principal` (auth.py), this must resolve the principal from the token too and pass it
    to the tools per request, or every MCP caller silently reads the default workspace.
    """

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
