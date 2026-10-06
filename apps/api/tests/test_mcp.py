"""The MCP server through the SDK client, over Streamable HTTP into the real app."""

from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from uuid import UUID, uuid4

import httpx

# Undeclared, arrives with mcp: its HTTP client takes only httpx2. Declare it at the next re-lock.
import httpx2
import pytest
from asgi_lifespan import LifespanManager
from fastapi import FastAPI
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import TextContent
from sqlalchemy import Connection, event

from roger_api.app import create_app
from roger_api.db.engine import Database
from roger_api.mcp_server import GET_TRANSCRIPT_DESCRIPTION
from tests.conftest import make_settings
from tests.helpers import AUTH_HEADERS, BASE_URL, append_segments, create_meeting, segment_payload

MCP_URL = f"{BASE_URL}/mcp"

# Copied from docs/api-contract.md on purpose: changing the wording is a contract change.
CONTRACT_DESCRIPTION = (
    "Get the full, word-for-word transcript of a meeting as plain text with timestamps and "
    "speakers. Use this when you need what was actually said: quote the transcript's exact "
    "words rather than paraphrasing. If `meeting_id` is omitted, returns the most recent meeting."
)


type Connect = Callable[[], AbstractAsyncContextManager[Client]]


@pytest.fixture(params=["auto", "legacy"])
def connect(app: FastAPI, request: pytest.FixtureRequest) -> Connect:
    """Connects over HTTP, in both the 2026 protocol and the legacy handshake.

    The client's task group must be entered and exited in the same task, so each test enters
    it itself (`async with connect() as mcp`) rather than through a yield fixture.
    """
    mode: str = request.param

    @asynccontextmanager
    async def connected() -> AsyncIterator[Client]:
        async with (
            httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app=app), base_url=BASE_URL, headers=AUTH_HEADERS
            ) as http,
            Client(streamable_http_client(MCP_URL, http_client=http), mode=mode) as client,
        ):
            yield client

    return connected


async def call_get_transcript(client: Client, **arguments: str) -> tuple[str, bool]:
    result = await client.call_tool("get_transcript", arguments)
    [block] = result.content
    assert isinstance(block, TextContent)
    return block.text, result.is_error


async def seed_weekly_sync(client: httpx.AsyncClient) -> str:
    meeting = await create_meeting(
        client, title="Weekly sync with Acme", started_at="2026-10-05T10:00:00Z"
    )
    await append_segments(
        client,
        meeting["id"],
        segment_payload(
            source="system",
            speaker="them",
            start_ms=7400,
            end_ms=9000,
            text="Hi Rahul, good to see you.",
        ),
        segment_payload(start_ms=3100, end_ms=5000, text="Hi everyone, thanks for joining."),
    )
    await client.post(
        f"/v1/meetings/{meeting['id']}/end", json={"ended_at": "2026-10-05T10:31:12Z"}
    )
    meeting_id: str = meeting["id"]
    return meeting_id


async def test_lists_get_transcript_and_get_notes(connect: Connect) -> None:
    async with connect() as mcp:
        tools = (await mcp.list_tools()).tools

    # get_notes (M4-T11) has its own checks in test_mcp_notes.py.
    assert [tool.name for tool in tools] == ["get_transcript", "get_notes"]
    tool = tools[0]
    assert tool.description == GET_TRANSCRIPT_DESCRIPTION == CONTRACT_DESCRIPTION
    assert set(tool.input_schema["properties"]) == {"meeting_id"}
    assert "meeting_id" not in tool.input_schema.get("required", [])
    assert tool.annotations is not None
    assert tool.annotations.read_only_hint is True


async def test_instructions_ask_for_exact_quotes(connect: Connect) -> None:
    async with connect() as mcp:
        instructions = mcp.instructions

    assert instructions is not None
    assert "exact words" in instructions
    assert "Never invent or guess a meeting id" in instructions


async def test_transcript_by_id(connect: Connect, client: httpx.AsyncClient) -> None:
    meeting_id = await seed_weekly_sync(client)

    async with connect() as mcp:
        text, is_error = await call_get_transcript(mcp, meeting_id=meeting_id)

    assert not is_error
    assert text == (
        "Meeting: Weekly sync with Acme\n"
        f"Meeting ID: {meeting_id}\n"
        "Started: 2026-10-05T10:00:00Z   Ended: 2026-10-05T10:31:12Z   Segments: 2\n"
        "\n"
        "[00:00:03] Me: Hi everyone, thanks for joining.\n"
        "[00:00:07] Them: Hi Rahul, good to see you."
    )


async def test_transcript_text_never_reads_word_timings(
    connect: Connect, client: httpx.AsyncClient, app: FastAPI
) -> None:
    # `words` dominates a segment row and the text never shows it. Reading it here made a long
    # call's MCP read load and validate every word only to drop it.
    meeting_id = await seed_weekly_sync(client)
    database = app.state.database
    assert isinstance(database, Database)
    statements: list[str] = []

    def record(
        conn: Connection,
        cursor: object,
        statement: str,
        parameters: object,
        context: object,
        executemany: bool,
    ) -> None:
        statements.append(statement)

    event.listen(database.engine.sync_engine, "before_cursor_execute", record)
    try:
        async with connect() as mcp:
            text, is_error = await call_get_transcript(mcp, meeting_id=meeting_id)
    finally:
        event.remove(database.engine.sync_engine, "before_cursor_execute", record)

    assert not is_error
    assert "Hi everyone, thanks for joining." in text
    segment_reads = [s for s in statements if "FROM transcript_segments" in s]
    assert segment_reads, statements
    assert not [s for s in segment_reads if "words" in s]


async def test_omitted_id_returns_the_latest_meeting(
    connect: Connect, client: httpx.AsyncClient
) -> None:
    await create_meeting(client, title="Latest", started_at="2026-10-05T12:00:00Z")
    # Created later but started earlier: "latest" means latest started_at.
    await create_meeting(client, title="Earlier", started_at="2026-10-05T09:00:00Z")

    async with connect() as mcp:
        text, is_error = await call_get_transcript(mcp)

    assert not is_error
    assert text.startswith("Meeting: Latest\n")
    assert text.endswith("(No transcript lines yet.)")


@pytest.mark.parametrize("meeting_id", [str(uuid4()), "not-a-uuid"])
async def test_unknown_meeting_is_a_tool_error(connect: Connect, meeting_id: str) -> None:
    async with connect() as mcp:
        text, is_error = await call_get_transcript(mcp, meeting_id=meeting_id)

    assert is_error
    assert "Meeting not found" in text


async def test_empty_workspace_says_no_meetings_yet(connect: Connect) -> None:
    async with connect() as mcp:
        result = await call_get_transcript(mcp)

    assert result == ("No meetings yet", False)


async def test_other_workspaces_are_invisible(connect: Connect, foreign_meeting_id: UUID) -> None:
    async with connect() as mcp:
        by_id = await call_get_transcript(mcp, meeting_id=str(foreign_meeting_id))
        latest = await call_get_transcript(mcp)

    assert by_id[1]
    assert "Meeting not found" in by_id[0]
    assert latest == ("No meetings yet", False)


INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-11-25",
        "capabilities": {},
        "clientInfo": {"name": "roger-tests", "version": "0"},
    },
}
MCP_HEADERS = {**AUTH_HEADERS, "Accept": "application/json, text/event-stream"}


async def post_initialize(app: FastAPI, host: str) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=f"http://{host}"
    ) as http:
        return await http.post("/mcp", json=INITIALIZE, headers=MCP_HEADERS)


async def test_delete_is_405_because_no_session_lives_on_the_server(app: FastAPI) -> None:
    # The contract lists DELETE /mcp as a 405: a stateless server has no session to end.
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=BASE_URL) as http:
        response = await http.delete("/mcp", headers=MCP_HEADERS)

    assert response.status_code == 405


async def test_unknown_host_is_refused_by_default(client: httpx.AsyncClient, app: FastAPI) -> None:
    assert (await post_initialize(app, "localhost:8000")).status_code == 200
    assert (await post_initialize(app, "roger.example.com")).status_code == 421


async def test_mcp_allowed_hosts_admits_a_deployment_hostname(
    database_url: str, clean_database: None
) -> None:
    settings = make_settings(database_url, mcp_allowed_hosts=["roger.example.com"])
    app = create_app(settings)

    async with LifespanManager(app):
        assert (await post_initialize(app, "roger.example.com")).status_code == 200
        assert (await post_initialize(app, "localhost:8000")).status_code == 200
        assert (await post_initialize(app, "evil.example.com")).status_code == 421
