"""Meeting notes storage: `GET /v1/meetings/{id}/notes` and `PUT .../notes/{kind}` (M4-T6).

The doc limits are checked twice: through the route (what the desktop sees) and on
`note_doc_problem` itself with the desktop's own fixtures (`shared/notes.test.ts`, "depth"), so
the API never counts more strictly than the check that decides what the desktop sends.
"""

import asyncio
import json
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select, update

from roger_api.auth import default_principal
from roger_api.config import Settings
from roger_api.db.engine import Database
from roger_api.db.models_notes import LlmRun, MeetingNote
from roger_api.domain import NoteKind, RunKind, RunStatus
from roger_api.schemas.notes import MAX_NOTE_DOC_BYTES, MAX_NOTE_DOC_DEPTH, note_doc_problem
from roger_api.services import notes
from tests.helpers import Json, append_segments, assert_error, create_meeting, segment_payload

AI_NOTES_FIXTURE = Path(__file__).parent / "fixtures" / "ai_notes_doc.json"
NOTE_FIELDS = {
    "kind",
    "doc",
    "version",
    "template_id",
    "last_run_id",
    "generated_version",
    "updated_at",
}
TOO_DEEP = f"nested deeper than {MAX_NOTE_DOC_DEPTH} levels"


def database_of(app: FastAPI) -> Database:
    database = app.state.database
    assert isinstance(database, Database)
    return database


def doc_saying(text: str) -> Json:
    return {
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}],
    }


def notes_path(meeting_id: object) -> str:
    return f"/v1/meetings/{meeting_id}/notes"


async def put_note(
    client: httpx.AsyncClient,
    meeting_id: object,
    kind: str,
    doc: object,
    *,
    base_version: int,
    revision_id: UUID | None = None,
) -> httpx.Response:
    body = {"doc": doc, "base_version": base_version, "revision_id": str(revision_id or uuid4())}
    return await client.put(f"{notes_path(meeting_id)}/{kind}", json=body)


async def put_raw_note(
    client: httpx.AsyncClient, meeting_id: object, kind: str, body: str
) -> httpx.Response:
    """A PUT whose JSON is written by hand: httpx refuses NaN and lone surrogates in `json=`."""
    return await client.put(
        f"{notes_path(meeting_id)}/{kind}",
        content=body.encode("utf-8", "surrogatepass"),
        headers={"Content-Type": "application/json"},
    )


def saved(response: httpx.Response) -> Json:
    assert response.status_code == 200, response.text
    note: Json = response.json()
    assert set(note) == NOTE_FIELDS
    return note


async def save_note(
    client: httpx.AsyncClient,
    meeting_id: object,
    kind: str,
    doc: object,
    *,
    base_version: int,
    revision_id: UUID | None = None,
) -> Json:
    """A PUT that must be stored: the note as the API answered it."""
    response = await put_note(
        client, meeting_id, kind, doc, base_version=base_version, revision_id=revision_id
    )
    return saved(response)


async def get_notes(client: httpx.AsyncClient, meeting_id: object) -> Json:
    response = await client.get(notes_path(meeting_id))
    assert response.status_code == 200, response.text
    body: Json = response.json()
    assert set(body) == {"user", "ai"}
    return body


def run_row(
    settings: Settings,
    meeting_id: str,
    *,
    kind: RunKind = "notes",
    status: RunStatus = "running",
    template_id: str | None = None,
) -> LlmRun:
    """An LLM run row as the run claim (M4-T8) inserts it."""
    return LlmRun(
        id=uuid4(),
        workspace_id=default_principal(settings).workspace_id,
        meeting_id=UUID(meeting_id),
        kind=kind,
        status=status,
        model="fake",
        prompt_version="notes-test",
        template_id=template_id,
        line_count=0,
        ref_map={},
    )


async def add_run(
    app: FastAPI,
    settings: Settings,
    meeting_id: str,
    *,
    kind: RunKind = "notes",
    status: RunStatus = "running",
    template_id: str | None = None,
) -> UUID:
    """A run row, written straight to the table and committed."""
    run = run_row(settings, meeting_id, kind=kind, status=status, template_id=template_id)
    async with database_of(app).session() as session:
        session.add(run)
        await session.commit()
    return run.id


async def finish_run(app: FastAPI, run_id: UUID) -> None:
    async with database_of(app).session() as session:
        await session.execute(update(LlmRun).where(LlmRun.id == run_id).values(status="succeeded"))
        await session.commit()


async def stored_note_count(app: FastAPI, meeting_id: object) -> int:
    async with database_of(app).session() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(MeetingNote)
            .where(MeetingNote.meeting_id == UUID(str(meeting_id)))
        )
    assert count is not None
    return count


# ---------------------------------------------------------------------------- saving


async def test_put_creates_then_updates_with_a_version_bump(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client)

    created = await save_note(client, meeting["id"], "user", doc_saying("Beta"), base_version=0)
    updated = await save_note(
        client, meeting["id"], "user", doc_saying("Beta ships"), base_version=1
    )

    assert created == {
        "kind": "user",
        "doc": doc_saying("Beta"),
        "version": 1,
        "template_id": None,
        "last_run_id": None,
        "generated_version": None,
        "updated_at": created["updated_at"],
    }
    assert updated["doc"] == doc_saying("Beta ships")
    assert updated["version"] == 2
    assert updated["updated_at"].endswith("Z")
    assert updated["updated_at"] >= created["updated_at"]
    assert await get_notes(client, meeting["id"]) == {"user": updated, "ai": None}


async def test_a_meeting_without_notes_has_neither_doc(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client)

    assert await get_notes(client, meeting["id"]) == {"user": None, "ai": None}


async def test_the_two_kinds_are_versioned_apart(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client)

    user = await save_note(client, meeting["id"], "user", doc_saying("Mine"), base_version=0)
    ai = await save_note(client, meeting["id"], "ai", doc_saying("Theirs"), base_version=0)

    assert (user["kind"], user["version"], ai["kind"], ai["version"]) == ("user", 1, "ai", 1)
    assert await get_notes(client, meeting["id"]) == {"user": user, "ai": ai}


async def test_stale_base_version_is_a_conflict(app: FastAPI, client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client)
    await save_note(client, meeting["id"], "user", doc_saying("One"), base_version=0)
    current = await save_note(client, meeting["id"], "user", doc_saying("Two"), base_version=1)

    behind = await put_note(client, meeting["id"], "user", doc_saying("Lost"), base_version=1)
    recreate = await put_note(client, meeting["id"], "user", doc_saying("Lost"), base_version=0)
    ahead = await put_note(client, meeting["id"], "user", doc_saying("Lost"), base_version=7)

    message = assert_error(behind, 409, "conflict")
    assert "version 2" in message
    assert "version 1" in message
    assert "Lost" not in message
    assert_error(recreate, 409, "conflict")
    assert_error(ahead, 409, "conflict")
    assert await get_notes(client, meeting["id"]) == {"user": current, "ai": None}
    assert await stored_note_count(app, meeting["id"]) == 1


async def test_resent_revision_returns_the_stored_note(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client)
    revision_id = uuid4()
    first = await save_note(
        client, meeting["id"], "user", doc_saying("Beta"), base_version=0, revision_id=revision_id
    )

    again = await put_note(
        client, meeting["id"], "user", doc_saying("Beta"), base_version=0, revision_id=revision_id
    )
    # Re-sends are matched by id alone, as segment ids are: what the re-send carries is ignored.
    changed = await put_note(
        client, meeting["id"], "user", doc_saying("Other"), base_version=0, revision_id=revision_id
    )

    assert saved(again) == first
    assert saved(changed) == first
    assert await get_notes(client, meeting["id"]) == {"user": first, "ai": None}


async def test_a_resend_of_a_save_that_is_no_longer_the_latest_is_a_conflict(
    client: httpx.AsyncClient,
) -> None:
    # Only the save that made the stored version counts as a re-send. An older one sent again
    # would roll the doc back, so it is a stale base like any other.
    meeting = await create_meeting(client)
    old_revision = uuid4()
    await save_note(
        client, meeting["id"], "user", doc_saying("Old"), base_version=0, revision_id=old_revision
    )
    newer = await save_note(client, meeting["id"], "user", doc_saying("New"), base_version=1)

    resent = await put_note(
        client, meeting["id"], "user", doc_saying("Old"), base_version=0, revision_id=old_revision
    )

    assert_error(resent, 409, "conflict")
    assert (await get_notes(client, meeting["id"]))["user"] == newer


async def test_first_saves_sent_at_once_store_one_note(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    # Two saves that both create the note (base_version 0) take turns on the meeting lock: the
    # second sees the first's note and is a conflict, never a unique-index 500.
    meeting = await create_meeting(client)

    responses = await asyncio.gather(
        *(
            put_note(client, meeting["id"], "user", doc_saying(text), base_version=0)
            for text in ("Mac", "Other Mac")
        )
    )

    assert sorted(response.status_code for response in responses) == [200, 409]
    assert await stored_note_count(app, meeting["id"]) == 1


async def test_unknown_kind_is_a_validation_error(client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client)

    response = await put_note(client, meeting["id"], "summary", doc_saying("x"), base_version=0)

    assert "kind" in assert_error(response, 422, "validation_error")


@pytest.mark.parametrize(
    "body",
    [
        pytest.param({"doc": {"type": "doc"}, "base_version": -1}, id="negative-base"),
        pytest.param({"doc": {"type": "doc"}, "base_version": 0}, id="no-revision"),
        pytest.param(
            {"doc": {"type": "doc"}, "base_version": 0, "revision_id": "not-a-uuid"},
            id="bad-revision",
        ),
        pytest.param({"base_version": 0, "revision_id": str(uuid4())}, id="no-doc"),
    ],
)
async def test_a_save_needs_a_base_version_and_a_revision_id(
    app: FastAPI, client: httpx.AsyncClient, body: Json
) -> None:
    meeting = await create_meeting(client)

    response = await client.put(f"{notes_path(meeting['id'])}/user", json=body)

    assert_error(response, 422, "validation_error")
    assert await stored_note_count(app, meeting["id"]) == 0


# ---------------------------------------------------------------------------- AI notes and runs


async def test_ai_put_while_a_notes_run_is_running_is_a_conflict(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings
) -> None:
    meeting = await create_meeting(client)
    await save_note(client, meeting["id"], "ai", doc_saying("Draft"), base_version=0)
    run_id = await add_run(app, settings, meeting["id"])

    during = await put_note(client, meeting["id"], "ai", doc_saying("Edited"), base_version=1)
    mine = await put_note(client, meeting["id"], "user", doc_saying("Mine"), base_version=0)

    assert "being generated" in assert_error(during, 409, "conflict")
    # Only the AI doc waits for the run: the user's notes are its input, saved before it started.
    saved(mine)
    await finish_run(app, run_id)
    # A chat run never writes the AI notes.
    await add_run(app, settings, meeting["id"], kind="chat")
    after = await save_note(client, meeting["id"], "ai", doc_saying("Edited"), base_version=1)
    assert (after["doc"], after["version"]) == (doc_saying("Edited"), 2)


async def test_an_ai_put_waits_for_a_run_claim_holding_the_meeting_lock(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings
) -> None:
    # The run claim (M4-T8) takes the meeting lock, then inserts its running run. A PUT must
    # land wholly before the claim or after it: here it waits, then sees the run.
    meeting = await create_meeting(client)
    await save_note(client, meeting["id"], "ai", doc_saying("Draft"), base_version=0)
    async with database_of(app).session() as claim:
        await notes.lock_meeting(claim, default_principal(settings), UUID(meeting["id"]))
        claim.add(run_row(settings, meeting["id"]))
        await claim.flush()
        put = asyncio.create_task(
            put_note(client, meeting["id"], "ai", doc_saying("Edited"), base_version=1)
        )
        done, _ = await asyncio.wait({put}, timeout=0.5)

        assert not done, "an AI-doc PUT ran while a run claim held the meeting lock"
        await claim.commit()

    assert_error(await put, 409, "conflict")


async def test_a_notes_save_never_holds_up_the_transcript(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings
) -> None:
    # A plain FOR UPDATE on the meeting row would block every segment insert into the meeting
    # (its foreign key check takes FOR KEY SHARE) until the notes save commits.
    meeting = await create_meeting(client)
    async with database_of(app).session() as running_save:
        await notes.lock_meeting(running_save, default_principal(settings), UUID(meeting["id"]))

        async with asyncio.timeout(5):
            await append_segments(client, meeting["id"], segment_payload())

        await running_save.rollback()


async def test_note_carries_last_run_and_generated_version(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings
) -> None:
    meeting = await create_meeting(client)
    run_id = await add_run(app, settings, meeting["id"], status="succeeded", template_id="standup")
    async with database_of(app).session() as session:
        # As the run's save (M4-T8) writes it: version 1, made by that run.
        session.add(
            MeetingNote(
                id=uuid4(),
                workspace_id=default_principal(settings).workspace_id,
                meeting_id=UUID(meeting["id"]),
                kind="ai",
                doc=doc_saying("Beta ships Friday"),
                version=1,
                last_revision_id=run_id,
                template_id="standup",
                last_run_id=run_id,
                generated_version=1,
            )
        )
        await session.commit()

    generated = (await get_notes(client, meeting["id"]))["ai"]
    edited = await save_note(
        client, meeting["id"], "ai", doc_saying("Beta ships Monday"), base_version=1
    )

    assert generated is not None
    assert (
        generated["template_id"],
        generated["last_run_id"],
        generated["generated_version"],
        generated["version"],
    ) == ("standup", str(run_id), 1, 1)
    # An edit keeps the run's fields: `version` above `generated_version` means edited since.
    assert (
        edited["template_id"],
        edited["last_run_id"],
        edited["generated_version"],
        edited["version"],
    ) == ("standup", str(run_id), 1, 2)


# ---------------------------------------------------------------------------- doc limits


def compact_size(doc: object) -> int:
    return len(json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode())


def quoted(blockquotes: int, text: Json) -> Json:
    """A paragraph holding `text`, inside `blockquotes` blockquotes (`quoted` in notes.test.ts)."""
    node: Json = {"type": "paragraph", "content": [text]}
    for _ in range(blockquotes):
        node = {"type": "blockquote", "content": [node]}
    return {"type": "doc", "content": [node]}


LINKED: Json = {
    "type": "text",
    "text": "the brief",
    "marks": [{"type": "link", "attrs": {"href": "https://example.com/brief", "target": "_blank"}}],
}


async def test_doc_must_be_a_tiptap_doc_under_the_limits(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    meeting = await create_meeting(client)
    overhead = compact_size(doc_saying(""))
    refused: list[tuple[object, str]] = [
        ({"type": "paragraph"}, "not a TipTap doc"),
        ({"content": []}, "not a TipTap doc"),
        ([{"type": "doc"}], "not a TipTap doc"),
        ("doc", "not a TipTap doc"),
        (doc_saying("a" * (MAX_NOTE_DOC_BYTES - overhead + 1)), "larger than"),
        # Two bytes each in UTF-8, one character each: counted in bytes.
        (doc_saying("\u00e9" * (MAX_NOTE_DOC_BYTES // 2)), "larger than"),
        (quoted(30, {"type": "text", "text": "x"}), TOO_DEEP),
    ]

    for doc, reason in refused:
        response = await put_note(client, meeting["id"], "user", doc, base_version=0)
        message = assert_error(response, 422, "validation_error")
        assert message.startswith("Invalid request: body.doc: "), message
        assert reason in message, message
    assert await stored_note_count(app, meeting["id"]) == 0

    at_the_limit = doc_saying("a" * (MAX_NOTE_DOC_BYTES - overhead))
    assert compact_size(at_the_limit) == MAX_NOTE_DOC_BYTES
    await save_note(client, meeting["id"], "user", at_the_limit, base_version=0)
    deepest = quoted(29, {"type": "text", "text": "x"})
    await save_note(client, meeting["id"], "ai", deepest, base_version=0)


async def test_proto_keys_are_rejected(app: FastAPI, client: httpx.AsyncClient) -> None:
    meeting = await create_meeting(client)
    # The desktop's cases (notes.test.ts), as raw JSON: the key is an own key, anywhere.
    docs = [
        '{"type":"doc","__proto__":{"polluted":true}}',
        '{"type":"doc","content":[{"type":"paragraph","constructor":{}}]}',
        '{"type":"doc","content":[{"type":"paragraph","attrs":{"prototype":{}}}]}',
        '{"type":"doc","content":[{"type":"text","text":"x","marks":'
        '[{"type":"link","attrs":{"href":{"__proto__":{}}}}]}]}',
    ]

    for doc in docs:
        body = f'{{"doc":{doc},"base_version":0,"revision_id":"{uuid4()}"}}'
        response = await put_raw_note(client, meeting["id"], "user", body)
        message = assert_error(response, 422, "validation_error")
        assert any(f'"{key}" key' in message for key in ("__proto__", "constructor", "prototype"))
    assert await stored_note_count(app, meeting["id"]) == 0


async def test_the_shared_ai_notes_fixture_can_be_saved(client: httpx.AsyncClient) -> None:
    # "Restore previous notes" saves a run's replaced doc through this PUT: the AI doc the API
    # builds must always pass the API's own limits.
    meeting = await create_meeting(client)
    fixture: Json = json.loads(AI_NOTES_FIXTURE.read_text())

    note = await save_note(client, meeting["id"], "ai", fixture, base_version=0)

    assert note["doc"] == fixture


def test_depth_is_counted_as_the_desktop_counts_it() -> None:
    # The fixtures of notes.test.ts ("depth"), counted for 32 levels there: the doc is 1 and each
    # node one below the node holding it; every other object or list inside a node one below its
    # parent.
    assert MAX_NOTE_DOC_DEPTH == 32
    # Blockquotes at 2 to b + 1, the paragraph at b + 2, its text node at b + 3.
    assert note_doc_problem(quoted(29, {"type": "text", "text": "x"})) is None
    assert note_doc_problem(quoted(30, {"type": "text", "text": "x"})) == TOO_DEEP
    # The text node at b + 3, its marks list at b + 4, the link at b + 5, its attrs at b + 6.
    assert note_doc_problem(quoted(26, LINKED)) is None
    assert note_doc_problem(quoted(27, LINKED)) == TOO_DEEP


def test_a_bullet_list_tabbed_13_deep_with_a_link_fits() -> None:
    # StarterKit sinks a list item on Tab with no cap. Counting every JSON object and list would
    # refuse the 7th level, and the desktop would re-send that note forever.
    bullet_list: Json = {
        "type": "bulletList",
        "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [LINKED]}]}],
    }
    for _ in range(2, 14):
        point = {"type": "paragraph", "content": [{"type": "text", "text": "point"}]}
        bullet_list = {
            "type": "bulletList",
            "content": [{"type": "listItem", "content": [point, bullet_list]}],
        }

    # The 13th list at 26, its item 27, paragraph 28, text 29, marks 30, link 31, attrs 32.
    assert note_doc_problem({"type": "doc", "content": [bullet_list]}) is None


def test_a_doc_nested_thousands_deep_is_refused_without_recursing() -> None:
    deep_nodes: Json = {"type": "paragraph"}
    deep_lists: list[Any] = []
    # A `content` key inside attrs still costs its objects a level each.
    deep_content_keys: Json = {}
    lists, objects = deep_lists, deep_content_keys
    for _ in range(100_000):
        deep_nodes = {"type": "blockquote", "content": [deep_nodes]}
        inner_list: list[Any] = []
        lists.append(inner_list)
        lists = inner_list
        inner_object: Json = {}
        objects["content"] = [inner_object]
        objects = inner_object

    docs = [
        {"type": "doc", "content": [deep_nodes]},
        {"type": "doc", "content": [{"type": "paragraph", "attrs": {"values": deep_lists}}]},
        {"type": "doc", "content": [{"type": "paragraph", "attrs": deep_content_keys}]},
    ]

    for doc in docs:
        assert note_doc_problem(doc) == TOO_DEEP


def test_size_is_utf8_bytes_of_the_compact_json() -> None:
    overhead = compact_size(doc_saying(""))

    assert note_doc_problem(doc_saying("a" * (MAX_NOTE_DOC_BYTES - overhead))) is None
    assert note_doc_problem(doc_saying("a" * (MAX_NOTE_DOC_BYTES - overhead + 1))) == (
        f"larger than {MAX_NOTE_DOC_BYTES} bytes"
    )
    # "\u00e9" is one character and two bytes: half as many still fill the limit.
    half = (MAX_NOTE_DOC_BYTES - overhead) // 2
    assert note_doc_problem(doc_saying("\u00e9" * half)) is None
    assert note_doc_problem(doc_saying("\u00e9" * (half + 1))) is not None


async def test_text_postgres_cannot_store_is_stored_without_it(client: httpx.AsyncClient) -> None:
    # jsonb holds no U+0000 and no unpaired surrogate; both were a 500. The desktop's check lets
    # them through (JSON.stringify escapes them), so refusing them would leave an invisible
    # character holding the note dirty forever: they are stored the way Postgres can.
    meeting = await create_meeting(client)
    sent = (
        '{"type":"doc","attrs":{"a\\u0000b":"c\\u0000d"},"content":['
        '{"type":"text","text":"high \\ud83d, low \\ude00, pair \\ud83d\\ude00"}]}'
    )
    stored = {
        "type": "doc",
        "attrs": {"ab": "cd"},
        "content": [{"type": "text", "text": "high \ufffd, low \ufffd, pair \U0001f600"}],
    }

    body = f'{{"doc":{sent},"base_version":0,"revision_id":"{uuid4()}"}}'
    note = saved(await put_raw_note(client, meeting["id"], "user", body))

    assert note["doc"] == stored
    assert (await get_notes(client, meeting["id"]))["user"] == note


def test_an_unpaired_surrogate_is_measured_no_larger_than_the_desktop_measures_it() -> None:
    # JSON.stringify writes one as a six-byte \u escape; stored, it is a three-byte U+FFFD.
    overhead = compact_size(doc_saying(""))
    lone = "\ud83d" * ((MAX_NOTE_DOC_BYTES - overhead) // 6)

    assert note_doc_problem(doc_saying(lone)) is None


def test_values_json_cannot_carry_are_refused() -> None:
    for value in (float("nan"), float("inf"), float("-inf")):
        doc = {"type": "doc", "content": [{"type": "paragraph", "attrs": {"value": value}}]}
        assert note_doc_problem(doc) == "holds a value JSON cannot carry"
    plain = {"type": "doc", "content": [{"type": "paragraph", "attrs": {"a": None, "b": 1.5}}]}
    assert note_doc_problem(plain) is None


# ---------------------------------------------------------------------------- isolation and auth


async def test_notes_of_a_meeting_in_another_workspace_are_not_found(
    app: FastAPI, client: httpx.AsyncClient, foreign_meeting_id: UUID
) -> None:
    unknown = uuid4()
    kinds: tuple[NoteKind, ...] = ("user", "ai")

    for meeting_id in (foreign_meeting_id, unknown):
        assert_error(await client.get(notes_path(meeting_id)), 404, "not_found")
        for kind in kinds:
            response = await put_note(client, meeting_id, kind, doc_saying("x"), base_version=0)
            assert str(meeting_id) in assert_error(response, 404, "not_found")
    assert await stored_note_count(app, foreign_meeting_id) == 0


async def test_notes_routes_require_auth(
    app: FastAPI, client: httpx.AsyncClient, anonymous_client: httpx.AsyncClient
) -> None:
    meeting = await create_meeting(client)

    read = await anonymous_client.get(notes_path(meeting["id"]))
    write = await put_note(anonymous_client, meeting["id"], "user", doc_saying("x"), base_version=0)

    assert_error(read, 401, "unauthorized")
    assert_error(write, 401, "unauthorized")
    assert await stored_note_count(app, meeting["id"]) == 0
