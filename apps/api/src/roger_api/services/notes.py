"""The two notes docs of a meeting, the user's and the AI's (M4-T6). Every query is scoped to the
caller's workspace.

Saves follow the conflict rule of M4's plan (D5): a save names the version it builds on and carries
the client's `revision_id`, so a stale save is a conflict and a re-sent one is answered from what
is stored. The AI doc has one more rule: it is never saved while a notes run is running, because
that run is about to replace it.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from roger_api.auth import Principal
from roger_api.db.models import Meeting
from roger_api.db.models_notes import LlmRun, MeetingNote
from roger_api.domain import NoteKind
from roger_api.errors import ConflictError
from roger_api.services.meetings import meeting_not_found, require_meeting


@dataclass(frozen=True, slots=True)
class MeetingNotes:
    user: MeetingNote | None
    ai: MeetingNote | None


async def lock_meeting(session: AsyncSession, principal: Principal, meeting_id: UUID) -> None:
    """Lock the meeting row for a notes write, until the transaction ends. Raises `NotFoundError`.

    The notes run claim (M4-T8) takes this lock before it inserts its running run, and every save
    takes it before it reads the stored note: the meeting row exists before any note or run row,
    so it is the one lock both paths can take. A save then lands wholly before a claim, which sees
    its version, or wholly after it, and sees the run (a 409 for the AI doc). Without it, a save
    that reads between the claim's insert and its commit stores an AI edit the claim's version
    check never saw, and the run then replaces it without asking first.

    FOR NO KEY UPDATE, not FOR UPDATE: it conflicts with itself and with FOR UPDATE, so a claim
    taking either lock still takes turns with a save, but it leaves alone the FOR KEY SHARE lock
    that every segment insert takes on its meeting (the foreign key check). A plain FOR UPDATE
    would hold the transcript upload of a live call behind every notes save
    (test_a_notes_save_never_holds_up_the_transcript).
    """
    locked = await session.scalar(
        select(Meeting.id)
        .where(Meeting.id == meeting_id, Meeting.workspace_id == principal.workspace_id)
        .with_for_update(key_share=True)
    )
    if locked is None:
        raise meeting_not_found(meeting_id)


async def get_notes(session: AsyncSession, principal: Principal, meeting_id: UUID) -> MeetingNotes:
    """Both notes of the meeting, None where one was never saved. Raises `NotFoundError`."""
    await require_meeting(session, principal, meeting_id)
    rows = await session.scalars(
        select(MeetingNote).where(
            MeetingNote.meeting_id == meeting_id,
            MeetingNote.workspace_id == principal.workspace_id,
        )
    )
    by_kind = {row.kind: row for row in rows}
    return MeetingNotes(user=by_kind.get("user"), ai=by_kind.get("ai"))


async def save_note(
    session: AsyncSession,
    principal: Principal,
    meeting_id: UUID,
    kind: NoteKind,
    *,
    doc: Mapping[str, Any],
    base_version: int,
    revision_id: UUID,
) -> MeetingNote:
    """Store `doc` as the meeting's `kind` note, one version above `base_version`.

    `base_version` 0 creates the note. A `revision_id` equal to the stored note's is the save that
    made it, sent again: the stored note is returned and nothing is written, whatever the re-send
    carries (matched by id alone, as segment ids are). Only the latest save matches, so an older
    one sent again is a stale base and never rolls the doc back.

    Raises `NotFoundError` for a meeting outside the caller's workspace, and `ConflictError` when
    `base_version` is not the stored version, or when `kind` is `ai` and a notes run of the meeting
    is running. A save of the AI doc keeps the run's `template_id`, `last_run_id` and
    `generated_version`: a `version` above `generated_version` means edited since that run.
    """
    await lock_meeting(session, principal, meeting_id)
    note = await session.scalar(
        select(MeetingNote).where(
            MeetingNote.meeting_id == meeting_id,
            MeetingNote.workspace_id == principal.workspace_id,
            MeetingNote.kind == kind,
        )
    )
    if note is not None and note.last_revision_id == revision_id:
        # Commit, not rollback, to release the lock: a rollback expires `note`, and reading an
        # expired attribute later is a lazy load, which an AsyncSession refuses.
        await session.commit()
        return note
    if kind == "ai" and await _notes_run_is_running(session, principal, meeting_id):
        await session.rollback()
        raise ConflictError(
            f"The AI notes of meeting {meeting_id} are being generated; "
            "they can be edited once the run finishes"
        )
    stored_version = 0 if note is None else note.version
    if base_version != stored_version:
        await session.rollback()
        raise ConflictError(
            f"The {kind} notes of meeting {meeting_id} are at version {stored_version}; "
            f"this save builds on version {base_version}"
        )
    if note is None:
        note = MeetingNote(
            id=uuid4(),
            workspace_id=principal.workspace_id,
            meeting_id=meeting_id,
            kind=kind,
            doc=dict(doc),
            version=1,
            last_revision_id=revision_id,
        )
        session.add(note)
    else:
        note.doc = dict(doc)
        note.version = stored_version + 1
        note.last_revision_id = revision_id
    await session.commit()
    # Postgres sets updated_at (now(), on insert and update), so the row holds the only copy.
    await session.refresh(note, ["updated_at"])
    return note


async def _notes_run_is_running(
    session: AsyncSession, principal: Principal, meeting_id: UUID
) -> bool:
    # Answered from the partial unique index that allows one running notes run per meeting.
    running = await session.scalar(
        select(LlmRun.id)
        .where(
            LlmRun.meeting_id == meeting_id,
            LlmRun.workspace_id == principal.workspace_id,
            LlmRun.kind == "notes",
            LlmRun.status == "running",
        )
        .limit(1)
    )
    return running is not None
