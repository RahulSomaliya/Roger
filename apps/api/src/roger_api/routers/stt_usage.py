"""STT usage: what each meeting's speech-to-text sessions used, and cost per meeting hour
(M3-T19a).

app.py includes `router` once; its prefix, tags and routes live here. Every route resolves the
`Principal` first (`PrincipalDep`); tests/test_auth.py fails any route that answers without a token.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query

from roger_api.auth import PrincipalDep
from roger_api.dependencies import SessionDep
from roger_api.routers.responses import ERROR_RESPONSES
from roger_api.schemas.common import UtcDatetime
from roger_api.schemas.stt_usage import SttUsageIn, SttUsageOut, SttUsageSummary
from roger_api.services import stt_usage

router = APIRouter(prefix="/v1/stt-usage", tags=["speech-to-text"], responses=ERROR_RESPONSES)


@router.put("/meetings/{meeting_id}")
async def save_meeting_usage(
    meeting_id: UUID, body: SttUsageIn, principal: PrincipalDep, session: SessionDep
) -> SttUsageOut:
    row = await stt_usage.save_usage(session, principal, meeting_id, body)
    return SttUsageOut.from_row(row)


@router.get("/summary")
async def get_usage_summary(
    principal: PrincipalDep,
    session: SessionDep,
    since: Annotated[UtcDatetime | None, Query()] = None,
) -> SttUsageSummary:
    return await stt_usage.summarize(session, principal, since=since)
