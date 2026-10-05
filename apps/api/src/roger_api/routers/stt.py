from fastapi import APIRouter, Depends

from roger_api.auth import get_principal
from roger_api.dependencies import SettingsDep, SttTokenIssuerDep
from roger_api.routers.responses import ERROR_RESPONSES
from roger_api.schemas.common import ErrorEnvelope
from roger_api.schemas.stt import SttStreamSettings, SttTokenOut

router = APIRouter(
    prefix="/v1/stt",
    tags=["speech-to-text"],
    dependencies=[Depends(get_principal)],
    responses=ERROR_RESPONSES,
)


@router.post(
    "/token",
    responses={502: {"model": ErrorEnvelope, "description": "The vendor refused or failed"}},
)
async def issue_stt_token(issuer: SttTokenIssuerDep, settings: SettingsDep) -> SttTokenOut:
    credential = await issuer.issue()
    return SttTokenOut(
        provider=credential.provider,
        access_token=credential.access_token,
        expires_in=credential.expires_in,
        stream=SttStreamSettings.from_settings(settings),
    )
