"""Notes runs on the wire (M4-T8): the generate request, and runs as the history lists them.

The stream's events are built in `services/notes_generation.py`; docs/api-contract.md ("Notes runs
and streaming") lists both. The desktop reads these shapes in main/api/notesClient.ts (runs) and
main/notes/LlmStreams.ts (events), field by field: change the three together.
"""

from decimal import Decimal
from typing import Annotated, Any, Self
from uuid import UUID

from pydantic import AfterValidator, BaseModel

from roger_api.db.models_notes import LlmRun
from roger_api.domain import RunKind, RunStatus
from roger_api.note_templates import find_note_template
from roger_api.schemas.common import UtcDatetime
from roger_api.schemas.note_templates import NoteTemplate, TemplateId
from roger_api.schemas.notes import NoteVersion
from roger_api.services.citations import DropReason


def _a_known_template(template_id: str) -> str:
    if find_note_template(template_id) is None:
        raise ValueError(
            f"Unknown note template {template_id!r}; GET /v1/note-templates lists them"
        )
    return template_id


# Checked with the body, so an unknown id is a 422 before anything is claimed.
KnownTemplateId = Annotated[TemplateId, AfterValidator(_a_known_template)]


class NotesGenerate(BaseModel):
    """`POST /v1/meetings/{id}/notes/generate`."""

    # Made by the desktop before its first attempt: every retry re-sends it, and attaches to or
    # replays this run instead of paying for a second one.
    run_id: UUID
    template_id: KnownTemplateId
    # The stored versions the desktop flushed before asking (0 when that note does not exist).
    user_notes_version: NoteVersion
    ai_base_version: NoteVersion

    @property
    def template(self) -> NoteTemplate:
        template = find_note_template(self.template_id)
        if template is None:  # `KnownTemplateId` refused it already.
            raise LookupError(f"Note template {self.template_id!r} is not a built-in template")
        return template


class DroppedLineOut(BaseModel):
    """A line the API removed: it cited nothing (`no_refs`) or only refs that point nowhere."""

    text: str
    reason: DropReason


class LlmRunOut(BaseModel):
    """`LlmRun` in docs/api-contract.md: one notes or chat run, without its docs."""

    id: UUID
    meeting_id: UUID
    kind: RunKind
    status: RunStatus
    model: str
    prompt_version: str
    template_id: str | None
    line_count: int
    user_notes_version: int | None
    ai_base_version: int | None
    error_code: str | None
    error: str | None
    # Null until a run lists them: a run that failed never got that far.
    dropped: list[DroppedLineOut] | None
    flagged_count: int
    from_notes_count: int
    input_tokens: int | None
    output_tokens: int | None
    cached_tokens: int | None
    # A decimal string ("0.00083"), exact as Postgres `numeric` holds it. Null when the vendor sent
    # no usage, never 0: a 0 reads as a free run.
    cost_usd: Decimal | None
    started_at: UtcDatetime
    # The desktop polls a stream that ended without `done` or `error` until the run ends or this is
    # `llm_runs.STALE_AFTER` old (M4 plan, Streaming).
    heartbeat_at: UtcDatetime
    finished_at: UtcDatetime | None

    @classmethod
    def from_row(cls, run: LlmRun) -> Self:
        # Reads only the fields declared here: the history defers the docs with `raiseload`
        # (services/notes_generation.py), so a field added for them here would fail loudly there.
        return cls.model_validate(run, from_attributes=True)


class LlmRunDetail(LlmRunOut):
    """One run with the doc it wrote and the doc it replaced. Both keys are always sent, null when
    empty: the desktop refuses a run read without them (`runDocFromWire` in notesClient.ts)."""

    output_doc: dict[str, Any] | None
    # What "Restore previous notes" puts back; null for a first run.
    replaced_doc: dict[str, Any] | None


class LlmRunList(BaseModel):
    items: list[LlmRunOut]
