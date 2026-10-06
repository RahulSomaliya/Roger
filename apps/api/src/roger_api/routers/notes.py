"""Meeting notes routes: the user's and the AI notes documents (M4-T6).

app.py includes `router` once (P2-F2); its prefix, tags and routes live here, never in app.py.
Every route resolves the `Principal` first (`PrincipalDep`); tests/test_auth.py fails any route
that answers without a token.
"""

from uuid import UUID

from fastapi import APIRouter

from roger_api.auth import PrincipalDep
from roger_api.dependencies import SessionDep
from roger_api.domain import NoteKind
from roger_api.routers.responses import ERROR_RESPONSES, NOT_FOUND
from roger_api.schemas.common import ErrorEnvelope
from roger_api.schemas.notes import MeetingNotesOut, NoteOut, NoteSave
from roger_api.services import notes

router = APIRouter(prefix="/v1/meetings", tags=["notes"], responses=ERROR_RESPONSES)


@router.get("/{meeting_id}/notes", responses=NOT_FOUND)
async def get_notes(
    meeting_id: UUID, principal: PrincipalDep, session: SessionDep
) -> MeetingNotesOut:
    return MeetingNotesOut.from_notes(await notes.get_notes(session, principal, meeting_id))


@router.put(
    "/{meeting_id}/notes/{kind}",
    responses={
        **NOT_FOUND,
        409: {
            "model": ErrorEnvelope,
            "description": "base_version is not the stored version, or an AI-doc save while a "
            "notes run of the meeting is running",
        },
    },
)
async def save_note(
    meeting_id: UUID, kind: NoteKind, body: NoteSave, principal: PrincipalDep, session: SessionDep
) -> NoteOut:
    note = await notes.save_note(
        session,
        principal,
        meeting_id,
        kind,
        doc=body.doc,
        base_version=body.base_version,
        revision_id=body.revision_id,
    )
    return NoteOut.from_row(note)
