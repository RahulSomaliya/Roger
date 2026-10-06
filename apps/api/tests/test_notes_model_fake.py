"""The fake notes models: the development default, and the scripted one other tests drive."""

import asyncio
from dataclasses import dataclass
from decimal import Decimal
from uuid import uuid4

import pytest

from roger_api.errors import LlmProviderError
from roger_api.services.citations import (
    CitedLine,
    DroppedLine,
    FromNotesLine,
    RefMap,
    SourceLine,
    check_line,
)
from roger_api.services.notes_model import (
    JsonSchemaFormat,
    ModelCutOffError,
    ModelDone,
    ModelEvent,
    ModelMessage,
    ModelRequest,
    ModelUsage,
    NotesModel,
    TextDelta,
    TextPart,
    notes_request,
)
from roger_api.services.notes_model_fake import (
    FAKE_MODEL_ID,
    FakeNotesModel,
    ModelScript,
    ScriptedNotesModel,
)
from roger_api.services.notes_prompt import build_notes_prompt, transcript_line
from roger_api.services.notes_protocol import Bullet, Heading, LineProtocolParser


@dataclass(frozen=True, slots=True)
class Section:
    heading: str
    guidance: str


@dataclass(frozen=True, slots=True)
class Template:
    name: str
    sections: tuple[Section, ...]


STANDUP = Template(
    name="Standup",
    sections=(
        Section("Yesterday", "What each person finished since the last standup."),
        Section("Today", "What each person will work on next."),
        Section("Blockers & asks", "Anything stopping someone, and who can unblock it."),
    ),
)
LINES = (
    SourceLine(uuid4(), 3_000, "me", "Morning, let's go round quickly."),
    SourceLine(uuid4(), 9_000, "them", "Yesterday I finished the billing export for Acme."),
    SourceLine(uuid4(), 21_000, "me", "I reviewed the onboarding copy with Dana."),
    SourceLine(
        uuid4(), 40_000, "them", "Today I'm on the calendar sync, then the 3 pricing pages."
    ),
    SourceLine(uuid4(), 61_000, "me", "I'll pair with Sam on the release checklist."),
    SourceLine(uuid4(), 75_000, "them", "Blocked on the staging database credentials from ops."),
)
REFS = RefMap(lines=LINES, note_blocks=("## Pricing", "- ask about the **discount**"))
USAGE = ModelUsage(
    input_tokens=1_200,
    output_tokens=300,
    cached_tokens=0,
    reasoning_tokens=None,
    cost_usd=Decimal("0.000783"),
)


async def read_into(seen: list[ModelEvent], model: NotesModel, request: ModelRequest) -> None:
    """Appends each event as it arrives, so a test still sees them when the stream raises."""
    async with model.stream(request) as events:
        async for event in events:
            seen.append(event)


async def read_all(model: NotesModel, request: ModelRequest) -> list[ModelEvent]:
    seen: list[ModelEvent] = []
    await read_into(seen, model, request)
    return seen


def note_text(events: list[ModelEvent]) -> str:
    return "".join(event.text for event in events if isinstance(event, TextDelta))


def chat_request(*lines: SourceLine) -> ModelRequest:
    transcript = "\n".join(
        transcript_line(number, line) for number, line in enumerate(lines, start=1)
    )
    return ModelRequest(
        kind="chat",
        messages=(
            ModelMessage("system", (TextPart("Answer from the transcript, citing [L12]."),)),
            ModelMessage(
                "user",
                (
                    TextPart(f"<transcript>\n{transcript}\n</transcript>", cache=True),
                    TextPart("Who is blocked?"),
                ),
            ),
        ),
    )


async def test_fake_cites_real_lines_from_the_prompt() -> None:
    events = await read_all(FakeNotesModel(), notes_request(build_notes_prompt(STANDUP, REFS)))

    parser = LineProtocolParser()
    parsed = parser.feed(note_text(events)) + parser.finish()
    assert [line.text for line in parsed if isinstance(line, Heading)] == [
        "Yesterday",
        "Today",
        "Blockers & asks",
    ]
    checked = [check_line(line, REFS) for line in parsed if isinstance(line, Bullet)]
    cited = [line for line in checked if isinstance(line, CitedLine)]
    assert cited
    # Every bullet survives the API's checks, so a development run shows working chips.
    assert all(line.support == "ok" for line in cited)
    assert not [line for line in checked if isinstance(line, DroppedLine)]
    cited_ids = {citation.segment_id for line in cited for citation in line.citations}
    assert cited_ids <= {line.segment_id for line in LINES}
    # The user's points come back as bullets citing their note blocks ("From your notes", D7).
    assert [line.text for line in checked if isinstance(line, FromNotesLine)] == [
        "Pricing",
        "ask about the discount",
    ]
    assert events[-1] == ModelDone(usage=None)


async def test_fake_streams_text_in_small_pieces() -> None:
    events = await read_all(FakeNotesModel(), notes_request(build_notes_prompt(STANDUP, REFS)))

    deltas = [event for event in events if isinstance(event, TextDelta)]
    # Split mid-line, so callers that parse a stream are exercised in development as well.
    assert len(deltas) > note_text(events).count("\n")
    assert [event for event in events if isinstance(event, ModelDone)] == [events[-1]]


async def test_fake_writes_only_headings_for_a_meeting_with_no_lines_or_notes() -> None:
    empty = RefMap(lines=(), note_blocks=())

    events = await read_all(FakeNotesModel(), notes_request(build_notes_prompt(STANDUP, empty)))

    assert note_text(events) == "## Yesterday\n## Today\n## Blockers & asks\n"


async def test_fake_answers_chat_citing_real_lines() -> None:
    events = await read_all(FakeNotesModel(), chat_request(*LINES))

    answer = note_text(events)
    assert "[L1]" in answer
    assert "[L2]" in answer
    assert "Morning" in answer
    assert events[-1] == ModelDone(usage=None)


async def test_fake_says_so_when_chat_has_no_lines() -> None:
    events = await read_all(FakeNotesModel(), chat_request())

    assert "[L" not in note_text(events)
    assert note_text(events)


async def test_fake_refuses_structured_output() -> None:
    request = ModelRequest(
        kind="notes",
        messages=(ModelMessage("user", (TextPart("Score these notes."),)),),
        json_schema=JsonSchemaFormat(name="score", schema={"type": "object"}),
    )

    with pytest.raises(LlmProviderError, match="structured"):
        await read_all(FakeNotesModel(), request)


def test_fake_names_its_model() -> None:
    model = FakeNotesModel()

    assert model.model_id("notes") == model.model_id("chat") == FAKE_MODEL_ID == "fake"


async def test_scripted_fake_replays_chunks_errors_and_truncation() -> None:
    refused = LlmProviderError("The notes model's provider refused the request (HTTP 402)")
    failed = LlmProviderError("The notes model's provider failed while answering")
    model = ScriptedNotesModel(
        ModelScript(steps=("## Dec", "isions\n- Ship [L1]\n"), end=ModelDone(usage=USAGE)),
        ModelScript(steps=("## Decisions\n",), end=failed),
        ModelScript(steps=("## Decisions\n- Ship",), end=ModelCutOffError(usage=USAGE)),
        ModelScript(refuse=refused),
    )
    request = notes_request(build_notes_prompt(STANDUP, REFS))

    assert await read_all(model, request) == [
        TextDelta("## Dec"),
        TextDelta("isions\n- Ship [L1]\n"),
        ModelDone(usage=USAGE),
    ]

    seen: list[ModelEvent] = []
    with pytest.raises(LlmProviderError) as raised:
        await read_into(seen, model, request)
    assert raised.value is failed
    assert seen == [TextDelta("## Decisions\n")]

    seen.clear()
    with pytest.raises(ModelCutOffError) as cut_off:
        await read_into(seen, model, request)
    assert cut_off.value.usage == USAGE
    assert seen == [TextDelta("## Decisions\n- Ship")]

    # A refusal comes from opening the stream, before any event: the 502 envelope's case.
    with pytest.raises(LlmProviderError) as refusal:
        async with model.stream(request):
            pytest.fail("a refused stream must not open")
    assert refusal.value is refused

    with pytest.raises(LookupError, match="no script left for request 5"):
        await read_all(model, request)

    assert model.requests == [request] * 5
    assert model.open_streams == 0


async def test_scripted_fake_waits_on_an_event_step_and_closes_when_left() -> None:
    go_on = asyncio.Event()
    model = ScriptedNotesModel(ModelScript(steps=("## Decisions\n", go_on, "- Ship [L1]\n")))
    request = notes_request(build_notes_prompt(STANDUP, REFS))

    async with model.stream(request) as events:
        assert model.open_streams == 1
        assert await anext(events) == TextDelta("## Decisions\n")
        waiting = asyncio.ensure_future(anext(events))
        await asyncio.sleep(0.01)
        assert not waiting.done()
        go_on.set()
        assert await waiting == TextDelta("- Ship [L1]\n")
    # Leaving the stream early closes it, as a cancelled run does with a real provider.
    assert model.open_streams == 0
    assert model.model_id("notes") == "scripted"


def test_notes_request_sends_the_rules_then_the_sources() -> None:
    prompt = build_notes_prompt(STANDUP, REFS)

    assert notes_request(prompt) == ModelRequest(
        kind="notes",
        messages=(
            ModelMessage("system", (TextPart(prompt.system),)),
            ModelMessage("user", (TextPart(prompt.user),)),
        ),
    )
