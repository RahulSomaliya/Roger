"""MCP `get_notes` (M4-T11) through the SDK client, over Streamable HTTP into the real app.

Notes are saved through the REST route, as the desktop saves them; the tool reads what is stored.
"""

import json
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import UUID, uuid4

import httpx

# Undeclared, arrives with mcp: its HTTP client takes only httpx2. Declare it at the next re-lock.
import httpx2
import pytest
from fastapi import FastAPI
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import TextContent
from sqlalchemy import select

from roger_api.config import REPO_ROOT_ENV_FILE
from roger_api.db.engine import Database
from roger_api.db.models import Meeting
from roger_api.db.models_notes import MeetingNote
from roger_api.mcp_server import GET_NOTES_DESCRIPTION
from tests.helpers import AUTH_HEADERS, BASE_URL, Json, create_meeting

MCP_URL = f"{BASE_URL}/mcp"
API_CONTRACT = REPO_ROOT_ENV_FILE.parent / "docs" / "api-contract.md"
# The AI doc both sides pin (M4 plan): two sections, a weak chip pair and a "From your notes" list.
AI_NOTES_FIXTURE = Path(__file__).parent / "fixtures" / "ai_notes_doc.json"

# Copied from docs/api-contract.md on purpose: changing the wording is a contract change.
CONTRACT_DESCRIPTION = (
    "Get the notes for a meeting: the AI-written notes and the user's own rough notes, as "
    "Markdown. Each AI line ends with the transcript times it came from, like [00:12:03]. Notes "
    "are a summary: to quote what someone said, call get_transcript and use its exact words. If "
    "meeting_id is omitted, returns the most recent meeting."
)


def paragraph(*content: Json) -> Json:
    return {"type": "paragraph", "content": list(content)}


def text(value: str, *marks: str) -> Json:
    node: Json = {"type": "text", "text": value}
    if marks:
        node["marks"] = [{"type": mark} for mark in marks]
    return node


def bullets(*items: Json) -> Json:
    return {"type": "bulletList", "content": [{"type": "listItem", "content": [i]} for i in items]}


def chip(start_ms: int) -> Json:
    """A citation chip with the attrs the editor declares (`citationNode.ts`)."""
    attrs: Json = {"segmentIds": [str(uuid4())], "startMs": start_ms, "label": "", "support": "ok"}
    return {"type": "citation", "attrs": attrs}


def doc_saying(words: str) -> Json:
    return {"type": "doc", "content": [paragraph(text(words))]}


USER_NOTES: Json = {
    "type": "doc",
    "content": [
        {"type": "heading", "attrs": {"level": 3}, "content": [text("Pricing")]},
        bullets(
            paragraph(text("50k "), text("first year", "bold")), paragraph(text("Q3 renewal?"))
        ),
        paragraph(text("Ask about the travel budget")),
    ],
}


@asynccontextmanager
async def connect(app: FastAPI) -> AsyncIterator[Client]:
    # test_mcp.py covers both handshakes; the tool reads the same either way.
    async with (
        httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url=BASE_URL, headers=AUTH_HEADERS
        ) as http,
        Client(streamable_http_client(MCP_URL, http_client=http)) as client,
    ):
        yield client


async def call_get_notes(app: FastAPI, **arguments: str) -> tuple[str, bool]:
    async with connect(app) as mcp:
        result = await mcp.call_tool("get_notes", arguments)
    [block] = result.content
    assert isinstance(block, TextContent)
    return block.text, result.is_error


async def put_note(client: httpx.AsyncClient, meeting_id: str, kind: str, doc: Json) -> None:
    body = {"doc": doc, "base_version": 0, "revision_id": str(uuid4())}
    response = await client.put(f"/v1/meetings/{meeting_id}/notes/{kind}", json=body)
    assert response.status_code == 200, response.text


async def create_ended_meeting(
    client: httpx.AsyncClient, title: str, started_at: str, ended_at: str
) -> str:
    meeting = await create_meeting(client, title=title, started_at=started_at)
    response = await client.post(f"/v1/meetings/{meeting['id']}/end", json={"ended_at": ended_at})
    assert response.status_code == 200, response.text
    meeting_id: str = meeting["id"]
    return meeting_id


def contract_tool_description(tool: str) -> str:
    """The quoted description under the contract's heading for `tool`, joined into one line."""
    _, found, rest = API_CONTRACT.read_text().partition(f"\n### Tool `{tool}`\n")
    assert found, f"docs/api-contract.md has no heading for the tool {tool}"
    section = rest.split("\n#", 1)[0]
    quote = re.search(r"^> .*(?:\n> .*)*", section, re.MULTILINE)
    assert quote is not None, f"the contract quotes no description for {tool}"
    return " ".join(line.removeprefix("> ") for line in quote.group(0).splitlines())


async def test_get_notes_description_matches_the_contract(app: FastAPI) -> None:
    async with connect(app) as mcp:
        tools = {tool.name: tool for tool in (await mcp.list_tools()).tools}

    tool = tools["get_notes"]
    assert tool.description == GET_NOTES_DESCRIPTION == CONTRACT_DESCRIPTION
    assert contract_tool_description("get_notes") == CONTRACT_DESCRIPTION
    assert set(tool.input_schema["properties"]) == {"meeting_id"}
    assert "meeting_id" not in tool.input_schema.get("required", [])
    assert tool.annotations is not None
    assert tool.annotations.read_only_hint is True
    assert tool.annotations.open_world_hint is False


async def test_get_notes_returns_ai_and_user_notes_as_markdown(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    meeting_id = await create_ended_meeting(
        client, "Weekly sync with Acme", "2026-10-05T10:00:00Z", "2026-10-05T10:31:12Z"
    )
    await put_note(client, meeting_id, "ai", json.loads(AI_NOTES_FIXTURE.read_text("utf-8")))
    await put_note(client, meeting_id, "user", USER_NOTES)

    notes, is_error = await call_get_notes(app, meeting_id=meeting_id)

    assert not is_error
    # The follow-up line's two chips are `weak` (flagged "check this" in the app). They read like
    # `ok` ones here: a cue for MCP is a product call nobody has made (phase-2-build-order.md, 10).
    assert notes == (
        "Meeting: Weekly sync with Acme\n"
        f"Meeting ID: {meeting_id}\n"
        "Started: 2026-10-05T10:00:00Z   Ended: 2026-10-05T10:31:12Z\n"
        "\n"
        "# AI notes\n"
        "\n"
        "### Decisions\n"
        "\n"
        "- Beta ships Friday [00:03:12]\n"
        "- The pilot stays at $50k for the first year [00:05:05]\n"
        "\n"
        "### Action items\n"
        "\n"
        "- Them: send the security questionnaire by Wednesday [01:02:05]\n"
        "- Me: book the follow-up for the 14th [00:10:10] [00:10:55]\n"
        "\n"
        "# From your notes\n"
        "\n"
        "*Not said on the call*\n"
        "\n"
        "- Ask Acme about the Q3 renewal\n"
        "- Check the travel budget\n"
        "\n"
        "# My notes\n"
        "\n"
        "#### Pricing\n"
        "\n"
        "- 50k **first year**\n"
        "- Q3 renewal?\n"
        "\n"
        "Ask about the travel budget"
    )


async def test_get_notes_without_id_reads_the_latest_meeting(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    latest = await create_meeting(client, title="Latest", started_at="2026-10-05T12:00:00Z")
    # Created later but started earlier: "latest" means latest started_at, as for get_transcript.
    earlier = await create_ended_meeting(
        client, "Earlier", "2026-10-05T09:00:00Z", "2026-10-05T09:30:00Z"
    )
    await put_note(client, latest["id"], "user", doc_saying("Latest notes"))
    await put_note(client, earlier, "user", doc_saying("Earlier notes"))
    await put_note(client, earlier, "ai", doc_saying("Earlier AI notes"))

    notes, is_error = await call_get_notes(app)

    assert not is_error
    assert notes == (
        "Meeting: Latest\n"
        f"Meeting ID: {latest['id']}\n"
        "Started: 2026-10-05T12:00:00Z   Ended: still recording\n"
        "\n"
        "# AI notes\n"
        "\n"
        "(No AI notes yet.)\n"
        "\n"
        "# My notes\n"
        "\n"
        "Latest notes"
    )


async def test_get_notes_of_a_meeting_without_notes_says_so(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    meeting_id = await create_ended_meeting(
        client, "Quiet one", "2026-10-05T10:00:00Z", "2026-10-05T10:05:00Z"
    )
    # The doc TipTap saves for an empty notepad: a stored note with nothing in it reads as none.
    await put_note(client, meeting_id, "user", {"type": "doc", "content": [{"type": "paragraph"}]})

    notes, is_error = await call_get_notes(app, meeting_id=meeting_id)

    assert not is_error
    assert notes.endswith("# AI notes\n\n(No AI notes yet.)\n\n# My notes\n\n(No notes yet.)")
    assert "From your notes" not in notes


async def test_get_notes_where_only_your_notes_back_the_ai_lines_says_none_came_from_the_call(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    # A meeting where nobody spoke but the user typed: every AI line lands in "From your notes".
    meeting_id = await create_ended_meeting(
        client, "Nobody spoke", "2026-10-05T10:00:00Z", "2026-10-05T10:05:00Z"
    )
    ai_doc: Json = {
        "type": "doc",
        "content": [
            {"type": "heading", "attrs": {"level": 2}, "content": [text("From your notes")]},
            paragraph(text("Not said on the call", "italic")),
            bullets(paragraph(text("Chase the invoice"))),
        ],
    }
    await put_note(client, meeting_id, "ai", ai_doc)

    notes, is_error = await call_get_notes(app, meeting_id=meeting_id)

    assert not is_error
    assert notes.endswith(
        "# AI notes\n"
        "\n"
        "(No lines from the transcript. See From your notes.)\n"
        "\n"
        "# From your notes\n"
        "\n"
        "*Not said on the call*\n"
        "\n"
        "- Chase the invoice\n"
        "\n"
        "# My notes\n"
        "\n"
        "(No notes yet.)"
    )


async def test_get_notes_keeps_a_section_added_after_from_your_notes_in_the_ai_notes(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    # The AI doc is editable, and its end is where a user adds things. A line copied there with its
    # chip came from the call: under "From your notes" it would read "Not said on the call".
    meeting_id = await create_ended_meeting(
        client, "Added to", "2026-10-05T10:00:00Z", "2026-10-05T10:30:00Z"
    )
    ai_doc: Json = {
        "type": "doc",
        "content": [
            {"type": "heading", "attrs": {"level": 2}, "content": [text("Decisions")]},
            bullets(paragraph(text("Beta ships Friday "), chip(192_000))),
            {"type": "heading", "attrs": {"level": 2}, "content": [text("From your notes")]},
            paragraph(text("Not said on the call", "italic")),
            bullets(paragraph(text("Ask about Q3"))),
            {"type": "heading", "attrs": {"level": 2}, "content": [text("Follow-ups")]},
            bullets(paragraph(text("Legal signed off "), chip(192_000))),
        ],
    }
    await put_note(client, meeting_id, "ai", ai_doc)

    notes, is_error = await call_get_notes(app, meeting_id=meeting_id)

    assert not is_error
    assert notes.endswith(
        "# AI notes\n"
        "\n"
        "### Decisions\n"
        "\n"
        "- Beta ships Friday [00:03:12]\n"
        "\n"
        "### Follow-ups\n"
        "\n"
        "- Legal signed off [00:03:12]\n"
        "\n"
        "# From your notes\n"
        "\n"
        "*Not said on the call*\n"
        "\n"
        "- Ask about Q3\n"
        "\n"
        "# My notes\n"
        "\n"
        "(No notes yet.)"
    )


async def test_get_notes_puts_every_doc_heading_under_its_section(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    # Typing "# " in either editor makes a level-1 heading. Kept at level 1 it would read as a
    # section of the tool's own: the user's "# AI notes" would start a second AI notes section.
    meeting_id = await create_ended_meeting(
        client, "Level one", "2026-10-05T10:00:00Z", "2026-10-05T10:30:00Z"
    )
    ai_doc: Json = {
        "type": "doc",
        "content": [
            {"type": "heading", "attrs": {"level": 1}, "content": [text("Acme call")]},
            bullets(paragraph(text("Beta ships Friday "), chip(192_000))),
        ],
    }
    user_doc: Json = {
        "type": "doc",
        "content": [
            {"type": "heading", "attrs": {"level": 1}, "content": [text("AI notes")]},
            bullets(paragraph(text("call Bob"))),
        ],
    }
    await put_note(client, meeting_id, "ai", ai_doc)
    await put_note(client, meeting_id, "user", user_doc)

    notes, is_error = await call_get_notes(app, meeting_id=meeting_id)

    assert not is_error
    assert notes.endswith(
        "# AI notes\n"
        "\n"
        "## Acme call\n"
        "\n"
        "- Beta ships Friday [00:03:12]\n"
        "\n"
        "# My notes\n"
        "\n"
        "## AI notes\n"
        "\n"
        "- call Bob"
    )
    assert [line for line in notes.splitlines() if line.startswith("# ")] == [
        "# AI notes",
        "# My notes",
    ]


async def test_get_notes_in_an_empty_workspace_says_no_meetings_yet(app: FastAPI) -> None:
    assert await call_get_notes(app) == ("No meetings yet", False)


@pytest.mark.parametrize("meeting_id", [str(uuid4()), "not-a-uuid"])
async def test_get_notes_of_an_unknown_meeting_is_not_found(app: FastAPI, meeting_id: str) -> None:
    notes, is_error = await call_get_notes(app, meeting_id=meeting_id)

    assert is_error
    assert "Meeting not found" in notes


async def test_get_notes_in_another_workspace_is_not_found(
    app: FastAPI, client: httpx.AsyncClient, foreign_meeting_id: UUID
) -> None:
    database = app.state.database
    assert isinstance(database, Database)
    async with database.session() as session:
        foreign = await session.scalar(select(Meeting).where(Meeting.id == foreign_meeting_id))
        assert foreign is not None
        session.add(
            MeetingNote(
                id=uuid4(),
                workspace_id=foreign.workspace_id,
                meeting_id=foreign_meeting_id,
                kind="user",
                doc=doc_saying("Someone else's secret plan"),
                version=1,
                last_revision_id=uuid4(),
            )
        )
        await session.commit()
    mine = await create_ended_meeting(
        client, "Mine", "2026-10-05T10:00:00Z", "2026-10-05T10:30:00Z"
    )
    await put_note(client, mine, "user", doc_saying("My plan"))

    by_id = await call_get_notes(app, meeting_id=str(foreign_meeting_id))
    # The foreign meeting started a day from now, after every meeting of this workspace.
    latest, latest_is_error = await call_get_notes(app)

    assert by_id[1]
    assert "Meeting not found" in by_id[0]
    assert "secret plan" not in by_id[0]
    assert not latest_is_error
    assert latest.startswith("Meeting: Mine\n")
    assert latest.endswith("# My notes\n\nMy plan")
    assert "secret plan" not in latest
