"""Speech-to-text usage per meeting, and cost per meeting hour (M3-T19a). Every query is scoped
to the caller's workspace.

The API never recomputes a cost: the desktop meters what the vendor bills (open time, priced per
session at its open, from the price in its token) and sends the estimate. A second computation
here, from connected time, would drift from it.
"""

from datetime import datetime
from decimal import MAX_PREC, ROUND_HALF_UP, Context, Decimal
from typing import Any
from uuid import UUID

from sqlalchemy import Numeric, Select, and_, case, cast, extract, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from roger_api.auth import Principal
from roger_api.db.models import Meeting
from roger_api.db.models_stt_usage import MeetingSttUsage
from roger_api.schemas.stt_usage import SttUsageIn, SttUsageSummary

# The summary counts every meeting with an unknown price and names this many, newest first.
MAX_NAMED_UNPRICED_MEETINGS = 100

_SECONDS_PER_HOUR = Decimal(3600)
_MS_PER_HOUR = Decimal(3_600_000)
_PLACES = Decimal("0.0001")
# Rounding to _PLACES needs the value's integer digits plus four. Under Python's default context
# (28 digits) any figure of 1e24 or more raised InvalidOperation, a 500 on every later summary of
# the workspace, and the saving reaches 9.2e24 from usage the PUT accepts (a cost at the cap, 1 ms
# connected, the most gated time). quantize allocates the result's digits, never MAX_PREC's.
_EXACT = Context(prec=MAX_PREC)

# When a meeting happened, for `since`: its start, or, with no meeting row (the desktop deletes a
# meeting that got no line), when its usage first arrived. The uploader sends usage while the
# meeting records, so the two are minutes apart.
_MEETING_TIME = func.coalesce(Meeting.started_at, MeetingSttUsage.created_at)
# A meeting's length in seconds; NULL with no meeting row or while it still records. GREATEST
# keeps an end before the start (a skewed clock) at 0, never negative hours. The CASE must wrap
# it: GREATEST ignores NULLs, so GREATEST(NULL, 0) is 0, and an unknown length would read as 0.
_MEETING_SECONDS = case(
    (
        Meeting.ended_at.is_not(None),
        func.greatest(cast(extract("epoch", Meeting.ended_at - Meeting.started_at), Numeric), 0),
    )
)
_PRICED = MeetingSttUsage.estimated_cost_usd.is_not(None)
_PRICED_AND_TIMED = and_(_PRICED, _MEETING_SECONDS.is_not(None))


async def save_usage(
    session: AsyncSession, principal: Principal, meeting_id: UUID, usage: SttUsageIn
) -> MeetingSttUsage:
    """Store `usage` as the meeting's whole usage, replacing what was stored. Needs no meeting row.

    Idempotent: the same usage again stores the same row, and only `updated_at` moves.
    """
    values: dict[str, Any] = {
        "provider": usage.provider,
        "sessions_opened": usage.sessions_opened,
        "connected_ms": usage.connected_ms,
        "audio_sent_ms": usage.audio_sent_ms,
        "dropped_chunks": usage.dropped_chunks,
        "gated_ms": usage.gated_ms,
        # repr is the shortest text that reads back as the same float: 0.19 is stored as 0.19,
        # not as Decimal(0.19)'s 0.190000000000000002220446049250313080847263336181640625.
        "estimated_cost_usd": (
            None if usage.estimated_cost_usd is None else Decimal(repr(usage.estimated_cost_usd))
        ),
        "by_source": usage.by_source.model_dump(),
        "stop_reason": usage.stop_reason,
    }
    upsert = insert(MeetingSttUsage).values(
        workspace_id=principal.workspace_id, meeting_id=meeting_id, **values
    )
    # The conflict target is the primary key, workspace first: another workspace's row for the same
    # meeting id is a different row, never this one. ON CONFLICT ignores `onupdate`, hence the
    # explicit updated_at.
    stored = await session.scalars(
        upsert.on_conflict_do_update(
            index_elements=[MeetingSttUsage.workspace_id, MeetingSttUsage.meeting_id],
            set_={**values, "updated_at": func.now()},
        ).returning(MeetingSttUsage),
        execution_options={"populate_existing": True},
    )
    row = stored.one()
    await session.commit()
    return row


async def summarize(
    session: AsyncSession, principal: Principal, *, since: datetime | None
) -> SttUsageSummary:
    """Totals over the workspace's meetings held at or after `since` (every meeting when None).

    A meeting with an unknown price is counted and named, never summed as 0: its time counts, its
    cost does not, and it is left out of the cost per meeting hour on both sides of the division.
    """
    sums = select(
        func.count().label("meetings"),
        func.count().filter(~_PRICED).label("unpriced"),
        func.coalesce(func.sum(MeetingSttUsage.connected_ms), 0).label("connected_ms"),
        func.coalesce(func.sum(MeetingSttUsage.gated_ms), 0).label("gated_ms"),
        func.coalesce(func.sum(_MEETING_SECONDS), 0).label("meeting_seconds"),
        func.sum(MeetingSttUsage.estimated_cost_usd).label("cost"),
        # The silence gate's saving at the meeting's own average price per stream hour. A meeting
        # with no connected time had no price to save at.
        func.sum(
            MeetingSttUsage.estimated_cost_usd
            * MeetingSttUsage.gated_ms
            / MeetingSttUsage.connected_ms
        )
        .filter(MeetingSttUsage.connected_ms > 0)
        .label("saved"),
        func.sum(MeetingSttUsage.estimated_cost_usd).filter(_PRICED_AND_TIMED).label("timed_cost"),
        func.sum(_MEETING_SECONDS).filter(_PRICED_AND_TIMED).label("timed_seconds"),
    )
    totals = (await session.execute(_in_window(sums, principal, since))).one()
    unpriced_ids = await _newest_unpriced(session, principal, since) if totals.unpriced else []
    # Every meeting's price unknown: no cost at all, rather than a 0 that reads as free. With no
    # meetings in the window, 0 is the truth.
    no_known_price = totals.meetings > 0 and totals.unpriced == totals.meetings
    timed_hours = (totals.timed_seconds or Decimal(0)) / _SECONDS_PER_HOUR
    return SttUsageSummary(
        meetings=totals.meetings,
        stream_hours=_rounded(totals.connected_ms / _MS_PER_HOUR),
        meeting_hours=_rounded(totals.meeting_seconds / _SECONDS_PER_HOUR),
        estimated_cost_usd=None if no_known_price else _rounded(totals.cost or Decimal(0)),
        cost_per_meeting_hour=_rounded(totals.timed_cost / timed_hours) if timed_hours else None,
        gated_hours=_rounded(totals.gated_ms / _MS_PER_HOUR),
        estimated_saved_usd=None if no_known_price else _rounded(totals.saved or Decimal(0)),
        unpriced_meetings=totals.unpriced,
        unpriced_meeting_ids=unpriced_ids,
    )


async def _newest_unpriced(
    session: AsyncSession, principal: Principal, since: datetime | None
) -> list[UUID]:
    ids = await session.scalars(
        _in_window(select(MeetingSttUsage.meeting_id), principal, since)
        .where(~_PRICED)
        .order_by(_MEETING_TIME.desc(), MeetingSttUsage.meeting_id.desc())
        .limit(MAX_NAMED_UNPRICED_MEETINGS)
    )
    return list(ids)


def _in_window[*Columns](
    query: Select[*Columns], principal: Principal, since: datetime | None
) -> Select[*Columns]:
    """`query` over the workspace's usage rows held at or after `since`, each with its meeting."""
    query = (
        query.select_from(MeetingSttUsage)
        # The meeting's row, if any, in the same workspace: a meeting id another workspace uses
        # lends this one neither its times nor its existence.
        .outerjoin(
            Meeting,
            and_(
                Meeting.id == MeetingSttUsage.meeting_id,
                Meeting.workspace_id == MeetingSttUsage.workspace_id,
            ),
        )
        .where(MeetingSttUsage.workspace_id == principal.workspace_id)
    )
    if since is not None:
        query = query.where(since <= _MEETING_TIME)
    return query


def _rounded(value: Decimal) -> float:
    # A finite float because schemas/stt_usage.py caps each cost (MAX_USAGE_COST_USD).
    return float(value.quantize(_PLACES, rounding=ROUND_HALF_UP, context=_EXACT))
