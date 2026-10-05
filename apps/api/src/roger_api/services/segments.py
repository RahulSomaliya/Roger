from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import case, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from roger_api.auth import Principal
from roger_api.db.models import TranscriptSegment
from roger_api.errors import ConflictError
from roger_api.schemas.segments import SegmentIn
from roger_api.services.meetings import require_meeting
from roger_api.services.records import AppendResult, MeetingRecord, Transcript

# Transcript order at equal start_ms: the mic ("me") line before the system ("them") line.
_SOURCE_ORDER = case({"mic": 0}, value=TranscriptSegment.source, else_=1)


async def append_segments(
    session: AsyncSession, principal: Principal, meeting_id: UUID, segments: Sequence[SegmentIn]
) -> AppendResult:
    """Insert segments idempotently. Ids already stored for this meeting count as duplicates.

    Raises `ConflictError` when an id is already stored under a different meeting.
    """
    await require_meeting(session, principal, meeting_id)
    rows = [
        {**segment.model_dump(), "meeting_id": meeting_id, "workspace_id": principal.workspace_id}
        for segment in segments
    ]
    inserted = set(
        await session.scalars(
            insert(TranscriptSegment)
            .values(rows)
            .on_conflict_do_nothing(index_elements=[TranscriptSegment.id])
            .returning(TranscriptSegment.id)
        )
    )
    skipped = {segment.id for segment in segments} - inserted
    if skipped and await _any_stored_elsewhere(session, skipped, meeting_id):
        await session.rollback()
        raise ConflictError("A segment id in this batch already belongs to another meeting")
    await session.commit()
    return AppendResult(accepted=len(inserted), duplicates=len(segments) - len(inserted))


async def _any_stored_elsewhere(
    session: AsyncSession, segment_ids: set[UUID], meeting_id: UUID
) -> bool:
    # Segment ids are globally unique primary keys, so this check cannot be workspace-scoped.
    # It reveals nothing about the other row beyond the conflict itself.
    found = await session.scalar(
        select(TranscriptSegment.id)
        .where(TranscriptSegment.id.in_(segment_ids), TranscriptSegment.meeting_id != meeting_id)
        .limit(1)
    )
    return found is not None


async def get_transcript(
    session: AsyncSession, principal: Principal, meeting_id: UUID
) -> Transcript:
    """The meeting and its segments ordered by `start_ms`, then source (mic first), then id."""
    meeting = await require_meeting(session, principal, meeting_id)
    segments = (
        await session.scalars(
            select(TranscriptSegment)
            .where(
                TranscriptSegment.meeting_id == meeting_id,
                TranscriptSegment.workspace_id == principal.workspace_id,
            )
            .order_by(TranscriptSegment.start_ms, _SOURCE_ORDER, TranscriptSegment.id)
        )
    ).all()
    return Transcript(
        meeting=MeetingRecord(meeting=meeting, segment_count=len(segments)), segments=segments
    )
