"""Notes generation (M4-T8): a meeting's AI notes, from its transcript and the user's own notes.

Three parts, top to bottom:

- `generate_notes`, the DB-free core the API and the eval (M4-T12) share. It builds the prompt from
  a meeting's sources (`notes_prompt.py`), streams the model, parses each finished line
  (`notes_protocol.py`), checks its citations (`citations.py`) and emits the run's events as each
  line is checked. `GeneratedNotes` is what it made. A meeting whose prompt is over the input
  budget (NOTES_MAX_INPUT_TOKENS) is written in windows, then merged (`notes_long.py`), through
  the same `NotesWriter` and `write_notes`.
- `build_ai_doc`, the AI doc builder: TipTap JSON with an inline `citation` node per chip and the
  closing "From your notes" list (M4 D7). The desktop's editor schema
  (apps/desktop/src/renderer/src/notes/citationNode.ts) reads the same shape, and
  tests/fixtures/ai_notes_doc.json pins both sides: `test_built_doc_matches_shared_fixture`
  rebuilds that file from this builder, and citationNode.test.ts checks it with `Node.fromJSON` and
  `doc.check()` (TipTap's `setContent` drops what its schema refuses without an error). Change the
  builder, the node and the fixture together.
- The persistence wrapper: `start_notes_run` claims a run for `POST .../notes/generate`, attaches
  to or replays a re-sent run id, and hands the run to the registry (`llm_runs.py`); the run's save
  writes the AI doc. Below it, the run history behind `GET .../runs`.

Traps:
- The prompt shows each note block as Markdown (`NoteBlock.markdown`: the user's headings and
  list structure say what matters to them), but every line is checked against the words alone
  (`NoteBlock.text`): an ordered item's "3." is not a number the user wrote. `citations.RefMap`
  holds plain strings, so `NotesSources` builds one map of each from the same blocks; both number
  them `N1..Nk` in the same order.
- Never hold a database transaction across a vendor call (CLAUDE.md failure log). The claim's
  session is closed before `runtime.start` opens the model stream, and the run's save gets a
  session of its own from the registry once the stream has ended.
- Model text can hold U+0000 or a lone surrogate, which Postgres refuses in `text` and `jsonb`
  with a 500. A run that kept them would fail at its save, after the vendor was paid: every piece
  is made storable as it arrives (`_storable_text`), so events, the doc, `output_text` and
  `dropped` never carry them.
"""

from collections.abc import AsyncGenerator, AsyncIterator, Callable, Iterable, Sequence
from contextlib import AbstractAsyncContextManager, aclosing
from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from roger_api.auth import Principal
from roger_api.db.engine import Database
from roger_api.db.models import TranscriptSegment
from roger_api.db.models_notes import LlmRun, MeetingNote
from roger_api.domain import RunKind
from roger_api.errors import ConflictError, EmptyMeetingError, NotFoundError
from roger_api.log import get_logger
from roger_api.schemas.note_templates import NoteTemplate
from roger_api.schemas.notes import NoteOut, note_doc_problem, storable_doc
from roger_api.services.citations import (
    CheckedLine,
    Citation,
    CitedLine,
    DroppedLine,
    FromNotesLine,
    RefMap,
    SourceLine,
    check_line,
)
from roger_api.services.llm_runs import (
    LiveRun,
    LlmRuntime,
    RunContext,
    RunEvent,
    RunSave,
    RunWork,
    claim_run,
)
from roger_api.services.meetings import require_meeting
from roger_api.services.notes import get_notes, lock_meeting
from roger_api.services.notes_markdown import (
    FROM_YOUR_NOTES_HEADING,
    NoteBlock,
    split_note_blocks,
)
from roger_api.services.notes_model import ModelEvent, ModelRequest, TextDelta, notes_request
from roger_api.services.notes_prompt import PROMPT_VERSION, NotesPrompt, build_notes_prompt
from roger_api.services.notes_protocol import Bullet, Heading, LineProtocolParser, ProtocolLine

# The transcript's one order (start, then "me" before "them", then id), so `L1..Ln` run as the
# transcript reads. Imported, never copied: two orders would number the prompt one way and show
# the transcript another.
from roger_api.services.segments import _TRANSCRIPT_ORDER

logger = get_logger(__name__)

type Json = dict[str, Any]
# How the core reaches the model: `NotesModel.stream`, or a run's metered `RunContext.stream`.
type ModelStream = Callable[[ModelRequest], AbstractAsyncContextManager[AsyncIterator[ModelEvent]]]
# Where the core sends each event: a run's `RunContext.emit`, or a list in the eval.
type Emit = Callable[[RunEvent], None]
# Keeps, moves to "From your notes" or drops one parsed bullet: `check_line` against the run's ref
# map, or, in a long call's passes, against the lines that pass was shown (`notes_long.py`).
type LineCheck = Callable[[Bullet], CheckedLine]

# The AI doc's names. `citation` is `CITATION_NODE_TYPE` in the desktop's shared/notes.ts, and its
# attrs are `CitationAttrs` there; `NOT_SAID_ON_THE_CALL` is the constant of the same name.
CITATION_NODE_TYPE = "citation"
NOT_SAID_ON_THE_CALL = "Not said on the call"
_SECTION_HEADING_LEVEL = 2
# TipTap's empty doc. ProseMirror's `doc` needs at least one block, so `{"content": []}` fails
# `doc.check()` in the editor (citationNode.ts).
_EMPTY_DOC_CONTENT: tuple[Json, ...] = ({"type": "paragraph"},)


# --- What a run reads and makes ----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class NotesSources:
    """What the notes are written from: the template, the transcript in order, the user's notes."""

    template: NoteTemplate
    lines: tuple[SourceLine, ...]
    note_blocks: tuple[NoteBlock, ...]

    @property
    def is_empty(self) -> bool:
        return not self.lines and not self.note_blocks

    def prompt(self) -> NotesPrompt:
        return build_notes_prompt(self.template, self.shown_refs())

    def shown_refs(self) -> RefMap:
        """The map a prompt numbers: the blocks as Markdown, as the user structured them (see the
        module's first trap)."""
        return RefMap(self.lines, tuple(block.markdown for block in self.note_blocks))

    def refs(self) -> RefMap:
        """The map every line is checked against: the blocks' words alone (first trap)."""
        return RefMap(self.lines, tuple(block.text for block in self.note_blocks))


@dataclass(frozen=True, slots=True)
class NotesSection:
    """One section of the AI notes, with the lines kept under it in the order written.

    `index` is the template section's position, or, for a heading the template does not have, a
    number after the template's: the `section` and `item` events name a section by it.
    """

    index: int
    heading: str
    lines: tuple[CitedLine, ...]


@dataclass(frozen=True, slots=True)
class GeneratedNotes:
    """What one notes generation made."""

    # The model's answer as it arrived (made storable): for the run row and the eval.
    output_text: str
    # In the order they first appeared, each with at least one line.
    sections: tuple[NotesSection, ...]
    # In the user's order (D7): by the first note block each one cites.
    from_notes: tuple[FromNotesLine, ...]
    # In the order written: the panel's "Removed lines".
    dropped: tuple[DroppedLine, ...]

    @property
    def flagged_count(self) -> int:
        return sum(line.support == "weak" for section in self.sections for line in section.lines)

    @property
    def from_notes_count(self) -> int:
        return len(self.from_notes)

    def doc(self) -> Json:
        return build_ai_doc(self.sections, self.from_notes)


# --- The DB-free core --------------------------------------------------------------------------


async def generate_notes(
    sources: NotesSources,
    stream: ModelStream,
    emit: Emit,
    *,
    max_input_tokens: int,
) -> GeneratedNotes:
    """Writes the notes for `sources` through `stream`, emitting `section`, `item`, `from_notes`
    and `dropped` events as each finished line is checked.

    The budget switch: one pass while the prompt is within `max_input_tokens`
    (NOTES_MAX_INPUT_TOKENS, estimated as characters / 4); over it, map then reduce
    (`notes_long.py`), where only the reduce's lines are emitted and returned. `_claim` asks
    `notes_long.plan_windows` the same question to store the run's prompt version, so the two
    always agree.

    `max_input_tokens` has no default, as `start_notes_run`'s has none: every caller passes its
    own settings' NOTES_MAX_INPUT_TOKENS (the route through `start_notes_run`, the eval from
    `get_settings()`). A default is one a caller forgets, and the setting is then ignored without
    a word: a 32,000-token model is sent one pass of up to 200,000 tokens, and the vendor's 400
    names no budget.

    Raises what the stream raises (`notes_model.py`): `LlmProviderError` when the vendor refuses
    or fails, `ModelCutOffError` when the answer stopped at its limit. Then nothing is returned,
    and a run keeps the AI notes it had.
    """
    # Imported here, not at the top: notes_long builds on this module (`NotesWriter`,
    # `write_notes`), so a top-level import is a cycle that fails with "partially initialized
    # module". `_claim` imports it the same way.
    from roger_api.services import notes_long

    windows = notes_long.plan_windows(sources, max_input_tokens)
    if windows:
        return await notes_long.generate_long_notes(sources, windows, stream, emit)
    refs = sources.refs()
    writer = NotesWriter(sources.template, lambda bullet: check_line(bullet, refs), emit)
    return await write_notes(notes_request(sources.prompt()), stream, writer)


class NotesWriter:
    """Files each parsed line under its section, "From your notes" or the removed lines, as `check`
    decides, and emits each one's event."""

    def __init__(self, template: NoteTemplate, check: LineCheck, emit: Emit) -> None:
        self._check = check
        self._emit = emit
        sections = template.sections
        # Headings by `_heading_key`: the template's first, then each one the model adds.
        self._headings = {
            _heading_key(section.heading): (index, section.heading)
            for index, section in enumerate(sections)
        }
        self._next_index = len(sections)
        # The rules tell the model to start with the template's first section: bullets written
        # before any heading belong there, never nowhere.
        self._current = (0, sections[0].heading)
        self._kept: dict[int, tuple[str, list[CitedLine]]] = {}
        self._from_notes: list[FromNotesLine] = []
        self._dropped: list[DroppedLine] = []

    def take(self, line: ProtocolLine) -> None:
        if isinstance(line, Heading):
            self._start_section(line.text)
            return
        match self._check(line):
            case CitedLine() as cited:
                self._keep(cited)
            case FromNotesLine() as moved:
                self._from_notes.append(moved)
                self._emit(RunEvent("from_notes", {"text": moved.text}))
            case DroppedLine() as dropped:
                self._dropped.append(dropped)
                self._emit(dropped_event(dropped))

    def result(self, output_text: str) -> GeneratedNotes:
        return GeneratedNotes(
            output_text=output_text,
            sections=tuple(
                NotesSection(index, heading, tuple(lines))
                for index, (heading, lines) in self._kept.items()
            ),
            # `sorted` is stable: lines citing the same first block keep the order written.
            from_notes=tuple(sorted(self._from_notes, key=_first_note_number)),
            dropped=tuple(self._dropped),
        )

    def _start_section(self, text: str) -> None:
        key = _heading_key(text)
        if key == _heading_key(FROM_YOUR_NOTES_HEADING):
            # The doc's closing list owns this heading, and `get_notes` splits the doc on its last
            # one (`notes_markdown.render_ai_notes`). Notes-only lines go there anyway; any other
            # line under it stays in the section before.
            return
        if key not in self._headings:
            # Not a template section. A bold preamble now parses as a heading ("**Here are your
            # notes:**", notes_protocol.py): with nothing under it, it leaves no trace, as a
            # section is written only with its first kept line. A section the model added keeps
            # its bullets together under its own heading, where the user can move them.
            self._headings[key] = (self._next_index, text)
            self._next_index += 1
        self._current = self._headings[key]

    def _keep(self, line: CitedLine) -> None:
        index, heading = self._current
        if index not in self._kept:
            self._kept[index] = (heading, [])
            self._emit(RunEvent("section", {"index": index, "heading": heading}))
        self._kept[index][1].append(line)
        self._emit(item_event(index, line))


async def write_notes(
    request: ModelRequest, stream: ModelStream, writer: NotesWriter
) -> GeneratedNotes:
    """Streams the answer to `request` into `writer`, one finished line at a time, and returns
    what `writer` filed, with the answer as `output_text`. Raises what the stream raises."""
    parser = LineProtocolParser()
    pieces: list[str] = []
    async with stream(request) as events:
        async for event in events:
            if not isinstance(event, TextDelta):
                continue
            text = _storable_text(event.text)
            pieces.append(text)
            for line in parser.feed(text):
                writer.take(line)
    for line in parser.finish():
        writer.take(line)
    return writer.result("".join(pieces))


def _heading_key(heading: str) -> str:
    """A heading as the model may vary it: case, spacing, a closing colon ("ACTION ITEMS:")."""
    return " ".join(heading.split()).rstrip(":").rstrip().casefold()


def _first_note_number(line: FromNotesLine) -> int:
    # `check_line` keeps only refs the map holds, so every one is `N<number>`.
    return min(int(ref.removeprefix("N")) for ref in line.note_refs)


def _storable_text(text: str) -> str:
    """`text` as Postgres stores it (see the module's last trap). The rule has one home,
    `schemas/notes.storable_doc`, which this asks about a doc of one string."""
    stored: str = storable_doc({"text": text})["text"]
    return stored


# --- Events ------------------------------------------------------------------------------------
# The `data` of each event in docs/api-contract.md ("Notes runs and streaming"), which the
# desktop's main/notes/LlmStreams.ts reads field by field.


def run_event(run_id: UUID, *, model: str, template_id: str, line_count: int) -> RunEvent:
    return RunEvent(
        "run",
        {
            "run_id": str(run_id),
            "model": model,
            "template_id": template_id,
            "line_count": line_count,
        },
    )


def item_event(section: int, line: CitedLine) -> RunEvent:
    return RunEvent(
        "item",
        {
            "section": section,
            "text": line.text,
            "citations": [
                {"ref": cited.ref, "segment_id": str(cited.segment_id), "start_ms": cited.start_ms}
                for cited in line.citations
            ],
            "support": line.support,
        },
    )


def dropped_event(line: DroppedLine) -> RunEvent:
    return RunEvent("dropped", _dropped_json(line))


def done_event(run_id: UUID, note: MeetingNote) -> RunEvent:
    return RunEvent(
        "done", {"run_id": str(run_id), "note": NoteOut.from_row(note).model_dump(mode="json")}
    )


def _dropped_json(line: DroppedLine) -> Json:
    """As the `dropped` event and `llm_runs.dropped` both hold it."""
    return {"text": line.text, "reason": line.reason}


# --- The AI doc --------------------------------------------------------------------------------


def build_ai_doc(sections: Sequence[NotesSection], from_notes: Sequence[FromNotesLine]) -> Json:
    """The AI notes as TipTap JSON (see the module docstring for the three files this pins).

    Each section is a level-2 heading and a bullet list. StarterKit's `listItem` holds `paragraph
    block*`, so every bullet is a list item that starts with a paragraph: the line's text, then a
    `citation` chip per run of neighbouring transcript lines it cites. Only the attrs the editor's
    node declares are written, and nothing else: `citationNode.test.ts` compares the fixture with
    what the editor's `toJSON` gives back. Lines only the user's notes back close the doc under
    "From your notes", a muted "Not said on the call" line and a plain list (M4 D7, option a).
    """
    content: list[Json] = []
    for section in sections:
        content.append(_heading(section.heading))
        content.append(_bullet_list(_cited_paragraph(line) for line in section.lines))
    if from_notes:
        content.append(_heading(FROM_YOUR_NOTES_HEADING))
        content.append(_paragraph([_text(NOT_SAID_ON_THE_CALL, marks=[{"type": "italic"}])]))
        content.append(_bullet_list(_paragraph([_text(line.text)]) for line in from_notes))
    return {"type": "doc", "content": content or list(_EMPTY_DOC_CONTENT)}


def chip_label(start_ms: int) -> str:
    """The time a chip shows: "03:12", or "1:02:05" past an hour (`CitationAttrs.label`)."""
    hours, remainder = divmod(start_ms // 1000, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def _cited_paragraph(line: CitedLine) -> Json:
    # The space keeps the words apart from the chip, as the editor shows them and as
    # `notes_markdown.py` renders the chip's time after them.
    chips = [_chip(group, line) for group in _neighbours(line.citations)]
    return _paragraph([_text(f"{line.text} "), *chips])


def _neighbours(citations: Sequence[Citation]) -> list[list[Citation]]:
    """`citations` (in transcript order) cut into runs of neighbouring lines: `L12, L13, L15` is
    one chip for 12 and 13, then one for 15. A chip reveals all its lines at once, so a run of
    lines reads as one source instead of a row of chips a few seconds apart."""
    runs: list[list[Citation]] = []
    previous: int | None = None
    for citation in citations:
        number = int(citation.ref.removeprefix("L"))
        if runs and previous is not None and number == previous + 1:
            runs[-1].append(citation)
        else:
            runs.append([citation])
        previous = number
    return runs


def _chip(citations: Sequence[Citation], line: CitedLine) -> Json:
    first = citations[0]
    return {
        "type": CITATION_NODE_TYPE,
        "attrs": {
            "segmentIds": [str(citation.segment_id) for citation in citations],
            # Kept so M12 can re-point a chip by time once the second pass replaces the segments.
            "startMs": first.start_ms,
            "label": chip_label(first.start_ms),
            "support": line.support,
        },
    }


def _heading(text: str) -> Json:
    return {
        "type": "heading",
        "attrs": {"level": _SECTION_HEADING_LEVEL},
        "content": [_text(text)],
    }


def _bullet_list(paragraphs: Iterable[Json]) -> Json:
    return {
        "type": "bulletList",
        "content": [{"type": "listItem", "content": [paragraph]} for paragraph in paragraphs],
    }


def _paragraph(content: list[Json]) -> Json:
    return {"type": "paragraph", "content": content}


def _text(text: str, *, marks: list[Json] | None = None) -> Json:
    node: Json = {"type": "text", "text": text}
    if marks:
        node["marks"] = marks
    return node


# --- The run: claim, re-send, save -------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class NotesRunStream:
    """What `POST .../notes/generate` streams: events read from the run's row, then, for a run this
    process drives, every event it has buffered and each new one until its last.

    A stream that ends with neither `done` nor `error` tells the desktop to poll the run (M4 plan,
    Streaming): a running run that no one here drives sends only its `run` event.
    """

    replayed: tuple[RunEvent, ...]
    live: LiveRun | None

    async def events(self) -> AsyncGenerator[RunEvent, None]:
        for event in self.replayed:
            yield event
        if self.live is not None:
            # A client that leaves closes this generator, and with it only its subscription: the
            # run finishes and saves without anyone listening.
            async with aclosing(self.live.subscribe()) as live:
                async for event in live:
                    yield event


async def start_notes_run(
    database: Database,
    runtime: LlmRuntime,
    principal: Principal,
    meeting_id: UUID,
    *,
    run_id: UUID,
    template: NoteTemplate,
    user_notes_version: int,
    ai_base_version: int,
    max_input_tokens: int,
) -> NotesRunStream:
    """Claims notes run `run_id` and starts it, or answers a re-send of it.

    `max_input_tokens` is NOTES_MAX_INPUT_TOKENS: over it, the run maps then reduces
    (`generate_notes`).

    Everything that can refuse the request is checked here, before the route's SSE `200`: after
    it, a refusal could only be an `error` event. Raises `NotFoundError` for a meeting outside the
    caller's workspace; `ConflictError` for a run id stored under another meeting or workspace, a
    version that is not the stored one, or a notes run of the meeting already running;
    `EmptyMeetingError` for a meeting with no lines and no notes; `LlmProviderError` when the vendor
    refuses before its stream opens (the run is stored failed by then, so a re-send replays that).

    A re-sent `run_id` is matched by id alone, before any other check: while the run runs here,
    the stream attaches to it; once it ended, the stored result is replayed.
    """
    async with database.session() as session:
        # First, as every AI-doc save does (services/notes.py): a save lands wholly before this
        # claim, which then sees its version, or wholly after it, and sees the running run (409).
        await lock_meeting(session, principal, meeting_id)
        resent = await _resent(session, runtime, principal, meeting_id, run_id)
        if resent is not None:
            await session.commit()
            return resent
        sources, run = await _claim(
            session,
            runtime,
            principal,
            meeting_id,
            run_id=run_id,
            template=template,
            user_notes_version=user_notes_version,
            ai_base_version=ai_base_version,
            max_input_tokens=max_input_tokens,
        )
        await session.commit()
    logger.info(
        "notes_run_claimed",
        run_id=str(run_id),
        meeting_id=str(meeting_id),
        template_id=template.id,
        line_count=len(sources.lines),
        note_block_count=len(sources.note_blocks),
    )
    # Outside the session: the claim's transaction is over before the vendor is called (traps).
    live = await runtime.start(run, _notes_work(principal, run, sources, max_input_tokens))
    return NotesRunStream(replayed=(), live=live)


async def _resent(
    session: AsyncSession,
    runtime: LlmRuntime,
    principal: Principal,
    meeting_id: UUID,
    run_id: UUID,
) -> NotesRunStream | None:
    """The stream for a run id already stored, or None for a new one."""
    # By id alone: run ids are global primary keys, so a re-send must be told apart from an id
    # another meeting or workspace holds. Only the owner columns are read. This read misses a claim
    # of the same id for another meeting that has not committed yet (only this meeting is locked):
    # `_claim` answers that one at its insert.
    owner = (
        await session.execute(
            select(LlmRun.workspace_id, LlmRun.meeting_id, LlmRun.kind).where(LlmRun.id == run_id)
        )
    ).one_or_none()
    if owner is None:
        return None
    if tuple(owner) != (principal.workspace_id, meeting_id, "notes"):
        raise _stored_elsewhere(run_id)
    live = runtime.find(principal.workspace_id, run_id)
    if live is not None:
        logger.info("notes_run_resent", run_id=str(run_id), attached=True)
        return NotesRunStream(replayed=(), live=live)
    # Read after `find`, so a run that ended between the two is read as ended. One still running
    # here would wait for this transaction's meeting lock to save, so `find` still held it.
    run = await session.scalar(
        select(LlmRun)
        .where(LlmRun.id == run_id, LlmRun.workspace_id == principal.workspace_id)
        .options(*_SUMMARY_ONLY)
    )
    if run is None:  # Deleted with its meeting since the read above; the lock rules that out.
        raise NotFoundError(f"Run {run_id} not found")
    logger.info("notes_run_resent", run_id=str(run_id), attached=False, status=run.status)
    return NotesRunStream(replayed=await _replay(session, principal, run), live=None)


async def _replay(session: AsyncSession, principal: Principal, run: LlmRun) -> tuple[RunEvent, ...]:
    """A run no process here drives, as its row tells it: `run`, then its ending.

    Running (claimed by a request that has not started it yet, driven by another API process, or
    dead and not yet swept): `run` only, and the desktop polls the run until it ends or its
    heartbeat is `llm_runs.STALE_AFTER` old. Succeeded: its removed lines, then `done` with the AI
    notes as stored now, so the desktop never keeps an older doc than Postgres. Otherwise: the
    stored error.
    """
    if run.template_id is None:  # Every notes run claim stores its template.
        raise ValueError(f"Notes run {run.id} has no template_id")
    started = run_event(
        run.id, model=run.model, template_id=run.template_id, line_count=run.line_count
    )
    if run.status == "running":
        return (started,)
    if run.status != "succeeded":
        # As stored: the registry wrote both (`llm_runs.error_event`).
        error = {
            "code": run.error_code or "internal_error",
            "message": run.error or "The run did not finish. Try again.",
        }
        return (started, RunEvent("error", error))
    note = await _ai_note(session, principal, run.meeting_id)
    if note is None:  # A succeeded notes run wrote the AI note, and nothing deletes one.
        raise ValueError(
            f"Notes run {run.id} succeeded but meeting {run.meeting_id} has no AI note"
        )
    dropped = tuple(RunEvent("dropped", line) for line in run.dropped or [])
    return (started, *dropped, done_event(run.id, note))


# llm_runs' primary key, as db/base.py's naming convention names it. Keep it in step with that
# convention: a wrong name turns `_claim`'s 409 back into a 500, which
# test_run_id_claimed_for_another_meeting_at_the_same_moment_is_a_conflict catches.
_RUN_ID_KEY = "pk_llm_runs"


async def _claim(
    session: AsyncSession,
    runtime: LlmRuntime,
    principal: Principal,
    meeting_id: UUID,
    *,
    run_id: UUID,
    template: NoteTemplate,
    user_notes_version: int,
    ai_base_version: int,
    max_input_tokens: int,
) -> tuple[NotesSources, LlmRun]:
    """Checks the request against what is stored and inserts the running run; does not commit."""
    # Imported here, as in `generate_notes` (a top-level import is a cycle).
    from roger_api.services.notes_long import LONG_PROMPT_VERSION, plan_windows

    notes = await get_notes(session, principal, meeting_id)
    _require_version("user", notes.user, user_notes_version, meeting_id)
    _require_version("ai", notes.ai, ai_base_version, meeting_id)
    sources = NotesSources(
        template=template,
        lines=await _source_lines(session, principal, meeting_id),
        note_blocks=split_note_blocks(notes.user.doc) if notes.user else (),
    )
    if sources.is_empty:
        raise EmptyMeetingError(
            f"Meeting {meeting_id} has no transcript lines and no notes to write notes from"
        )
    run = LlmRun(
        id=run_id,
        workspace_id=principal.workspace_id,
        meeting_id=meeting_id,
        kind="notes",
        status="running",
        model=runtime.notes_model.model_id("notes"),
        # The question `generate_notes` asks of the same sources, so the version names the prompts
        # the run sends: a long run's are not PROMPT_VERSION's.
        prompt_version=(
            LONG_PROMPT_VERSION if plan_windows(sources, max_input_tokens) else PROMPT_VERSION
        ),
        template_id=template.id,
        line_count=len(sources.lines),
        user_notes_version=user_notes_version,
        ai_base_version=ai_base_version,
        ref_map=sources.refs().to_json(),
    )
    try:
        # Fails the meeting's dead runs first; a live notes run of the meeting is a ConflictError.
        await claim_run(session, run)
    except IntegrityError as error:
        # The id was claimed for another meeting (or by a chat run) after `_resent` read it: that
        # read holds only this meeting's lock, so this insert waited on the other row and failed
        # once it committed. `claim_run` re-raises it, and unanswered it is a 500 (contract: 409).
        if _RUN_ID_KEY not in str(error.orig):
            raise
        raise _stored_elsewhere(run_id) from error
    return sources, run


def _stored_elsewhere(run_id: UUID) -> ConflictError:
    # Says nothing about that run beyond the conflict (as `segments._any_stored_elsewhere`).
    return ConflictError(f"Run {run_id} is stored under another meeting; nothing was replayed")


def _require_version(kind: str, note: MeetingNote | None, version: int, meeting_id: UUID) -> None:
    stored = 0 if note is None else note.version
    if version != stored:
        # The desktop flushes its notes and retries once (M4 plan, "Generate inputs").
        raise ConflictError(
            f"The {kind} notes of meeting {meeting_id} are at version {stored}; "
            f"this run was asked to build on version {version}"
        )


async def _source_lines(
    session: AsyncSession, principal: Principal, meeting_id: UUID
) -> tuple[SourceLine, ...]:
    # Never `words`: per-word timings are most of a row and the prompt shows none of them.
    rows = await session.execute(
        select(
            TranscriptSegment.id,
            TranscriptSegment.start_ms,
            TranscriptSegment.speaker,
            TranscriptSegment.text,
        )
        .where(
            TranscriptSegment.meeting_id == meeting_id,
            TranscriptSegment.workspace_id == principal.workspace_id,
        )
        .order_by(*_TRANSCRIPT_ORDER)
    )
    return tuple(
        SourceLine(segment_id=segment_id, start_ms=start_ms, speaker=speaker, text=text)
        for segment_id, start_ms, speaker, text in rows
    )


def _notes_work(
    principal: Principal, run: LlmRun, sources: NotesSources, max_input_tokens: int
) -> RunWork:
    run_id, model, template_id = run.id, run.model, sources.template.id
    meeting_id = run.meeting_id

    async def work(context: RunContext) -> RunSave:
        context.emit(
            run_event(run_id, model=model, template_id=template_id, line_count=len(sources.lines))
        )
        notes = await generate_notes(
            sources, context.stream, context.emit, max_input_tokens=max_input_tokens
        )
        return _ai_notes_save(principal, meeting_id, run_id, template_id, notes)

    return work


def _ai_notes_save(
    principal: Principal,
    meeting_id: UUID,
    run_id: UUID,
    template_id: str,
    notes: GeneratedNotes,
) -> RunSave:
    built = notes.doc()
    problem = note_doc_problem(built)
    if problem is not None:
        # A doc the desktop refuses (`noteDocProblem`, shared/notes.ts) would sit unsynced on the
        # Mac and be re-sent forever. The reason names the rule, never the notes' text.
        raise ValueError(f"The AI notes doc built by run {run_id} is {problem}")
    doc = storable_doc(built)

    async def save(session: AsyncSession) -> list[RunEvent]:
        # The meeting lock, as every AI-doc write takes it (services/notes.py), and the doc this
        # replaces read under it, as it is the moment the new doc is written: "Restore previous
        # notes" puts back what the user last saw, never an older doc.
        await lock_meeting(session, principal, meeting_id)
        note = await _ai_note(session, principal, meeting_id)
        replaced = None if note is None else note.doc
        if note is None:
            note = MeetingNote(
                id=uuid4(),
                workspace_id=principal.workspace_id,
                meeting_id=meeting_id,
                kind="ai",
                doc=doc,
                version=1,
            )
            session.add(note)
        else:
            note.doc = doc
            note.version += 1
        # NOT NULL; the run id marks the write, so no client save is ever taken as a re-send of it.
        note.last_revision_id = run_id
        note.template_id = template_id
        note.last_run_id = run_id
        note.generated_version = note.version
        await session.execute(
            update(LlmRun)
            .where(LlmRun.id == run_id, LlmRun.workspace_id == principal.workspace_id)
            .values(
                output_text=notes.output_text,
                output_doc=doc,
                replaced_doc=replaced,
                dropped=[_dropped_json(line) for line in notes.dropped],
                flagged_count=notes.flagged_count,
                from_notes_count=notes.from_notes_count,
            )
        )
        await session.flush()
        # Postgres sets updated_at; the `done` event's note carries it.
        await session.refresh(note, ["updated_at"])
        return [done_event(run_id, note)]

    return save


async def _ai_note(
    session: AsyncSession, principal: Principal, meeting_id: UUID
) -> MeetingNote | None:
    note: MeetingNote | None = await session.scalar(
        select(MeetingNote).where(
            MeetingNote.meeting_id == meeting_id,
            MeetingNote.workspace_id == principal.workspace_id,
            MeetingNote.kind == "ai",
        )
    )
    return note


# --- Run history -------------------------------------------------------------------------------

# The prompt's inputs and raw answer: large, and no route sends them. `raiseload`, so reading one
# by mistake fails loudly instead of as a lazy load the async session refuses.
_WITHOUT_SOURCES = (
    defer(LlmRun.ref_map, raiseload=True),
    defer(LlmRun.output_text, raiseload=True),
)
# What the history lists: no docs either.
_SUMMARY_ONLY = (
    *_WITHOUT_SOURCES,
    defer(LlmRun.output_doc, raiseload=True),
    defer(LlmRun.replaced_doc, raiseload=True),
)


async def list_runs(
    session: AsyncSession,
    principal: Principal,
    meeting_id: UUID,
    *,
    kind: RunKind | None,
    limit: int,
) -> Sequence[LlmRun]:
    """The meeting's runs, newest first, without their docs. Raises `NotFoundError`."""
    await require_meeting(session, principal, meeting_id)
    query = select(LlmRun).where(
        LlmRun.meeting_id == meeting_id, LlmRun.workspace_id == principal.workspace_id
    )
    if kind is not None:
        query = query.where(LlmRun.kind == kind)
    # Served by the (meeting_id, started_at desc) index; the id only breaks ties.
    rows = await session.scalars(
        query.options(*_SUMMARY_ONLY)
        .order_by(LlmRun.started_at.desc(), LlmRun.id.desc())
        .limit(limit)
    )
    return rows.all()


async def get_run(
    session: AsyncSession, principal: Principal, meeting_id: UUID, run_id: UUID
) -> LlmRun:
    """One run of the meeting with the doc it wrote and the doc it replaced.

    Raises `NotFoundError` for an unknown meeting or run, or one of another meeting or workspace.
    """
    return await _require_run(session, principal, meeting_id, run_id, _WITHOUT_SOURCES)


async def cancel_run(
    database: Database, runtime: LlmRuntime, principal: Principal, meeting_id: UUID, run_id: UUID
) -> LlmRun:
    """Stops a notes or chat run of the meeting and returns it as it ended (without docs): marked
    `cancelled`, or as it was when it had already finished. Raises `NotFoundError` as `get_run`.
    """
    # Short sessions on either side: `runtime.cancel` waits for the run to write its ending, and
    # an open transaction here would sit idle all that time.
    async with database.session() as session:
        await _require_run(session, principal, meeting_id, run_id, _SUMMARY_ONLY)
    await runtime.cancel(principal.workspace_id, run_id)
    async with database.session() as session:
        return await _require_run(session, principal, meeting_id, run_id, _SUMMARY_ONLY)


async def _require_run(
    session: AsyncSession,
    principal: Principal,
    meeting_id: UUID,
    run_id: UUID,
    options: Sequence[Any],
) -> LlmRun:
    run = await session.scalar(
        select(LlmRun)
        .where(
            LlmRun.id == run_id,
            LlmRun.meeting_id == meeting_id,
            LlmRun.workspace_id == principal.workspace_id,
        )
        .options(*options)
    )
    if run is None:
        raise NotFoundError(f"Run {run_id} not found in meeting {meeting_id}")
    return run
