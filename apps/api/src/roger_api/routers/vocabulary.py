"""The workspace jargon list: names the speech-to-text vendor should spell right (M3-T2).

app.py includes `router` once; its prefix, tags and routes live here. Every route resolves the
`Principal` first (`PrincipalDep`); tests/test_auth.py fails any route that answers without a token.
"""

from fastapi import APIRouter

from roger_api.auth import PrincipalDep
from roger_api.dependencies import SessionDep
from roger_api.routers.responses import ERROR_RESPONSES
from roger_api.schemas.vocabulary import VocabularyIn, VocabularyOut
from roger_api.services import vocabulary

router = APIRouter(prefix="/v1/vocabulary", tags=["vocabulary"], responses=ERROR_RESPONSES)


@router.get("")
async def get_vocabulary(principal: PrincipalDep, session: SessionDep) -> VocabularyOut:
    return VocabularyOut(terms=await vocabulary.list_terms(session, principal))


@router.put("")
async def replace_vocabulary(
    body: VocabularyIn, principal: PrincipalDep, session: SessionDep
) -> VocabularyOut:
    return VocabularyOut(terms=await vocabulary.replace_terms(session, principal, body.terms))
