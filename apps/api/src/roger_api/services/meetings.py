from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import Select, func, select, tuple_, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from roger_api.auth import Principal
from roger_api.db.models import Meeting, TranscriptSegment
from roger_api.errors import NotFoundError
from roger_api.services.records import MeetingRecord


def meeting_not_found(meeting_id: UUID) -> NotFoundError:
    return NotFoundError(f"Meeting {meeting_id} not found")


def _with_segment_count(principal: Principal) -> Select[Meeting, int]:
    # Counted by meeting_id alone so Postgres counts entries of the (meeting_id, start_ms) index
    # (an index-only scan). Adding `workspace_id == Meeting.workspace_id` here forced a fetch of
    # every segment row of every listed meeting (the plan is pinned by
    # test_segment_counts_are_read_from_the_meeting_index). Isolation still holds: the outer query
    # only returns meetings in the caller's workspace, and append_segments stores a segment only
    # under a meeting it has checked belongs to that same workspace.
    segment_count = (
        select(func.count())
        .select_from(TranscriptSegment)
        .where(TranscriptSegment.meeting_id == Meeting.id)
        .correlate(Meeting)
        .scalar_subquery()
    )
    return select(Meeting, segment_count).where(Meeting.workspace_id == principal.workspace_id)


async def get_meeting(
    session: AsyncSession, principal: Principal, meeting_id: UUID
) -> MeetingRecord:
    """The meeting with its segment count. Raises `NotFoundError`."""
    row = (
        await session.execute(_with_segment_count(principal).where(Meeting.id == meeting_id))
    ).one_or_none()
    if row is None:
        raise meeting_not_found(meeting_id)
    meeting, segment_count = row
    return MeetingRecord(meeting=meeting, segment_count=segment_count)


async def require_meeting(session: AsyncSession, principal: Principal, meeting_id: UUID) -> Meeting:
    """The meeting row without its segment count. Raises `NotFoundError`."""
    meeting = await session.scalar(
        select(Meeting).where(
            Meeting.id == meeting_id, Meeting.workspace_id == principal.workspace_id
        )
    )
    if meeting is None:
        raise meeting_not_found(meeting_id)
    return meeting


async def create_meeting(
    session: AsyncSession,
    principal: Principal,
    *,
    meeting_id: UUID | None,
    title: str,
    started_at: datetime | None,
) -> tuple[MeetingRecord, bool]:
    """Create a meeting, or return the existing one with that id. The bool is `created`.

    An id that already belongs to another workspace is reported as not found.
    """
    meeting_id = meeting_id or uuid4()
    inserted_id = await session.scalar(
        insert(Meeting)
        .values(
            id=meeting_id,
            workspace_id=principal.workspace_id,
            title=title,
            status="recording",
            started_at=started_at or datetime.now(UTC),
        )
        .on_conflict_do_nothing(index_elements=[Meeting.id])
        .returning(Meeting.id)
    )
    await session.commit()
    return await get_meeting(session, principal, meeting_id), inserted_id is not None


async def list_meetings(
    session: AsyncSession,
    principal: Principal,
    *,
    limit: int,
    before: datetime | None = None,
    before_id: UUID | None = None,
) -> list[MeetingRecord]:
    """Newest first by `started_at`, then `id`. Pages backwards from a keyset cursor.

    The next page starts after the last item: pass its `started_at` as `before` and its `id` as
    `before_id`. `before` alone keeps only meetings that started strictly earlier.
    """
    query = _with_segment_count(principal)
    if before is not None and before_id is not None:
        # The cursor must cover the whole sort key. With `started_at < before` alone, meetings
        # sharing the last item's started_at fell between two pages and were never listed.
        query = query.where(tuple_(Meeting.started_at, Meeting.id) < tuple_(before, before_id))
    elif before is not None:
        query = query.where(Meeting.started_at < before)
    rows = await session.execute(
        query.order_by(Meeting.started_at.desc(), Meeting.id.desc()).limit(limit)
    )
    return [MeetingRecord(meeting=meeting, segment_count=count) for meeting, count in rows]


async def end_meeting(
    session: AsyncSession, principal: Principal, meeting_id: UUID, *, ended_at: datetime | None
) -> MeetingRecord:
    """Mark a meeting ended. Ending an ended meeting returns it unchanged."""
    await session.execute(
        update(Meeting)
        .where(
            Meeting.id == meeting_id,
            Meeting.workspace_id == principal.workspace_id,
            Meeting.status == "recording",
        )
        .values(status="ended", ended_at=ended_at or datetime.now(UTC))
    )
    await session.commit()
    return await get_meeting(session, principal, meeting_id)
