"""The workspace jargon list: `GET` and `PUT /v1/vocabulary` (M3-T2)."""

import asyncio
from datetime import datetime
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from roger_api.auth import default_principal
from roger_api.config import Settings
from roger_api.db.engine import Database
from roger_api.db.models import Workspace
from roger_api.db.models_vocabulary import VocabularyTerm
from roger_api.services import vocabulary
from tests.helpers import (
    TEST_TOKEN,
    Json,
    append_segments,
    assert_error,
    create_meeting,
    segment_payload,
)

PATH = "/v1/vocabulary"

type StoredRow = tuple[UUID, str, datetime]


def database_of(app: FastAPI) -> Database:
    database = app.state.database
    assert isinstance(database, Database)
    return database


async def put_terms(client: httpx.AsyncClient, terms: list[str]) -> list[str]:
    response = await client.put(PATH, json={"terms": terms})
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"terms"}
    stored: list[str] = body["terms"]
    return stored


async def get_terms(client: httpx.AsyncClient) -> list[str]:
    response = await client.get(PATH)
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"terms"}
    stored: list[str] = body["terms"]
    return stored


async def stored_rows(app: FastAPI, workspace_id: UUID) -> list[StoredRow]:
    """Every row of one workspace, straight from the table, ordered by id."""
    async with database_of(app).session() as session:
        rows = await session.execute(
            select(VocabularyTerm.id, VocabularyTerm.term, VocabularyTerm.created_at)
            .where(VocabularyTerm.workspace_id == workspace_id)
            .order_by(VocabularyTerm.id)
        )
        return [(row_id, term, created_at) for row_id, term, created_at in rows]


async def add_workspace_with_terms(app: FastAPI, *terms: str) -> UUID:
    """Another workspace, holding `terms`, written straight to the tables."""
    workspace_id = uuid4()
    async with database_of(app).session() as session:
        session.add(Workspace(id=workspace_id, name="Someone else"))
        await session.flush()
        session.add_all(
            VocabularyTerm(id=uuid4(), workspace_id=workspace_id, term=term) for term in terms
        )
        await session.commit()
    return workspace_id


# ---------------------------------------------------------------------------- GET and PUT


async def test_get_is_empty_before_any_put(client: httpx.AsyncClient) -> None:
    assert await get_terms(client) == []


async def test_put_replaces_the_whole_list(client: httpx.AsyncClient) -> None:
    await put_terms(client, ["Linkt", "Roger"])

    stored = await put_terms(client, ["Roger", "AssemblyAI"])

    assert stored == ["AssemblyAI", "Roger"]
    assert await get_terms(client) == ["AssemblyAI", "Roger"]


async def test_an_empty_list_clears_it(client: httpx.AsyncClient) -> None:
    await put_terms(client, ["Linkt", "Roger"])

    assert await put_terms(client, []) == []
    assert await get_terms(client) == []


async def test_get_sorts_ignoring_case(client: httpx.AsyncClient) -> None:
    await put_terms(client, ["roger", "Linkt", "deepgram", "AssemblyAI"])

    # A case-sensitive sort would put every capitalised term first.
    assert await get_terms(client) == ["AssemblyAI", "deepgram", "Linkt", "roger"]


async def test_duplicates_keep_the_first_spelling(client: httpx.AsyncClient) -> None:
    stored = await put_terms(client, ["Linkt", "LINKT", "Roger", "linkt", "roger"])

    assert stored == ["Linkt", "Roger"]
    assert await get_terms(client) == ["Linkt", "Roger"]


# "ODOS" in Greek capitals and in small letters. Python's str.lower() turns the capital's last sigma
# into the final form, Postgres's lower() (letter by letter) into the plain one: two terms to
# Python, one to the unique index under this project's en_US.utf8 database.
GREEK_CAPITALS = "\u039f\u0394\u039f\u03a3"
GREEK_SMALL = "\u03bf\u03b4\u03bf\u03c3"


async def test_postgres_decides_which_spellings_are_one_term(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    # Deduped by Python's lower(), both reach one upsert and Postgres refuses it (a 500).
    async with database_of(app).session() as session:
        one_term = await session.scalar(
            select(func.lower(GREEK_CAPITALS) == func.lower(GREEK_SMALL))
        )

    stored = await put_terms(client, [GREEK_CAPITALS, GREEK_SMALL])

    assert stored == ([GREEK_CAPITALS] if one_term else [GREEK_CAPITALS, GREEK_SMALL])


async def test_a_term_sent_in_another_case_takes_the_new_spelling(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings
) -> None:
    await put_terms(client, ["linkt"])
    [(row_id, _, created_at)] = await stored_rows(app, settings.default_workspace_id)

    assert await put_terms(client, ["Linkt"]) == ["Linkt"]
    # Still the same term, so the same row: only its spelling changed.
    assert await stored_rows(app, settings.default_workspace_id) == [(row_id, "Linkt", created_at)]


async def test_terms_are_trimmed_before_duplicates_are_dropped(client: httpx.AsyncClient) -> None:
    stored = await put_terms(client, ["  Linkt  ", "\tRoger\n", "linkt "])

    assert stored == ["Linkt", "Roger"]


async def test_put_is_idempotent(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings
) -> None:
    terms = ["Roger", "Linkt", "AssemblyAI"]
    first = await put_terms(client, terms)
    rows = await stored_rows(app, settings.default_workspace_id)

    again = await put_terms(client, terms)

    assert again == first == ["AssemblyAI", "Linkt", "Roger"]
    # Unchanged terms keep their rows, ids and created_at: a re-sent list rewrites nothing.
    assert await stored_rows(app, settings.default_workspace_id) == rows


# ---------------------------------------------------------------------------- limits

LONGEST_TERM = "x" * 50
# 16 distinct terms of 50 characters: 800 in all, the most a list may hold.
FULL_LENGTH_TERMS = [f"{index:02d}{'x' * 48}" for index in range(16)]


@pytest.mark.parametrize(
    ("body", "field"),
    [
        pytest.param({"terms": [f"term {index}" for index in range(101)]}, "body.terms", id="101"),
        pytest.param(
            # Limits count the list as sent, before duplicates are dropped.
            {"terms": [f"term {index}" for index in range(99)] + ["Linkt", "LINKT"]},
            "body.terms",
            id="101-with-duplicates",
        ),
        pytest.param({"terms": ["x" * 51]}, "body.terms[0]", id="51-characters"),
        pytest.param({"terms": [*FULL_LENGTH_TERMS, "y"]}, "body.terms", id="801-in-all"),
        pytest.param({"terms": ["Linkt", "   "]}, "body.terms[1]", id="blank"),
        pytest.param({"terms": ["Linkt", ""]}, "body.terms[1]", id="empty"),
        pytest.param({"terms": ["Lin\u0007kt"]}, "body.terms[0]", id="control-character"),
        pytest.param({"terms": ["Lin\nkt"]}, "body.terms[0]", id="newline-inside"),
        pytest.param({"terms": ["Lin\u0085kt"]}, "body.terms[0]", id="c1-control-character"),
        pytest.param({"terms": [42]}, "body.terms[0]", id="not-a-string"),
        pytest.param({"terms": "Linkt"}, "body.terms", id="not-a-list"),
        pytest.param({}, "body.terms", id="missing"),
    ],
)
async def test_limits_are_validation_errors(
    client: httpx.AsyncClient, body: Json, field: str
) -> None:
    await put_terms(client, ["Roger"])

    message = assert_error(await client.put(PATH, json=body), 422, "validation_error")

    assert field in message
    # A refused list changes nothing.
    assert await get_terms(client) == ["Roger"]


@pytest.mark.parametrize(
    "terms",
    [
        pytest.param([f"term {index:03d}" for index in range(100)], id="100-terms"),
        pytest.param([LONGEST_TERM], id="50-characters"),
        pytest.param(FULL_LENGTH_TERMS, id="800-in-all"),
        # Measured after trimming: the spaces around a 50-character term do not count.
        pytest.param([f"  {LONGEST_TERM}  "], id="50-characters-after-trimming"),
    ],
)
async def test_limits_take_the_largest_list(client: httpx.AsyncClient, terms: list[str]) -> None:
    stored = await put_terms(client, terms)

    assert len(stored) == len(terms)


async def test_the_database_keeps_one_row_per_term_per_workspace(
    app: FastAPI, settings: Settings
) -> None:
    # The unique index on (workspace_id, lower(term)) backs the API's case-insensitive dedupe.
    async with database_of(app).session() as session:
        session.add(
            VocabularyTerm(id=uuid4(), workspace_id=settings.default_workspace_id, term="Linkt")
        )
        await session.commit()
        session.add(
            VocabularyTerm(id=uuid4(), workspace_id=settings.default_workspace_id, term="LINKT")
        )
        with pytest.raises(IntegrityError, match="ix_vocabulary_terms_workspace_id_lower_term"):
            await session.commit()


# ---------------------------------------------------------------------------- isolation


async def test_other_workspace_terms_are_never_read_or_deleted(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    other_workspace_id = await add_workspace_with_terms(app, "Linkt", "Secret")
    other_rows = await stored_rows(app, other_workspace_id)

    # The same term, in another case, is a term of its own in this workspace.
    assert await put_terms(client, ["linkt", "Roger"]) == ["linkt", "Roger"]
    assert await get_terms(client) == ["linkt", "Roger"]
    assert await put_terms(client, []) == []
    assert await get_terms(client) == []

    assert await stored_rows(app, other_workspace_id) == other_rows


async def test_concurrent_puts_take_turns(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings
) -> None:
    # Without the lock two PUTs interleave their delete and insert, and the stored list becomes
    # the union of both instead of either one. Hold the lock a PUT takes, as a PUT still running
    # would, and check that a second PUT waits for it.
    async with database_of(app).session() as running_put:
        await vocabulary._lock_the_list(running_put, default_principal(settings))
        put = asyncio.create_task(client.put(PATH, json={"terms": ["Linkt"]}))
        done, _ = await asyncio.wait({put}, timeout=0.5)

        assert not done, "a PUT ran while another PUT of the same list was still running"
        await running_put.rollback()

    response = await put
    assert response.status_code == 200, response.text
    assert await get_terms(client) == ["Linkt"]


async def test_a_save_of_the_list_never_holds_up_a_meeting(
    app: FastAPI, client: httpx.AsyncClient, settings: Settings
) -> None:
    # A plain FOR UPDATE on the workspace row would block every insert that references the
    # workspace (its foreign key check takes FOR KEY SHARE) until the PUT commits.
    async with database_of(app).session() as running_put:
        await vocabulary._lock_the_list(running_put, default_principal(settings))

        async with asyncio.timeout(5):
            meeting = await create_meeting(client)
            await append_segments(client, meeting["id"], segment_payload())

        await running_put.rollback()


# ---------------------------------------------------------------------------- auth


@pytest.mark.parametrize(
    "headers",
    [
        pytest.param({}, id="missing"),
        pytest.param({"Authorization": f"Bearer {TEST_TOKEN}x"}, id="wrong-token"),
    ],
)
async def test_vocabulary_needs_the_bearer_token(
    client: httpx.AsyncClient, anonymous_client: httpx.AsyncClient, headers: dict[str, str]
) -> None:
    await put_terms(client, ["Roger"])

    assert_error(await anonymous_client.get(PATH, headers=headers), 401, "unauthorized")
    assert_error(
        await anonymous_client.put(PATH, headers=headers, json={"terms": ["Linkt"]}),
        401,
        "unauthorized",
    )

    assert await get_terms(client) == ["Roger"]
