"""Notes generation (services/notes_generation.py): the DB-free core, the AI doc builder and the
run's save, driven at the service level.

The routes are tested in test_notes_runs_api.py. These start runs on the registry directly with
`ScriptedNotesModel`, which holds a run mid-answer on an `asyncio.Event`, because
`httpx.ASGITransport` buffers whole responses (M4 plan, Traps).

`test_built_doc_matches_shared_fixture` pins tests/fixtures/ai_notes_doc.json, the one file the
desktop's editor schema test (citationNode.test.ts) and shared/notes.test.ts read too. After a
deliberate change to the builder, rebuild the file with
`REGENERATE_AI_NOTES_FIXTURE=1 uv run --frozen pytest tests/test_notes_generation.py` and run the
desktop tests (`make check`) against it.
"""

import asyncio
import json
import os
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import aclosing, asynccontextmanager
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select

from roger_api.auth import Principal
from roger_api.config_notes import NotesSettings
from roger_api.db.engine import Database
from roger_api.db.models import Meeting, TranscriptSegment, Workspace
from roger_api.db.models_notes import LlmRun, MeetingNote
from roger_api.note_templates import find_note_template
from roger_api.schemas.note_templates import NoteTemplate, NoteTemplateSection
from roger_api.schemas.notes import note_doc_problem
from roger_api.services.citations import SourceLine
from roger_api.services.llm_runs import LlmRuntime, RunEvent
from roger_api.services.notes_generation import (
    NOT_SAID_ON_THE_CALL,
    GeneratedNotes,
    NotesSources,
    chip_label,
    generate_notes,
    start_notes_run,
)
from roger_api.services.notes_markdown import FROM_YOUR_NOTES_HEADING, NoteBlock
from roger_api.services.notes_model import (
    ModelCutOffError,
    ModelDone,
    ModelUsage,
)
from roger_api.services.notes_model_fake import ModelScript, ScriptedNotesModel

FIXTURE = Path(__file__).parent / "fixtures" / "ai_notes_doc.json"
REGENERATE_FIXTURE = os.environ.get("REGENERATE_AI_NOTES_FIXTURE") == "1"

# NOTES_MAX_INPUT_TOKENS as an unset environment leaves it: every meeting here is far under it, so
# every run is one pass. Long calls are tests/test_notes_long.py.
MAX_INPUT_TOKENS = NotesSettings().notes_max_input_tokens
# Bounds every wait below: a bug fails the test instead of hanging `make check`.
WAIT_S = 5.0
POLL_S = 0.02

type Json = dict[str, Any]


def template(*headings: str) -> NoteTemplate:
    return NoteTemplate(
        id="test_template",
        name="Test",
        description="Sections for a test.",
        sections=tuple(
            NoteTemplateSection(heading=heading, guidance=f"What goes under {heading}.")
            for heading in headings
        ),
    )


def line(text: str, start_ms: int, segment_id: str | None = None) -> SourceLine:
    return SourceLine(
        segment_id=UUID(segment_id) if segment_id else uuid4(),
        start_ms=start_ms,
        speaker="them",
        text=text,
    )


def block(number: int, text: str, markdown: str | None = None) -> NoteBlock:
    return NoteBlock(ref=f"N{number}", markdown=markdown or f"- {text}", text=text)


# The shared fixture's inputs. The segment ids are the fixture's; L5 is cited by nothing, so the
# two lines the last action item cites are apart and get a chip each.
GOLDEN_SOURCES = NotesSources(
    template=template("Decisions", "Discussion", "Action items"),
    lines=(
        line("Beta ships on Friday.", 192_000, "fd9daa6d-24ad-4dec-8fca-01604dd531da"),
        line("The pilot stays at fifty thousand", 305_000, "d78ca638-bc0d-4fcf-ae63-3272836dda46"),
        line("for the first year.", 309_000, "cd54116e-8ac8-4cb5-81aa-6ec0e0f448cf"),
        line("Let's book a follow-up.", 610_000, "b6549dd3-db2d-42be-a543-fc47d0382df8"),
        line("Sounds good.", 640_000, "0b0e7a4c-2a43-4b8e-9d55-7f2c66d0c0d1"),
        line("I'll send an invite.", 655_000, "e5cd408c-8946-40de-bc02-89cda6d95252"),
        line(
            "We will send the security questionnaire by Wednesday.",
            3_725_000,
            "9b725c25-0942-484e-8415-75737cb5c3d2",
        ),
    ),
    note_blocks=(block(1, "Ask Acme about the Q3 renewal"), block(2, "Check the travel budget")),
)
# "Discussion" gets nothing and is left out; the notes-only lines come back in the user's order.
GOLDEN_ANSWER = (
    "## Decisions\n"
    "- Beta ships Friday [L1]\n"
    "- The pilot stays at $50k for the first year [L2-L3]\n"
    "## Action items\n"
    "- Them: send the security questionnaire by Wednesday [L7]\n"
    "- Me: book the follow-up for the 14th [L4, L6]\n"
    "- Check the travel budget [N2]\n"
    "- Ask Acme about the Q3 renewal [N1]\n"
)


async def generate_offline(
    sources: NotesSources, *pieces: str
) -> tuple[GeneratedNotes, list[RunEvent], ScriptedNotesModel]:
    """The DB-free core on a scripted answer: what it made, the events it emitted, the model."""
    model = ScriptedNotesModel(ModelScript(steps=pieces))
    events: list[RunEvent] = []
    notes = await generate_notes(
        sources, model.stream, events.append, max_input_tokens=MAX_INPUT_TOKENS
    )
    return notes, events, model


async def until(condition: Callable[[], bool]) -> None:
    """Polls `condition` until it holds. The caller's `asyncio.timeout` bounds it."""
    while True:
        if condition():
            return
        await asyncio.sleep(POLL_S)


def names(events: Sequence[RunEvent]) -> list[str]:
    return [event.name for event in events]


def nodes(doc: Json, node_type: str) -> list[Json]:
    """Every node of `node_type` in `doc`, in document order."""
    found: list[Json] = []
    stack: list[Any] = [doc]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if node.get("type") == node_type:
                found.append(node)
            stack.extend(reversed(node.get("content", [])))
    return found


def text_of(node: Json) -> str:
    return str(node.get("text", "")) + "".join(text_of(child) for child in node.get("content", []))


# --- The DB-free core and the doc builder ------------------------------------------------------


async def test_built_doc_matches_shared_fixture() -> None:
    notes, _, _ = await generate_offline(GOLDEN_SOURCES, GOLDEN_ANSWER)
    doc = notes.doc()

    if REGENERATE_FIXTURE:
        FIXTURE.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    assert note_doc_problem(doc) is None
    assert doc == json.loads(FIXTURE.read_text(encoding="utf-8"))


async def test_built_doc_keeps_the_shape_the_editor_and_get_notes_read() -> None:
    # What citationNode.ts, shared/notes.ts and notes_markdown.py rely on: a level-2 heading per
    # section, list items that start with a paragraph, chips with exactly the four attrs, and the
    # closing heading, the italic "Not said on the call" line and a plain list (M4 D7).
    notes, _, _ = await generate_offline(GOLDEN_SOURCES, GOLDEN_ANSWER)
    doc = notes.doc()

    headings = nodes(doc, "heading")
    assert [text_of(heading) for heading in headings] == [
        "Decisions",
        "Action items",
        FROM_YOUR_NOTES_HEADING,
    ]
    assert all(heading["attrs"] == {"level": 2} for heading in headings)
    for item in nodes(doc, "listItem"):
        assert item["content"][0]["type"] == "paragraph"
    for chip in nodes(doc, "citation"):
        assert set(chip["attrs"]) == {"segmentIds", "startMs", "label", "support"}
    closing = doc["content"][-3:]
    assert text_of(closing[0]) == FROM_YOUR_NOTES_HEADING
    assert closing[1]["content"] == [
        {"type": "text", "text": NOT_SAID_ON_THE_CALL, "marks": [{"type": "italic"}]}
    ]
    assert closing[2]["type"] == "bulletList"
    assert not nodes(closing[2], "citation")


async def test_adjacent_lines_share_a_chip_and_a_gap_starts_another() -> None:
    notes, _, _ = await generate_offline(GOLDEN_SOURCES, GOLDEN_ANSWER)
    chips = [chip["attrs"] for chip in nodes(notes.doc(), "citation")]
    ids = [str(source.segment_id) for source in GOLDEN_SOURCES.lines]

    # [L2-L3] are neighbours: one chip for both, at the first one's time.
    assert chips[1]["segmentIds"] == [ids[1], ids[2]]
    assert chips[1]["startMs"] == 305_000
    # [L4, L6] have L5 between them: a chip each.
    assert [chip["segmentIds"] for chip in chips[3:5]] == [[ids[3]], [ids[5]]]
    assert [chip["support"] for chip in chips[3:5]] == ["weak", "weak"]


@pytest.mark.parametrize(
    ("start_ms", "label"),
    [(0, "00:00"), (192_000, "03:12"), (3_599_999, "59:59"), (3_725_000, "1:02:05")],
)
def test_chip_label_shows_hours_only_past_an_hour(start_ms: int, label: str) -> None:
    assert chip_label(start_ms) == label


async def test_events_follow_the_lines_as_they_are_checked() -> None:
    _, events, _ = await generate_offline(GOLDEN_SOURCES, *GOLDEN_ANSWER.partition("Friday"))

    assert names(events) == [
        "section",
        "item",
        "item",
        "section",
        "item",
        "item",
        "from_notes",
        "from_notes",
    ]
    assert events[0].data == {"index": 0, "heading": "Decisions"}
    assert events[3].data == {"index": 2, "heading": "Action items"}
    first = events[1].data
    assert first == {
        "section": 0,
        "text": "Beta ships Friday",
        "citations": [
            {
                "ref": "L1",
                "segment_id": str(GOLDEN_SOURCES.lines[0].segment_id),
                "start_ms": 192_000,
            }
        ],
        "support": "ok",
    }
    assert events[5].data["support"] == "weak"
    # As written; the doc puts them in the user's order.
    assert [event.data for event in events[6:]] == [
        {"text": "Check the travel budget"},
        {"text": "Ask Acme about the Q3 renewal"},
    ]


async def test_from_notes_lines_are_listed_without_chips() -> None:
    notes, _, _ = await generate_offline(GOLDEN_SOURCES, GOLDEN_ANSWER)

    assert [line.text for line in notes.from_notes] == [
        "Ask Acme about the Q3 renewal",
        "Check the travel budget",
    ]
    closing_list = notes.doc()["content"][-1]
    assert [text_of(item) for item in closing_list["content"]] == [
        "Ask Acme about the Q3 renewal",
        "Check the travel budget",
    ]
    assert not nodes(closing_list, "citation")


async def test_bullets_before_any_heading_go_to_the_first_section() -> None:
    sources = NotesSources(
        template("Summary", "Action items"), (line("Beta ships Friday.", 0),), ()
    )

    notes, events, _ = await generate_offline(sources, "- Beta ships Friday [L1]\n")

    assert [(section.index, section.heading) for section in notes.sections] == [(0, "Summary")]
    assert names(events) == ["section", "item"]


async def test_template_headings_match_ignoring_case_and_keep_the_template_wording() -> None:
    sources = NotesSources(
        template("Summary", "Action items"), (line("Beta ships Friday.", 0),), ()
    )

    notes, events, _ = await generate_offline(
        sources, "## ACTION ITEMS:\n- Them: ship the beta by Friday [L1]\n"
    )

    assert [(section.index, section.heading) for section in notes.sections] == [(1, "Action items")]
    assert events[0].data == {"index": 1, "heading": "Action items"}


async def test_a_heading_outside_the_template_starts_a_section_of_its_own() -> None:
    # A bold preamble now parses as a heading (notes_protocol.py). With nothing under it, it leaves
    # no trace; a section the model added keeps its bullets together, after the template's ones.
    sources = NotesSources(
        template("Summary", "Action items"),
        (line("Beta ships Friday.", 0), line("The budget is tight.", 1_000)),
        (),
    )

    notes, _, _ = await generate_offline(
        sources,
        "**Here are your notes:**\n"
        "## Summary\n- Beta ships Friday [L1]\n"
        "## Risks\n- The budget is tight [L2]\n"
        "## summary\n- Beta ships on Friday [L1]\n",
    )

    assert [(section.index, section.heading) for section in notes.sections] == [
        (0, "Summary"),
        (3, "Risks"),
    ]
    assert len(notes.sections[0].lines) == 2
    assert [text_of(heading) for heading in nodes(notes.doc(), "heading")] == ["Summary", "Risks"]


async def test_a_from_your_notes_heading_from_the_model_is_not_a_section() -> None:
    # The doc's closing list owns that heading: `get_notes` splits on its last one.
    sources = NotesSources(
        template("Summary"), (line("Beta ships Friday.", 0),), (block(1, "Check the budget"),)
    )

    notes, _, _ = await generate_offline(
        sources,
        f"## Summary\n- Beta ships Friday [L1]\n## {FROM_YOUR_NOTES_HEADING}\n"
        "- Check the budget [N1]\n- Beta ships Friday, again [L1]\n",
    )

    assert [section.heading for section in notes.sections] == ["Summary"]
    assert len(notes.sections[0].lines) == 2
    headings = [text_of(heading) for heading in nodes(notes.doc(), "heading")]
    assert headings == ["Summary", FROM_YOUR_NOTES_HEADING]


async def test_dropped_lines_carry_their_reason_code() -> None:
    sources = NotesSources(template("Summary"), (line("Beta ships Friday.", 0),), ())

    notes, events, _ = await generate_offline(
        sources, "## Summary\n- Beta ships Friday\n- Pricing is settled [L9]\n"
    )

    assert [event.data for event in events if event.name == "dropped"] == [
        {"text": "Beta ships Friday", "reason": "no_refs"},
        {"text": "Pricing is settled", "reason": "unknown_refs"},
    ]
    assert [(line.text, line.reason) for line in notes.dropped] == [
        ("Beta ships Friday", "no_refs"),
        ("Pricing is settled", "unknown_refs"),
    ]
    assert notes.sections == ()


async def test_a_run_that_keeps_nothing_writes_an_empty_doc_the_editor_accepts() -> None:
    # ProseMirror's doc needs one block at least: TipTap's own empty doc is one empty paragraph.
    sources = NotesSources(template("Summary"), (line("Beta ships Friday.", 0),), ())

    notes, _, _ = await generate_offline(sources, "Sorry, I cannot help with that.")

    assert notes.doc() == {"type": "doc", "content": [{"type": "paragraph"}]}


async def test_note_numbers_are_checked_against_the_words_not_the_list_marker() -> None:
    # The user's third ordered item renders as "3. ship seats". Checked against that Markdown, the
    # marker's 3 would back a "3 seats" the user never wrote (phase-2-build-order.md, section 10).
    sources = NotesSources(
        template("Summary"),
        (line("We will ship the seats.", 0),),
        (block(1, "ship seats", markdown="3. ship seats"),),
    )

    notes, _, model = await generate_offline(sources, "## Summary\n- Ship 3 seats [L1, N1]\n")

    assert [line.support for line in notes.sections[0].lines] == ["weak"]
    # The prompt still shows the block as the user wrote it.
    prompt = model.requests[0].messages[1].parts[0].text
    assert "N1 3. ship seats" in prompt


async def test_model_text_is_made_storable_before_anything_reads_it() -> None:
    # Postgres refuses U+0000 in text and jsonb, and an unpaired surrogate in jsonb: a run that
    # kept them would fail at its save, after the vendor was paid.
    sources = NotesSources(template("Summary"), (line("Beta ships Friday.", 0),), ())

    notes, events, _ = await generate_offline(
        sources, "## Summary\n- Beta\x00 ships Friday\ud800 [L1]\n"
    )

    assert notes.sections[0].lines[0].text == "Beta ships Friday\ufffd"
    assert "\x00" not in notes.output_text
    assert events[1].data["text"] == "Beta ships Friday\ufffd"


async def test_counts_of_flagged_and_from_notes_lines() -> None:
    notes, _, _ = await generate_offline(GOLDEN_SOURCES, GOLDEN_ANSWER)

    assert notes.flagged_count == 1
    assert notes.from_notes_count == 2
    assert notes.output_text == GOLDEN_ANSWER


# --- The run: claim, stream and save -----------------------------------------------------------


@pytest.fixture
async def database(database_url: str, clean_database: None) -> AsyncIterator[Database]:
    database = Database(database_url)
    yield database
    await database.dispose()


@pytest.fixture
async def meeting(database: Database) -> Meeting:
    """A meeting with two lines, in a workspace of its own."""
    workspace = Workspace(id=uuid4(), name="Linkt")
    meeting = Meeting(
        id=uuid4(),
        workspace_id=workspace.id,
        title="Standup",
        status="ended",
        started_at=datetime.now(UTC),
    )
    async with database.session() as session:
        session.add(workspace)
        await session.flush()
        session.add(meeting)
        await session.flush()
        for number, (start_ms, text) in enumerate(
            [(1_000, "Beta ships on Friday."), (4_000, "Pricing stays at fifty thousand.")]
        ):
            session.add(
                TranscriptSegment(
                    id=uuid4(),
                    meeting_id=meeting.id,
                    workspace_id=workspace.id,
                    source="system" if number else "mic",
                    speaker="them" if number else "me",
                    start_ms=start_ms,
                    end_ms=start_ms + 2_000,
                    text=text,
                )
            )
        await session.commit()
    return meeting


def principal_of(meeting: Meeting) -> Principal:
    return Principal(workspace_id=meeting.workspace_id, user_id=None)


@asynccontextmanager
async def running(database: Database, model: ScriptedNotesModel) -> AsyncIterator[LlmRuntime]:
    runtime = LlmRuntime(database, model)
    try:
        yield runtime
    finally:
        await runtime.aclose()


async def start(
    database: Database,
    runtime: LlmRuntime,
    meeting: Meeting,
    *,
    run_id: UUID,
    user_notes_version: int = 0,
    ai_base_version: int = 0,
) -> list[RunEvent]:
    """Starts a notes run with the general template and reads its stream to the end."""
    general = find_note_template("general")
    assert general is not None
    stream = await start_notes_run(
        database,
        runtime,
        principal_of(meeting),
        meeting.id,
        run_id=run_id,
        template=general,
        user_notes_version=user_notes_version,
        ai_base_version=ai_base_version,
        max_input_tokens=MAX_INPUT_TOKENS,
    )
    async with aclosing(stream.events()) as events:
        return [event async for event in events]


async def segment_ids(database: Database, meeting: Meeting) -> list[UUID]:
    async with database.session() as session:
        rows = await session.scalars(
            select(TranscriptSegment.id)
            .where(TranscriptSegment.meeting_id == meeting.id)
            .order_by(TranscriptSegment.start_ms)
        )
        return list(rows)


async def read_run(database: Database, run_id: UUID) -> LlmRun:
    async with database.session() as session:
        run = await session.get(LlmRun, run_id)
    assert run is not None
    return run


async def read_ai_note(database: Database, meeting: Meeting) -> MeetingNote | None:
    async with database.session() as session:
        note: MeetingNote | None = await session.scalar(
            select(MeetingNote).where(
                MeetingNote.meeting_id == meeting.id, MeetingNote.kind == "ai"
            )
        )
        return note


async def add_note(database: Database, meeting: Meeting, kind: str, doc: Json) -> None:
    async with database.session() as session:
        session.add(
            MeetingNote(
                id=uuid4(),
                workspace_id=meeting.workspace_id,
                meeting_id=meeting.id,
                kind=kind,
                doc=doc,
                version=1,
                last_revision_id=uuid4(),
            )
        )
        await session.commit()


def doc_saying(*paragraphs: str) -> Json:
    return {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]}
            for text in paragraphs
        ],
    }


USAGE = ModelUsage(
    input_tokens=900,
    output_tokens=120,
    cached_tokens=None,
    reasoning_tokens=0,
    cost_usd=Decimal("0.0005"),
)


async def test_events_arrive_run_sections_items_done(database: Database, meeting: Meeting) -> None:
    # The last line has no newline: the parser's finish reads it.
    model = ScriptedNotesModel(
        ModelScript(
            steps=(
                "## Summary\n- Beta ships Friday [L1]\n",
                "## Decisions\n- Pricing stays at $50k [L2]",
            ),
            end=ModelDone(usage=USAGE),
        ),
        model_id="vendor/model",
    )
    run_id = uuid4()

    async with running(database, model) as runtime:
        events = await start(database, runtime, meeting, run_id=run_id)

    assert names(events) == ["run", "section", "item", "section", "item", "done"]
    assert events[0].data == {
        "run_id": str(run_id),
        "model": "vendor/model",
        "template_id": "general",
        "line_count": 2,
    }
    done = events[-1].data
    assert done["run_id"] == str(run_id)
    note = done["note"]
    assert isinstance(note, dict)
    assert (note["kind"], note["version"], note["generated_version"]) == ("ai", 1, 1)
    assert (note["last_run_id"], note["template_id"]) == (str(run_id), "general")
    stored = await read_run(database, run_id)
    assert (stored.status, stored.model, stored.template_id) == (
        "succeeded",
        "vendor/model",
        "general",
    )
    assert stored.cost_usd == Decimal("0.0005")
    assert stored.output_doc == note["doc"]


async def test_ai_doc_citations_point_at_real_segment_ids(
    database: Database, meeting: Meeting
) -> None:
    model = ScriptedNotesModel(
        ModelScript(steps=("## Summary\n- Beta ships Friday, pricing at $50k [L1, L2]\n",))
    )
    run_id = uuid4()

    async with running(database, model) as runtime:
        await start(database, runtime, meeting, run_id=run_id)

    note = await read_ai_note(database, meeting)
    assert note is not None
    chips = [chip["attrs"] for chip in nodes(note.doc, "citation")]
    first, second = await segment_ids(database, meeting)
    assert chips == [
        {
            "segmentIds": [str(first), str(second)],
            "startMs": 1_000,
            "label": "00:01",
            "support": "ok",
        }
    ]
    stored = await read_run(database, run_id)
    assert stored.ref_map == {"L1": str(first), "L2": str(second)}


async def test_dropped_flagged_and_from_notes_lines_are_counted_on_the_run(
    database: Database, meeting: Meeting
) -> None:
    await add_note(database, meeting, "user", doc_saying("Ask about the renewal"))
    model = ScriptedNotesModel(
        ModelScript(
            steps=(
                "## Summary\n"
                "- Beta ships Friday [L1]\n"
                "- Beta ships on the 14th [L1]\n"
                "- Pricing was never settled\n"
                "- Ask about the renewal [N1]\n",
            )
        )
    )
    run_id = uuid4()

    async with running(database, model) as runtime:
        events = await start(database, runtime, meeting, run_id=run_id, user_notes_version=1)

    assert names(events) == ["run", "section", "item", "item", "dropped", "from_notes", "done"]
    stored = await read_run(database, run_id)
    assert (stored.flagged_count, stored.from_notes_count) == (1, 1)
    assert stored.dropped == [{"text": "Pricing was never settled", "reason": "no_refs"}]
    assert stored.output_text is not None
    assert stored.output_text.startswith("## Summary\n")


async def test_cut_off_output_fails_the_run_and_keeps_the_previous_ai_notes(
    database: Database, meeting: Meeting
) -> None:
    previous = doc_saying("The notes from last time")
    await add_note(database, meeting, "ai", previous)
    model = ScriptedNotesModel(
        ModelScript(
            steps=("## Summary\n- Beta ships Friday [L1]\n- Pricing st",),
            end=ModelCutOffError(usage=USAGE),
        )
    )
    run_id = uuid4()

    async with running(database, model) as runtime:
        events = await start(database, runtime, meeting, run_id=run_id, ai_base_version=1)

    assert names(events) == ["run", "section", "item", "error"]
    assert events[-1].data["code"] == "cut_off"
    stored = await read_run(database, run_id)
    assert (stored.status, stored.error_code) == ("failed", "cut_off")
    # The cut-off answer was billed, so its usage is kept; nothing it wrote is.
    assert stored.output_tokens == 120
    assert stored.output_doc is None
    note = await read_ai_note(database, meeting)
    assert note is not None
    assert (note.doc, note.version, note.last_run_id) == (previous, 1, None)


async def test_replaced_doc_is_the_ai_doc_at_write_time(
    database: Database, meeting: Meeting
) -> None:
    await add_note(database, meeting, "ai", doc_saying("Version one"))
    hold = asyncio.Event()
    model = ScriptedNotesModel(ModelScript(steps=("## Summary\n", hold, "- Beta ships [L1]\n")))
    run_id = uuid4()

    async with running(database, model) as runtime:
        reading = asyncio.create_task(
            start(database, runtime, meeting, run_id=run_id, ai_base_version=1)
        )
        async with asyncio.timeout(WAIT_S):
            await until(lambda: model.open_streams == 1)
        # A PUT is refused while the run runs, so only a write straight to the row can change the
        # doc now. The run must replace what is stored when it writes, not what it saw at its claim.
        changed = doc_saying("Version two")
        async with database.session() as session:
            note = await session.scalar(
                select(MeetingNote).where(
                    MeetingNote.meeting_id == meeting.id, MeetingNote.kind == "ai"
                )
            )
            assert note is not None
            note.doc, note.version = changed, 2
            await session.commit()
        hold.set()
        async with asyncio.timeout(WAIT_S):
            events = await reading

    assert names(events)[-1] == "done"
    stored = await read_run(database, run_id)
    assert stored.replaced_doc == changed
    note = await read_ai_note(database, meeting)
    assert note is not None
    assert (note.version, note.generated_version, note.last_run_id) == (3, 3, run_id)
    assert note.doc == stored.output_doc
