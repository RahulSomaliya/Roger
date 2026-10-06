import re
from datetime import UTC, datetime
from typing import Annotated

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    Field,
    StringConstraints,
)


def _to_utc(value: datetime) -> datetime:
    return value.astimezone(UTC)


# Timezone-aware instant, normalised to UTC so it serialises with a `Z` suffix.
UtcDatetime = Annotated[AwareDatetime, AfterValidator(_to_utc)]

# What Postgres cannot store: U+0000 (in `text` and `jsonb`) and a UTF-16 surrogate (UTF-8 cannot
# encode one). Python's JSON parser joins an escaped pair into one character, so a surrogate left
# in a parsed string is an unpaired one: half an emoji, which JSON.stringify sends as an escape.
_UNSTORABLE_CHARACTER = re.compile(r"[\x00\ud800-\udfff]")


def storable_text(text: str) -> str:
    """`text` as Postgres can store it: every U+0000 dropped, every unpaired surrogate replaced by
    U+FFFD.

    Dropped, not refused: neither is text anyone reads, and a refusal costs more than the
    character. Kept, a U+0000 fails the write with a 500; refused with a 422, a meeting create is
    retried by TranscriptUploader.ts forever (the meeting, transcript included, never reaches the
    server) and a transcript line is set aside unsent.
    """
    return _UNSTORABLE_CHARACTER.sub(
        lambda match: "" if match.group() == "\x00" else "\ufffd", text
    )


def storable_input(value: object) -> object:
    """`storable_text` for a `BeforeValidator`, which sees the raw input: anything but a string
    passes through for the type check to refuse."""
    return storable_text(value) if isinstance(value, str) else value


NonEmptyText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1),
    # After the constraints, never before: written first, it makes pydantic check the length
    # before the trim (CalendarText in schemas/meetings.py). It runs first all the same, so a
    # line of U+0000 alone is empty, a 422.
    BeforeValidator(storable_input),
]

# Offsets are stored in Postgres `integer` columns.
OffsetMs = Annotated[int, Field(ge=0, le=2_147_483_647)]

Confidence = Annotated[float, Field(ge=0, le=1)]


class ErrorBody(BaseModel):
    code: str
    message: str


class ErrorEnvelope(BaseModel):
    error: ErrorBody
