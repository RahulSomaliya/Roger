"""The workspace jargon list (M3-T2). Every query is scoped to the caller's workspace."""

from collections.abc import Sequence
from uuid import uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from roger_api.auth import Principal
from roger_api.db.models import Workspace
from roger_api.db.models_vocabulary import VocabularyTerm
from roger_api.schemas.vocabulary import MAX_TERMS

# When two spellings are one term: the key of the unique index (db/models_vocabulary.py). Always
# Postgres's lower(), never Python's str.lower(): they differ on some letters (a capital sigma
# ending a word, a dotted capital I, any non-ASCII letter under the C locale), and a dedupe keyed on
# Python's would let two spellings the index calls one term reach the upsert, which then fails with
# "ON CONFLICT DO UPDATE command cannot affect row a second time".
_TERM_KEY = func.lower(VocabularyTerm.term)


async def list_terms(session: AsyncSession, principal: Principal) -> list[str]:
    """The workspace's terms as the user spelled them, sorted ignoring case."""
    terms = await session.scalars(
        select(VocabularyTerm.term)
        .where(VocabularyTerm.workspace_id == principal.workspace_id)
        .order_by(_TERM_KEY)
        # Bounds the read; never cuts a list the API stored, as a PUT stores at most MAX_TERMS.
        .limit(MAX_TERMS)
    )
    return list(terms)


async def replace_terms(
    session: AsyncSession, principal: Principal, terms: Sequence[str]
) -> list[str]:
    """Make `terms` the workspace's whole list. Returns it as stored, in `list_terms` order.

    `terms` arrive trimmed and within the limits (schemas/vocabulary.py). Spellings that differ
    only in case are one term, and the first one sent wins. A term already stored keeps its row (id
    and created_at) and takes the new spelling, so re-sending the same list writes nothing.
    """
    await _lock_the_list(session, principal)
    kept = await _first_spelling_of_each_term(session, terms)
    await session.execute(
        delete(VocabularyTerm).where(
            VocabularyTerm.workspace_id == principal.workspace_id, _TERM_KEY.not_in(list(kept))
        )
    )
    if kept:
        upsert = insert(VocabularyTerm).values(
            [
                {"id": uuid4(), "workspace_id": principal.workspace_id, "term": term}
                for term in kept.values()
            ]
        )
        await session.execute(
            upsert.on_conflict_do_update(
                index_elements=[VocabularyTerm.workspace_id, _TERM_KEY],
                set_={"term": upsert.excluded.term},
                where=VocabularyTerm.term != upsert.excluded.term,
            )
        )
    await session.commit()
    return await list_terms(session, principal)


async def _lock_the_list(session: AsyncSession, principal: Principal) -> None:
    # Two PUTs for one workspace take turns, holding this lock until they commit. Interleaved,
    # each one's delete misses the rows the other inserts, and the stored list becomes the union of
    # both lists instead of either (test_concurrent_puts_take_turns). FOR NO KEY UPDATE, not FOR
    # UPDATE: it leaves alone the FOR KEY SHARE lock that every insert referencing the workspace
    # takes, so meetings and segments are never held up by a save of the list.
    await session.execute(
        select(Workspace.id)
        .where(Workspace.id == principal.workspace_id)
        .with_for_update(key_share=True)
    )


async def _first_spelling_of_each_term(
    session: AsyncSession, terms: Sequence[str]
) -> dict[str, str]:
    """`terms` by their `_TERM_KEY`, computed by Postgres, keeping the first spelling of each."""
    if not terms:
        return {}
    keys = (await session.execute(select(*(func.lower(term) for term in terms)))).one()
    kept: dict[str, str] = {}
    for key, term in zip(keys, terms, strict=True):
        kept.setdefault(key, term)
    return kept
