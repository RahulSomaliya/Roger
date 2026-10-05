from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest

from roger_api.schemas.meetings import MeetingOut
from roger_api.schemas.segments import SegmentOut, TranscriptOut
from roger_api.services.transcript_render import format_offset, render_transcript, speaker_label

MEETING_ID = UUID("7f3c2d1e-0000-4000-8000-000000000001")
STARTED = datetime(2026, 10, 5, 10, 0, tzinfo=UTC)
ENDED = datetime(2026, 10, 5, 10, 31, 12, 500_000, tzinfo=UTC)


def meeting(*, ended_at: datetime | None = ENDED, segment_count: int = 0) -> MeetingOut:
    return MeetingOut(
        id=MEETING_ID,
        workspace_id=uuid4(),
        title="Weekly sync with Acme",
        status="ended" if ended_at else "recording",
        started_at=STARTED,
        ended_at=ended_at,
        segment_count=segment_count,
        created_at=STARTED,
        updated_at=STARTED,
    )


def segment(start_ms: int, speaker: str, text: str) -> SegmentOut:
    return SegmentOut(
        id=uuid4(),
        meeting_id=MEETING_ID,
        source="mic" if speaker == "me" else "system",
        speaker=speaker,
        start_ms=start_ms,
        end_ms=start_ms + 500,
        text=text,
        created_at=STARTED,
    )


@pytest.mark.parametrize(
    ("offset_ms", "expected"),
    [
        (0, "00:00:00"),
        (999, "00:00:00"),
        (3_000, "00:00:03"),
        (59_999, "00:00:59"),
        (60_000, "00:01:00"),
        (3_599_999, "00:59:59"),
        (3_600_000, "01:00:00"),
        (5_025_000, "01:23:45"),
        (36_000_000, "10:00:00"),
        (360_000_000, "100:00:00"),
    ],
)
def test_format_offset(offset_ms: int, expected: str) -> None:
    assert format_offset(offset_ms) == expected


@pytest.mark.parametrize(
    ("speaker", "expected"),
    [("me", "Me"), ("them", "Them"), ("McKay", "McKay"), ("rahul", "Rahul"), ("", "")],
)
def test_speaker_label(speaker: str, expected: str) -> None:
    assert speaker_label(speaker) == expected


def test_render_matches_the_contract_format() -> None:
    transcript = TranscriptOut(
        meeting=meeting(segment_count=3),
        segments=[
            segment(3_000, "me", "Hi everyone, thanks for joining."),
            segment(7_000, "them", "Hi Rahul, good to see you."),
            segment(3_725_000, "me", "Let's wrap up."),
        ],
    )

    assert render_transcript(transcript) == (
        "Meeting: Weekly sync with Acme\n"
        "Meeting ID: 7f3c2d1e-0000-4000-8000-000000000001\n"
        "Started: 2026-10-05T10:00:00Z   Ended: 2026-10-05T10:31:12Z   Segments: 3\n"
        "\n"
        "[00:00:03] Me: Hi everyone, thanks for joining.\n"
        "[00:00:07] Them: Hi Rahul, good to see you.\n"
        "[01:02:05] Me: Let's wrap up."
    )


def test_render_a_meeting_still_recording_with_no_lines() -> None:
    text = render_transcript(TranscriptOut(meeting=meeting(ended_at=None), segments=[]))

    assert text.splitlines() == [
        "Meeting: Weekly sync with Acme",
        "Meeting ID: 7f3c2d1e-0000-4000-8000-000000000001",
        "Started: 2026-10-05T10:00:00Z   Ended: still recording   Segments: 0",
        "",
        "(No transcript lines yet.)",
    ]
