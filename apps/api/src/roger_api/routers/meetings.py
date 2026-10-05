from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Query, Response, status

from roger_api.auth import PrincipalDep
from roger_api.dependencies import SessionDep
from roger_api.routers.responses import ERROR_RESPONSES, NOT_FOUND
from roger_api.schemas.common import ErrorEnvelope, UtcDatetime
from roger_api.schemas.meetings import MeetingCreate, MeetingEnd, MeetingList, MeetingOut
from roger_api.schemas.segments import SegmentsAppend, SegmentsAppendResult, TranscriptOut
from roger_api.services import meetings, segments

router = APIRouter(prefix="/v1/meetings", tags=["meetings"], responses=ERROR_RESPONSES)


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    responses={
        200: {"model": MeetingOut, "description": "The meeting already existed"},
        **NOT_FOUND,
    },
)
async def create_meeting(
    body: MeetingCreate, response: Response, principal: PrincipalDep, session: SessionDep
) -> MeetingOut:
    record, created = await meetings.create_meeting(
        session, principal, meeting_id=body.id, title=body.title, started_at=body.started_at
    )
    if not created:
        response.status_code = status.HTTP_200_OK
    return MeetingOut.from_record(record)


@router.get("")
async def list_meetings(
    principal: PrincipalDep,
    session: SessionDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    before: Annotated[UtcDatetime | None, Query()] = None,
) -> MeetingList:
    records = await meetings.list_meetings(session, principal, limit=limit, before=before)
    return MeetingList(items=[MeetingOut.from_record(record) for record in records])


@router.get("/{meeting_id}", responses=NOT_FOUND)
async def get_meeting(meeting_id: UUID, principal: PrincipalDep, session: SessionDep) -> MeetingOut:
    return MeetingOut.from_record(await meetings.get_meeting(session, principal, meeting_id))


@router.post(
    "/{meeting_id}/segments",
    responses={
        **NOT_FOUND,
        409: {"model": ErrorEnvelope, "description": "A segment id belongs to another meeting"},
    },
)
async def append_segments(
    meeting_id: UUID, body: SegmentsAppend, principal: PrincipalDep, session: SessionDep
) -> SegmentsAppendResult:
    result = await segments.append_segments(session, principal, meeting_id, body.segments)
    return SegmentsAppendResult(accepted=result.accepted, duplicates=result.duplicates)


@router.post("/{meeting_id}/end", responses=NOT_FOUND)
async def end_meeting(
    meeting_id: UUID,
    principal: PrincipalDep,
    session: SessionDep,
    body: Annotated[MeetingEnd | None, Body()] = None,
) -> MeetingOut:
    ended_at = body.ended_at if body else None
    record = await meetings.end_meeting(session, principal, meeting_id, ended_at=ended_at)
    return MeetingOut.from_record(record)


@router.get("/{meeting_id}/transcript", responses=NOT_FOUND)
async def get_transcript(
    meeting_id: UUID, principal: PrincipalDep, session: SessionDep
) -> TranscriptOut:
    transcript = await segments.get_transcript(session, principal, meeting_id)
    return TranscriptOut.from_transcript(transcript)
