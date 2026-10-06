"""A short-lived speech-to-text credential, and the stream settings and jargon list that go with it.

Every route resolves the `Principal` first (`PrincipalDep`); tests/test_auth.py fails any route
that answers without a token.
"""

from fastapi import APIRouter

from roger_api.auth import PrincipalDep
from roger_api.dependencies import DatabaseDep, SettingsDep, SttTokenIssuerDep
from roger_api.routers.responses import ERROR_RESPONSES
from roger_api.schemas.common import ErrorEnvelope
from roger_api.schemas.stt import SttStreamSettings, SttTokenOut
from roger_api.services import vocabulary

router = APIRouter(prefix="/v1/stt", tags=["speech-to-text"], responses=ERROR_RESPONSES)


@router.post(
    "/token",
    responses={502: {"model": ErrorEnvelope, "description": "The vendor refused or failed"}},
)
async def issue_stt_token(
    principal: PrincipalDep,
    database: DatabaseDep,
    issuer: SttTokenIssuerDep,
    settings: SettingsDep,
) -> SttTokenOut:
    # The jargon list first, in one query of at most 100 terms (services/vocabulary.py), and in a
    # session closed before the vendor is called: a request-scoped session would hold its pooled
    # connection idle in a transaction for as long as the vendor takes to answer. Read first, a
    # failed read also mints no vendor token, and the token's lifetime starts as late as it can.
    async with database.session() as session:
        keyterms = await vocabulary.list_terms(session, principal)
    credential = await issuer.issue()
    return SttTokenOut(
        provider=credential.provider,
        access_token=credential.access_token,
        expires_in=credential.expires_in,
        stream=SttStreamSettings.from_settings(settings, keyterms=keyterms),
    )
