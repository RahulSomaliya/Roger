"""The fix size (M4-T12, `make eval-notes-fixes`): how much each meeting's AI notes changed since
the run that wrote them.

The exit check times the fixing with a stopwatch (M4 plan, "Done when"); this is the objective
number beside it. Both docs are rendered to Markdown (`notes_markdown.render_markdown`, chips as
their source times) and compared with `difflib`: lines and characters added and removed. A run's
own counts (dropped, flagged, from the notes) and cost come along, so one table fills the exit
check log's row.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import and_, func, select

from roger_api.auth import Principal
from roger_api.db.engine import Database
from roger_api.db.models import Meeting
from roger_api.db.models_notes import LlmRun, MeetingNote
from roger_api.schemas.common import UtcDatetime
from roger_api.services.notes_markdown import render_markdown
from roger_api.services.transcript_render import format_instant

FIXES_JSON = "fixes.json"
FIXES_MARKDOWN = "fixes.md"


class FixSize(BaseModel):
    meeting_id: UUID
    title: str
    started_at: UtcDatetime
    run_id: UUID
    model: str
    template_id: str | None
    # The AI notes were saved after the run wrote them (their version is past the run's).
    edited: bool
    lines_added: int
    lines_removed: int
    characters_added: int
    characters_removed: int
    dropped_count: int
    flagged_count: int
    from_notes_count: int
    # None when the vendor reported no usage, never 0.
    cost_usd: Decimal | None


class FixesReport(BaseModel):
    measured_at: UtcDatetime
    fixes: list[FixSize]


@dataclass(frozen=True, slots=True)
class EditSize:
    lines_added: int
    lines_removed: int
    characters_added: int
    characters_removed: int


def edit_size(generated: Mapping[str, object], current: Mapping[str, object]) -> EditSize:
    """What changed from the doc a run wrote to the doc as it is now, read as Markdown."""
    before, after = render_markdown(generated), render_markdown(current)
    lines_added, lines_removed = _changed(before.splitlines(), after.splitlines())
    characters_added, characters_removed = _changed(before, after)
    return EditSize(lines_added, lines_removed, characters_added, characters_removed)


def _changed(before: Sequence[str], after: Sequence[str]) -> tuple[int, int]:
    """(added, removed) items between two sequences, a replaced span counting on both sides.

    `autojunk=False`: by default difflib ignores items that fill over 1% of a sequence of 200 or
    more, and in a few thousand characters of notes that is every space and common letter, which
    would turn a one-word fix into a rewrite of the line.
    """
    added = removed = 0
    for tag, start, end, other_start, other_end in SequenceMatcher(
        None, before, after, autojunk=False
    ).get_opcodes():
        if tag in ("replace", "delete"):
            removed += end - start
        if tag in ("replace", "insert"):
            added += other_end - other_start
    return added, removed


async def measure_fixes(
    database: Database, principal: Principal, *, meeting_id: UUID | None = None, limit: int
) -> list[FixSize]:
    """The newest `limit` meetings of the workspace whose AI notes a run wrote, or just
    `meeting_id`: each with the edit size between that run's doc and the AI notes now."""
    workspace_id = principal.workspace_id
    query = (
        select(
            Meeting.id,
            Meeting.title,
            Meeting.started_at,
            MeetingNote.doc,
            MeetingNote.version,
            MeetingNote.generated_version,
            LlmRun.id,
            LlmRun.model,
            LlmRun.template_id,
            LlmRun.output_doc,
            # Counted in Postgres: the removed lines themselves are never read.
            func.coalesce(func.jsonb_array_length(LlmRun.dropped), 0),
            LlmRun.flagged_count,
            LlmRun.from_notes_count,
            LlmRun.cost_usd,
        )
        .join(
            MeetingNote,
            and_(
                MeetingNote.meeting_id == Meeting.id,
                MeetingNote.workspace_id == workspace_id,
                MeetingNote.kind == "ai",
            ),
        )
        # The run that last wrote the AI notes. A failed or cancelled run wrote no doc.
        .join(
            LlmRun, and_(LlmRun.id == MeetingNote.last_run_id, LlmRun.workspace_id == workspace_id)
        )
        .where(Meeting.workspace_id == workspace_id, LlmRun.output_doc.is_not(None))
        # Served by ix_meetings_workspace_id_started_at; the id only breaks ties.
        .order_by(Meeting.started_at.desc(), Meeting.id)
        .limit(limit)
    )
    if meeting_id is not None:
        query = query.where(Meeting.id == meeting_id)
    async with database.session() as session:
        rows = (await session.execute(query)).all()
    return [_fix_size(*row) for row in rows]


def _fix_size(
    meeting_id: UUID,
    title: str,
    started_at: datetime,
    current: dict[str, Any],
    version: int,
    generated_version: int | None,
    run_id: UUID,
    model: str,
    template_id: str | None,
    generated: dict[str, Any],
    dropped_count: int,
    flagged_count: int,
    from_notes_count: int,
    cost_usd: Decimal | None,
) -> FixSize:
    size = edit_size(generated, current)
    return FixSize(
        meeting_id=meeting_id,
        title=title,
        started_at=started_at,
        run_id=run_id,
        model=model,
        template_id=template_id,
        edited=version != generated_version,
        lines_added=size.lines_added,
        lines_removed=size.lines_removed,
        characters_added=size.characters_added,
        characters_removed=size.characters_removed,
        dropped_count=dropped_count,
        flagged_count=flagged_count,
        from_notes_count=from_notes_count,
        cost_usd=cost_usd,
    )


@dataclass(frozen=True, slots=True)
class FixesFiles:
    json: Path
    markdown: Path


def write_fixes(fixes: Sequence[FixSize], folder: Path) -> FixesFiles:
    folder.mkdir(parents=True, exist_ok=True)
    files = FixesFiles(json=folder / FIXES_JSON, markdown=folder / FIXES_MARKDOWN)
    report = FixesReport(measured_at=datetime.now(UTC), fixes=list(fixes))
    files.json.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    files.markdown.write_text(render_fixes(fixes), encoding="utf-8")
    return files


def render_fixes(fixes: Sequence[FixSize]) -> str:
    lines = [
        "# Notes fixes",
        "",
        "How much each meeting's AI notes changed since the run that wrote them (both docs as "
        "Markdown, compared with difflib). Write the edit size beside the stopwatch in the exit "
        "check log.",
        "",
    ]
    if not fixes:
        return "\n".join([*lines, "No meeting has AI notes written by a run yet.", ""])
    lines += [
        "| Meeting | Started | Template | Edited | Lines (+ / -) | Characters (+ / -) "
        "| Dropped | Flagged | From notes | Cost |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for fix in fixes:
        cells = [
            f"{_cell(fix.title)} ({str(fix.meeting_id)[:8]})",
            format_instant(fix.started_at),
            fix.template_id or "-",
            "yes" if fix.edited else "no",
            f"+{fix.lines_added} / -{fix.lines_removed}",
            f"+{fix.characters_added} / -{fix.characters_removed}",
            str(fix.dropped_count),
            str(fix.flagged_count),
            str(fix.from_notes_count),
            "unknown" if fix.cost_usd is None else f"${fix.cost_usd}",
        ]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join([*lines, ""])


def _cell(text: str) -> str:
    """A meeting title in a table cell: a `|` or a line break would end the cell or the row."""
    return " ".join(text.split()).replace("|", "\\|")
