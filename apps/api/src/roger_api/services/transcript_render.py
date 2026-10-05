"""Plain-text transcript for MCP clients: a header, then `[hh:mm:ss] Speaker: text` lines."""

from datetime import UTC, datetime

from roger_api.services.records import TranscriptLines

NO_LINES_YET = "(No transcript lines yet.)"


def format_offset(offset_ms: int) -> str:
    """`hh:mm:ss` for a millisecond offset; hours keep counting past 99."""
    hours, remainder = divmod(offset_ms // 1000, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def format_instant(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def speaker_label(speaker: str) -> str:
    """`me` -> `Me`. Only the first letter changes, so names like `McKay` survive."""
    return speaker[:1].upper() + speaker[1:]


def render_transcript(transcript: TranscriptLines) -> str:
    meeting = transcript.meeting.meeting
    ended = format_instant(meeting.ended_at) if meeting.ended_at else "still recording"
    header = [
        f"Meeting: {meeting.title}",
        f"Meeting ID: {meeting.id}",
        f"Started: {format_instant(meeting.started_at)}   Ended: {ended}   "
        f"Segments: {len(transcript.lines)}",
        "",
    ]
    lines = [
        f"[{format_offset(line.start_ms)}] {speaker_label(line.speaker)}: {line.text}"
        for line in transcript.lines
    ]
    return "\n".join([*header, *(lines or [NO_LINES_YET])])
