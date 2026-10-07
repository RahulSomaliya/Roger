"""Notes eval cases (M4-T12): one call as JSON, and what a person expects its notes to hold.

A case holds what notes are written from (a template, the transcript lines in transcript order and
the user's notes as the TipTap doc the desktop saved) and hand labels: the action items the call
agreed, with their owners, and the facts the notes must carry. The synthetic cases in
`apps/api/evals/notes/cases/` are committed; `export` writes cases from real calls into
`cases/local/`, which .gitignore keeps out of the repo because they are client conversations.

A case's id is its path under the cases folder without `.json` ("synthetic_standup",
"local/<meeting id>"), so two cases never share one.
"""

import re
from collections.abc import Collection
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Self
from uuid import UUID, uuid5

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator, model_validator

from roger_api.auth import Principal
from roger_api.db.engine import Database
from roger_api.note_templates import builtin_note_templates, find_note_template
from roger_api.schemas.common import NonEmptyText, OffsetMs
from roger_api.schemas.note_templates import TemplateId
from roger_api.schemas.notes import NoteDoc
from roger_api.services.citations import SourceLine
from roger_api.services.notes import get_notes
from roger_api.services.notes_generation import NotesSources
from roger_api.services.notes_markdown import NoteBlock, split_note_blocks
from roger_api.services.segments import get_transcript_lines

# An owner tool run from the source tree (`make eval-notes` runs in apps/api), so the folder is
# found from this file, as config.REPO_ROOT_ENV_FILE finds the repo root: apps/api/evals/notes.
EVALS_ROOT = Path(__file__).resolve().parents[3] / "evals" / "notes"
CASES_ROOT = EVALS_ROOT / "cases"
# Git-ignored (the root .gitignore, tests/test_repo_tooling.py): exported client calls.
LOCAL_CASES = "local"

_CASE_SUFFIX = ".json"
# Case ids go into the report's tables and headings as they are: a `|` would break a table row.
_CASE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
# The segment ids a case's lines get. Made from the case id and the line number, so one case gives
# the same ref map, chips and doc on every run.
_SEGMENT_NAMESPACE = UUID("5f0c1d36-8f6e-4a43-9a1e-3c1b7c2d9e41")

# Frozen and strict: a misspelt key in a hand-written case ("action_item") fails the load instead
# of dropping the labels and scoring the case against none.
_CASE_CONFIG = ConfigDict(frozen=True, extra="forbid")


class CaseError(ValueError):
    """A case that cannot be loaded, exported or found. The message names the file or meeting."""


class CaseLine(BaseModel):
    model_config = _CASE_CONFIG

    # As the transcript stores it: "me" or "them".
    speaker: NonEmptyText
    start_ms: OffsetMs
    text: NonEmptyText


class ActionItemLabel(BaseModel):
    model_config = _CASE_CONFIG

    # Who the call said would do it: "Me", "Them" or a name spoken on the call.
    owner: NonEmptyText
    # What, by when, in the labeller's words: found by its words and numbers, not as written
    # (notes_score.py).
    text: NonEmptyText


class CaseLabels(BaseModel):
    model_config = _CASE_CONFIG

    action_items: tuple[ActionItemLabel, ...] = ()
    # Short statements the notes must carry ("the pilot stays at 50k").
    facts: tuple[NonEmptyText, ...] = ()


class NotesCase(BaseModel):
    model_config = _CASE_CONFIG

    schema_version: Literal[1]
    title: NonEmptyText
    template_id: TemplateId
    # In transcript order: `L1..Ln` are numbered as written here.
    lines: tuple[CaseLine, ...]
    # The user's notes as the desktop saves them (`meeting_notes.doc`); None when they took none.
    user_notes: NoteDoc | None = None
    labels: CaseLabels = CaseLabels()
    # The meeting an exported case came from; None for a synthetic case.
    meeting_id: UUID | None = None

    @field_validator("template_id")
    @classmethod
    def _template_exists(cls, template_id: str) -> str:
        if find_note_template(template_id) is None:
            known = ", ".join(template.id for template in builtin_note_templates())
            raise ValueError(f"no note template {template_id!r} (the templates are {known})")
        return template_id

    @model_validator(mode="after")
    def _has_sources_in_order(self) -> Self:
        # As `POST .../notes/generate` refuses one with `empty_meeting`: nothing to write from.
        if not self.lines and not self.note_blocks():
            raise ValueError("the case has no transcript lines and no notes to write notes from")
        starts = [line.start_ms for line in self.lines]
        if starts != sorted(starts):
            raise ValueError("lines must be in transcript order (start_ms never goes back)")
        return self

    def note_blocks(self) -> tuple[NoteBlock, ...]:
        """The user's notes as the API numbers them for a run (`N1..Nk`)."""
        return () if self.user_notes is None else split_note_blocks(self.user_notes)


@dataclass(frozen=True, slots=True)
class EvalCase:
    id: str
    case: NotesCase

    def sources(self) -> NotesSources:
        """The case as a notes run reads a meeting (`notes_generation._claim`)."""
        template = find_note_template(self.case.template_id)
        if template is None:  # `NotesCase` checked it, and the templates are built in.
            raise CaseError(f"Case {self.id} names no known template")
        return NotesSources(
            template=template,
            lines=tuple(
                SourceLine(
                    segment_id=uuid5(_SEGMENT_NAMESPACE, f"{self.id}/L{number}"),
                    start_ms=line.start_ms,
                    speaker=line.speaker,
                    text=line.text,
                )
                for number, line in enumerate(self.case.lines, start=1)
            ),
            note_blocks=self.case.note_blocks(),
        )


def load_cases(root: Path, *, only: Collection[str] = ()) -> tuple[EvalCase, ...]:
    """The cases in `root` and `root/local`, ordered by id; with `only`, just those ids.

    Raises `CaseError` for a file that does not load (naming it and what is wrong), an id in
    `only` that is not there, or a folder with no case. Files not named in `only` are not read, so
    one half-labelled local case never stops a run of the others.
    """
    paths = sorted([*root.glob(f"*{_CASE_SUFFIX}"), *(root / LOCAL_CASES).glob(f"*{_CASE_SUFFIX}")])
    cases: dict[str, EvalCase] = {}
    for path in paths:
        case_id = path.relative_to(root).with_suffix("").as_posix()
        if path.is_file() and (not only or case_id in only):
            cases[case_id] = _load(path, case_id)
    missing = sorted(set(only) - set(cases))
    if missing:
        raise CaseError(f"No case {', '.join(missing)} in {root}")
    if not cases:
        raise CaseError(f"No cases (*{_CASE_SUFFIX}) in {root} or {root / LOCAL_CASES}")
    return tuple(cases[case_id] for case_id in sorted(cases))


def _load(path: Path, case_id: str) -> EvalCase:
    if not _CASE_NAME.fullmatch(path.stem):
        raise CaseError(
            f"Case file {path} has a name the report cannot show; use letters, digits, '.', '-' "
            "and '_'"
        )
    try:
        case = NotesCase.model_validate_json(path.read_bytes())
    except ValidationError as error:
        raise CaseError(f"Case {path} is invalid: {_problems(error)}") from error
    return EvalCase(id=case_id, case=case)


def _problems(error: ValidationError) -> str:
    # Never `str(error)`: it quotes the input, and a local case is a client call.
    return "; ".join(
        f"{'.'.join(str(part) for part in problem['loc']) or 'case'}: {problem['msg']}"
        for problem in error.errors(include_url=False, include_input=False, include_context=False)
    )


# --- Export from Postgres ----------------------------------------------------------------------


def export_path(root: Path, meeting_id: UUID) -> Path:
    """Where `export` writes a meeting's case: under the git-ignored `local/` folder."""
    return root / LOCAL_CASES / f"{meeting_id}{_CASE_SUFFIX}"


async def export_case(
    database: Database, principal: Principal, meeting_id: UUID, *, template_id: str | None
) -> NotesCase:
    """The meeting as a case with no labels yet: its transcript, the user's notes, a template.

    The template is `template_id`, else the one its AI notes were last written with. Raises
    `NotFoundError` for a meeting outside the principal's workspace, and `CaseError` when no
    template is named or stored, or the meeting does not make a case (no lines and no notes).
    """
    async with database.session() as session:
        transcript = await get_transcript_lines(session, principal, meeting_id)
        notes = await get_notes(session, principal, meeting_id)
    chosen = template_id or (notes.ai.template_id if notes.ai is not None else None)
    if chosen is None:
        raise CaseError(
            f"Meeting {meeting_id} has no AI notes to take a template from; pass --template "
            f"({', '.join(template.id for template in builtin_note_templates())})"
        )
    try:
        return NotesCase(
            schema_version=1,
            title=transcript.meeting.meeting.title,
            template_id=chosen,
            lines=tuple(
                CaseLine(speaker=line.speaker, start_ms=line.start_ms, text=line.text)
                for line in transcript.lines
            ),
            user_notes=None if notes.user is None else notes.user.doc,
            meeting_id=meeting_id,
        )
    except ValidationError as error:
        raise CaseError(f"Meeting {meeting_id} does not make a case: {_problems(error)}") from error


def write_case(case: NotesCase, path: Path, *, overwrite: bool) -> None:
    """Writes `case` as indented JSON.

    Refuses to replace a file unless `overwrite` (FileExistsError): an exported case is labelled
    by hand afterwards, and exporting the meeting again would erase the labels.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w" if overwrite else "x", encoding="utf-8") as file:
        file.write(case.model_dump_json(indent=2) + "\n")
