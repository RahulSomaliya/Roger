"""Read models the services return: ORM rows plus the values computed alongside them."""

from collections.abc import Sequence
from dataclasses import dataclass

from roger_api.db.models import Meeting, TranscriptSegment


@dataclass(frozen=True, slots=True)
class MeetingRecord:
    meeting: Meeting
    segment_count: int


@dataclass(frozen=True, slots=True)
class Transcript:
    meeting: MeetingRecord
    segments: Sequence[TranscriptSegment]


@dataclass(frozen=True, slots=True)
class TranscriptLine:
    """The columns a plain-text transcript shows. No `words`: they are the bulk of a row."""

    start_ms: int
    speaker: str
    text: str


@dataclass(frozen=True, slots=True)
class TranscriptLines:
    meeting: MeetingRecord
    lines: Sequence[TranscriptLine]


@dataclass(frozen=True, slots=True)
class AppendResult:
    accepted: int
    duplicates: int
