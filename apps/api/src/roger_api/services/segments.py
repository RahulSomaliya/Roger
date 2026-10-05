from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import ColumnElement, case, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from roger_api.auth import Principal
from roger_api.db.models import TranscriptSegment
from roger_api.errors import ConflictError
from roger_api.schemas.segments import SegmentIn
from roger_api.services.meetings import require_meeting
from roger_api.services.records import (
    AppendResult,
    MeetingRecord,
    Transcript,
    TranscriptLine,
    TranscriptLines,
)

# Transcript order: start_ms, then the mic ("me") line before the system ("them") line, then id.
_TRANSCRIPT_ORDER = (
    TranscriptSegment.start_ms,
    case({"mic": 0}, value=TranscriptSegment.source, else_=1),
    TranscriptSegment.id,
)


async def append_segments(
    session: AsyncSession, principal: Principal, meeting_id: UUID, segments: Sequence[SegmentIn]
) -> AppendResult:
    """Insert segments idempotently. Ids already stored for this meeting count as duplicates.

    Raises `ConflictError` when an id is already stored under a different meeting.
    """
    # A segment always lands in its meeting's workspace. The meetings list counts segments by
    # meeting_id alone (`_with_segment_count` in services/meetings.py) and relies on this.
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


def _segments_of(principal: Principal, meeting_id: UUID) -> tuple[ColumnElement[bool], ...]:
    return (
        TranscriptSegment.meeting_id == meeting_id,
        TranscriptSegment.workspace_id == principal.workspace_id,
    )


async def get_transcript(
    session: AsyncSession, principal: Principal, meeting_id: UUID
) -> Transcript:
    """The meeting and its full segment rows (words included), in transcript order."""
    meeting = await require_meeting(session, principal, meeting_id)
    segments = (
        await session.scalars(
            select(TranscriptSegment)
            .where(*_segments_of(principal, meeting_id))
            .order_by(*_TRANSCRIPT_ORDER)
        )
    ).all()
    return Transcript(
        meeting=MeetingRecord(meeting=meeting, segment_count=len(segments)), segments=segments
    )


async def get_transcript_lines(
    session: AsyncSession, principal: Principal, meeting_id: UUID
) -> TranscriptLines:
    """The meeting and the columns a plain-text transcript shows, in transcript order.

    Never select `words` here. Per-word timings are most of a row, and the text never shows
    them: loading full rows made a long call's MCP read fetch and validate every word only to
    drop it (`test_transcript_text_never_reads_word_timings` pins this). Use `get_transcript`
    when the caller needs the words.
    """
    meeting = await require_meeting(session, principal, meeting_id)
    rows = await session.execute(
        select(TranscriptSegment.start_ms, TranscriptSegment.speaker, TranscriptSegment.text)
        .where(*_segments_of(principal, meeting_id))
        .order_by(*_TRANSCRIPT_ORDER)
    )
    lines = [
        TranscriptLine(start_ms=start_ms, speaker=speaker, text=text)
        for start_ms, speaker, text in rows
    ]
    return TranscriptLines(
        meeting=MeetingRecord(meeting=meeting, segment_count=len(lines)), lines=lines
    )
