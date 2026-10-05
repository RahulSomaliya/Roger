from datetime import UTC, datetime
from typing import Annotated

from pydantic import AfterValidator, AwareDatetime, BaseModel, Field, StringConstraints


def _to_utc(value: datetime) -> datetime:
    return value.astimezone(UTC)


# Timezone-aware instant, normalised to UTC so it serialises with a `Z` suffix.
UtcDatetime = Annotated[AwareDatetime, AfterValidator(_to_utc)]

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]

# Offsets are stored in Postgres `integer` columns.
OffsetMs = Annotated[int, Field(ge=0, le=2_147_483_647)]

Confidence = Annotated[float, Field(ge=0, le=1)]


class ErrorBody(BaseModel):
    code: str
    message: str


class ErrorEnvelope(BaseModel):
    error: ErrorBody
