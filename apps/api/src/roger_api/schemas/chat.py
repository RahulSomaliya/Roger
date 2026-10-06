"""Chat with one meeting on the wire (M4-T10): the question the desktop sends and the messages it
reads (docs/api-contract.md, "Chat"). The desktop reads them in `main/api/notesClient.ts` (the
thread) and `main/notes/LlmStreams.ts` (`done`): change the three together.
"""

from typing import Annotated, Self
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, StringConstraints

from roger_api.db.models_notes import ChatMessage, ChatMessageStatus, ChatRole
from roger_api.schemas.common import OffsetMs, UtcDatetime

# Private there because schemas/notes.py has another owner in Phase 2; one rule for what Postgres
# cannot store, for notes docs and chat text alike.
from roger_api.schemas.notes import _storable_text

# `MAX_CHAT_TEXT_CHARS` in apps/desktop/src/shared/notes.ts, in characters (code points, as both
# sides count them). The desktop counts before trimming, this after: never stricter than the
# desktop, or a question it sent would be refused with nothing it could change.
MAX_CHAT_TEXT_CHARS = 4000


def storable_text(text: str) -> str:
    """`text` as a Postgres `text` column can hold it: U+0000 dropped, each unpaired surrogate
    replaced by U+FFFD. Either one, stored as sent, fails the write with a 500 (CLAUDE.md failure
    log). Model output goes through here too: a model can write either."""
    return _storable_text(text)


def _storable(value: object) -> object:
    return storable_text(value) if isinstance(value, str) else value


ChatText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_CHAT_TEXT_CHARS),
    # After the constraints, never before: written first, it makes pydantic check the lengths
    # before the trim, so " " passes as "" (schemas/meetings.py, `CalendarText`).
    BeforeValidator(_storable),
]


class ChatAsk(BaseModel):
    """`POST /v1/meetings/{id}/chat`: a question about the meeting."""

    # The desktop's id for the question. Sent again it never stores a second message: matched by
    # id alone, like segment ids, so a re-send with other text answers the stored question.
    message_id: UUID
    text: ChatText


class ChatCitation(BaseModel):
    """A ref the answer cites (`L12`), mapped to its transcript line."""

    ref: str
    segment_id: UUID
    start_ms: OffsetMs


class ChatMessageOut(BaseModel):
    """`ChatMessage` in docs/api-contract.md: a question or an answer, as stored."""

    id: UUID
    role: ChatRole
    text: str
    # An answer's citations in the order they first appear in `text`; null for a question.
    citations: list[ChatCitation] | None
    # The question an answer replies to; null for a question.
    reply_to: UUID | None
    # The run that wrote an answer (the latest, when it was written again); null for a question.
    run_id: UUID | None
    status: ChatMessageStatus
    created_at: UtcDatetime

    @classmethod
    def from_row(cls, message: ChatMessage) -> Self:
        citations = message.citations
        return cls(
            id=message.id,
            role=message.role,
            text=message.text,
            citations=None
            if citations is None
            else [ChatCitation.model_validate(citation) for citation in citations],
            reply_to=message.reply_to,
            run_id=message.run_id,
            status=message.status,
            created_at=message.created_at,
        )


class ChatThread(BaseModel):
    """`GET /v1/meetings/{id}/chat`: the latest messages, oldest first."""

    items: list[ChatMessageOut]
