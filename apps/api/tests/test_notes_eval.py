"""The notes eval harness (`roger_api/evals`, M4-T12): cases, scores, the judge, reports, the fix
size and the command line.

Everything here runs offline: the fake model and scripted answers stand in for the vendor, as in the
plan's tiers (the fake in `make check`, the real model only by hand with `make eval-notes`). The fix
size and the export read Postgres, so those tests use the test database.
"""

import asyncio
import json
import shutil
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest

from roger_api.auth import Principal
from roger_api.db.engine import Database
from roger_api.db.models import Meeting, TranscriptSegment, Workspace
from roger_api.db.models_notes import LlmRun, MeetingNote
from roger_api.errors import LlmProviderError, NotFoundError
from roger_api.evals.notes_cases import (
    CASES_ROOT,
    ActionItemLabel,
    CaseError,
    CaseLabels,
    CaseLine,
    EvalCase,
    NotesCase,
    export_case,
    export_path,
    load_cases,
    write_case,
)
from roger_api.evals.notes_eval import main, run_eval
from roger_api.evals.notes_fixes import measure_fixes, render_fixes
from roger_api.evals.notes_judge import JUDGE_PROMPT_VERSION, read_verdicts
from roger_api.evals.notes_report import EvalReport, render_report, render_summary, write_report
from roger_api.evals.notes_score import Share
from roger_api.services.notes_model import ModelCutOffError, ModelDone, ModelUsage
from roger_api.services.notes_model_fake import FakeNotesModel, ModelScript, ScriptedNotesModel
from tests.conftest import make_settings

type Json = dict[str, Any]

USAGE = ModelUsage(
    input_tokens=1_500,
    output_tokens=400,
    cached_tokens=None,
    reasoning_tokens=0,
    cost_usd=Decimal("0.0021"),
)
# `run` never opens the database: a URL to a database nobody created proves it.
UNUSED_DATABASE_URL = "postgresql+asyncpg://postgres:postgres@localhost:5432/roger_test_unused"


def bullets_doc(*items: str, heading: str | None = None) -> Json:
    """A TipTap doc: an optional level-2 heading, then one bullet per item."""
    content: list[Json] = []
    if heading is not None:
        content.append(
            {
                "type": "heading",
                "attrs": {"level": 2},
                "content": [{"type": "text", "text": heading}],
            }
        )
    content.append(
        {
            "type": "bulletList",
            "content": [
                {
                    "type": "listItem",
                    "content": [{"type": "paragraph", "content": [{"type": "text", "text": item}]}],
                }
                for item in items
            ],
        }
    )
    return {"type": "doc", "content": content}


def inline_case(
    *texts: str,
    user_notes: Json | None = None,
    labels: CaseLabels | None = None,
    case_id: str = "inline",
) -> EvalCase:
    """A case on the General template: one "them" line per text, five seconds apart."""
    return EvalCase(
        id=case_id,
        case=NotesCase(
            schema_version=1,
            title="Inline case",
            template_id="general",
            lines=tuple(
                CaseLine(speaker="them", start_ms=5_000 * number, text=text)
                for number, text in enumerate(texts)
            ),
            user_notes=user_notes,
            labels=labels or CaseLabels(),
        ),
    )


def scripted(*answers: str | ModelScript) -> ScriptedNotesModel:
    return ScriptedNotesModel(
        *(
            answer if isinstance(answer, ModelScript) else ModelScript(steps=(answer,))
            for answer in answers
        )
    )


def counted(share: Share) -> tuple[int, int]:
    return share.count, share.total


# --- The harness on the synthetic case and on scripted answers ----------------------------------


async def test_harness_scores_the_synthetic_case_with_the_fake_model(tmp_path: Path) -> None:
    # The committed case through the fake (NOTES_PROVIDER=fake): it spreads the 20 lines over the
    # four standup sections, copies the first three of each as bullets citing them, and echoes each
    # of the five note blocks as a bullet citing only that block.
    cases = load_cases(CASES_ROOT, only=["synthetic_standup"])

    report = await run_eval(cases, FakeNotesModel(), provider="fake", reasoning="off")

    [case] = report.cases
    assert case.case_id == "synthetic_standup"
    assert case.error is None
    assert case.scores is not None
    scores = case.scores
    assert (case.line_count, case.note_block_count) == (20, 5)
    assert counted(scores.dropped) == (0, 17)
    assert counted(scores.flagged) == (0, 12)
    assert counted(scores.from_notes) == (5, 17)
    # The "Standup" heading names a topic, not a point: four blocks to cover.
    assert counted(scores.user_note_coverage) == (4, 4)
    # Fifty thousand, twelve, p95 / 2.5 / 800 and Q3: each line's numbers are in the line it cites.
    assert counted(scores.number_fidelity) == (4, 4)
    # Found by meaning words, not exact text: "finished migrating ... fifty thousand rows" is the
    # fact "finished the billing migration, 50,000 rows".
    assert counted(scores.facts) == (3, 3)
    # Only Priya's item is in a line the fake copied, with her name in it.
    assert counted(scores.action_items) == (1, 3)
    assert [item.owner for item in scores.missed_action_items] == ["Me", "Sam"]
    # The fake reports no usage: cost unknown, never 0.
    assert case.usage is None
    assert (report.totals.usage, report.totals.usage_unknown) == (None, 1)
    assert case.latency_ms is not None
    assert case.latency_ms >= 0
    assert case.first_line_ms is not None
    assert report.model == "fake"
    assert report.judge_model is None

    files = write_report(report, tmp_path / "run")

    assert files.json.name == "report.json"
    assert EvalReport.model_validate_json(files.json.read_text(encoding="utf-8")) == report
    markdown = files.markdown.read_text(encoding="utf-8")
    assert markdown == render_report(report)
    assert "| synthetic_standup |" in markdown
    assert "33.3% (1 of 3)" in markdown


async def test_report_counts_the_from_notes_share(tmp_path: Path) -> None:
    case = inline_case(
        "Beta ships on Friday.",
        "Pricing stays where it is.",
        "We hire two engineers.",
        user_notes=bullets_doc("Check the travel budget"),
    )
    answer = (
        "## Decisions\n"
        "- Beta ships Friday [L1]\n"
        "- Pricing stays as it is [L2]\n"
        "- Hire two engineers [L3]\n"
        "- Check the travel budget [N1]\n"
        "- A line that cites nothing\n"
    )

    report = await run_eval([case], scripted(answer), provider="fake", reasoning="off")

    [scored] = report.cases
    assert scored.scores is not None
    # From-notes lines of all the lines kept: 1 of the 3 cited and 1 from the notes.
    assert counted(scored.scores.from_notes) == (1, 4)
    assert scored.scores.from_notes.rate == 0.25
    # Dropped lines count against every line written, the dropped one included.
    assert counted(scored.scores.dropped) == (1, 5)
    assert counted(report.totals.from_notes) == (1, 4)
    markdown = write_report(report, tmp_path / "run").markdown.read_text(encoding="utf-8")
    from_notes_row = next(line for line in markdown.splitlines() if "From your notes" in line)
    assert "25.0% (1 of 4)" in from_notes_row
    # No target until the owner has seen the share (M4 D7).
    assert "no target" in from_notes_row
    stored = json.loads((tmp_path / "run" / "report.json").read_text(encoding="utf-8"))
    assert stored["totals"]["from_notes"] == {"count": 1, "total": 4, "rate": 0.25}


async def test_action_items_and_facts_match_by_owner_numbers_and_words() -> None:
    labels = CaseLabels(
        action_items=(
            ActionItemLabel(owner="Priya", text="share the migration runbook by Thursday"),
            # The words are all there, under the wrong owner.
            ActionItemLabel(owner="Me", text="send the deck by Friday"),
        ),
        facts=("the pilot stays at 50k", "the pilot stays at 60k"),
    )
    case = inline_case(
        "Priya will share the runbook for the migration on Thursday.",
        "Them: send the deck by Friday.",
        "The pilot stays at fifty thousand.",
        labels=labels,
    )
    answer = (
        "- Priya: share the migration runbook on Thursday [L1]\n"
        "- Them: send the deck by Friday [L2]\n"
        "- The pilot stays at fifty thousand [L3]\n"
    )

    report = await run_eval([case], scripted(answer), provider="fake", reasoning="off")

    scores = report.cases[0].scores
    assert scores is not None
    assert counted(scores.action_items) == (1, 2)
    assert [item.owner for item in scores.missed_action_items] == ["Me"]
    # "50k" is the transcript's "fifty thousand"; "60k" is in no line.
    assert counted(scores.facts) == (1, 2)
    assert scores.missed_facts == ["the pilot stays at 60k"]


async def test_an_action_item_counts_only_under_the_owner_the_line_gives_it_to() -> None:
    # The prompt writes "Owner: what, by when". "Me" and "Them" are everyday objects too ("send
    # me"), so an owner found anywhere in the line would count a reversed item as found.
    labels = CaseLabels(
        action_items=(
            ActionItemLabel(owner="Me", text="send the contract to Dana by Friday"),
            ActionItemLabel(owner="Priya", text="send the deck by Friday"),
            ActionItemLabel(owner="Them", text="share the migration runbook by Thursday"),
            # A time's colon does not end the owner: this line opens with Them.
            ActionItemLabel(owner="Me", text="send the deck for Lena"),
            # Found: one of the owners named before the colon, and a line that opens with its owner.
            ActionItemLabel(owner="Sam", text="review the pricing page"),
            ActionItemLabel(owner="Dev", text="fix the webhook retries by noon"),
        )
    )
    case = inline_case(*(f"Line {number}." for number in range(1, 7)), labels=labels)
    answer = (
        "- Them: send me the contract by Friday [L1]\n"
        "- Sam: send Priya the deck by Friday [L2]\n"
        "- Me: share the migration runbook with them by Thursday [L3]\n"
        "- Them to send me the deck for Lena by 3:00 [L4]\n"
        "- Priya and Sam: review the pricing page [L5]\n"
        "- Dev will fix the webhook retries by noon [L6]\n"
    )

    report = await run_eval([case], scripted(answer), provider="fake", reasoning="off")

    scores = report.cases[0].scores
    assert scores is not None
    assert [(item.owner, item.text) for item in scores.missed_action_items] == [
        ("Me", "send the contract to Dana by Friday"),
        ("Priya", "send the deck by Friday"),
        ("Them", "share the migration runbook by Thursday"),
        ("Me", "send the deck for Lena"),
    ]
    assert counted(scores.action_items) == (2, 6)


async def test_flagged_lines_and_numbers_are_counted_against_their_cited_lines() -> None:
    case = inline_case(
        "Beta ships on Friday.",
        "The pilot stays at fifty thousand.",
        user_notes=bullets_doc("ask about Q3", heading="Pricing"),
    )
    answer = (
        "- Beta ships Friday [L1]\n"
        # 60000 is in no cited line: kept, flagged "check this".
        "- The pilot stays at 60k [L2]\n"
        "- Ask about Q3 [N2]\n"
    )

    report = await run_eval([case], scripted(answer), provider="fake", reasoning="off")

    scores = report.cases[0].scores
    assert scores is not None
    assert counted(scores.flagged) == (1, 2)
    assert [line.text for line in scores.flagged_lines] == ["The pilot stays at 60k"]
    assert scores.flagged_lines[0].missing_numbers == ["60000"]
    assert counted(scores.number_fidelity) == (0, 1)
    # N1 is the "Pricing" heading, a topic rather than a point; the one point, N2, was kept.
    assert counted(scores.user_note_coverage) == (1, 1)


async def test_a_note_paragraph_that_opens_with_a_hash_is_a_point_not_a_heading() -> None:
    # Markdown text is never escaped (notes_markdown.py), so "#1 risk" renders as "#1 risk"; only
    # a heading node gets "## ". TipTap makes a heading only of "#" and a space, too.
    def paragraph(text: str) -> Json:
        return {"type": "paragraph", "content": [{"type": "text", "text": text}]}

    user_notes = {
        "type": "doc",
        "content": [
            {
                "type": "heading",
                "attrs": {"level": 2},
                "content": [{"type": "text", "text": "Risks"}],
            },
            paragraph("#1 risk is the vendor contract"),
            paragraph("#launch channel gets the recap"),
        ],
    }
    case = inline_case("Beta ships on Friday.", user_notes=user_notes)

    report = await run_eval(
        [case],
        scripted("- The vendor contract is the top risk [N2]\n"),
        provider="fake",
        reasoning="off",
    )

    scores = report.cases[0].scores
    assert scores is not None
    assert counted(scores.user_note_coverage) == (1, 2)
    assert scores.missed_notes == ["#launch channel gets the recap"]


async def test_judge_counts_the_lines_it_calls_unsupported() -> None:
    case = inline_case("Beta ships on Friday.", "Pricing stays where it is.")
    notes = scripted(
        ModelScript(
            steps=("- Beta ships Friday [L1]\n- Pricing goes up [L2]\n",), end=ModelDone(USAGE)
        )
    )
    judge = ScriptedNotesModel(
        ModelScript(steps=("J1: yes\n", "**J2:** no\n"), end=ModelDone(USAGE)), model_id="judge"
    )

    report = await run_eval([case], notes, provider="openrouter", reasoning="off", judge=judge)

    [scored] = report.cases
    assert scored.judge is not None
    assert scored.judge.model == "judge"
    assert scored.judge.prompt_version == JUDGE_PROMPT_VERSION
    assert counted(scored.judge.unsupported) == (1, 2)
    assert scored.judge.unsupported_lines == ["Pricing goes up"]
    assert scored.judge.unjudged == 0
    assert report.judge_model == "judge"
    assert report.totals.judge_unsupported is not None
    assert counted(report.totals.judge_unsupported) == (1, 2)
    # One claim per kept line, each shown with the line it cites, fenced as data.
    [request] = judge.requests
    prompt = request.messages[-1].parts[0].text
    assert "<claims>" in prompt
    assert "J2 Pricing goes up" in prompt
    assert "L2 [00:00:05] Them: Pricing stays where it is." in prompt
    # The notes and the judge are billed apart.
    assert scored.usage is not None
    assert scored.usage.cost_usd == Decimal("0.0021")
    assert scored.judge.usage is not None
    assert scored.judge.usage.cost_usd == Decimal("0.0021")


@pytest.mark.parametrize(
    ("answer", "verdicts"),
    [
        ("J1: yes\n**J2:** no\n- J3 - Yes.\n", {1: True, 2: False, 3: True}),
        # Claims go out as "J<n> <text>": an echoed one that opens with "No" is no verdict.
        ("J1 No blockers for Sam\n\nJ1: yes\n", {1: True}),
        # Nor is a claim restated with its answer: not judged, which the report shows.
        ("J1 No blockers for Sam: yes\n", {}),
        # Answered twice, the first verdict stands; a number past the claims is ignored.
        ("J1: no\nJ1: yes\nJ4: no\n", {1: False}),
    ],
)
def test_a_judge_verdict_is_the_last_word_of_its_line(
    answer: str, verdicts: dict[int, bool]
) -> None:
    assert read_verdicts(answer, 3) == verdicts


def judge_row(report: EvalReport) -> str:
    return next(
        line for line in render_summary(report).splitlines() if "judge calls unsupported" in line
    )


async def test_lines_the_judge_left_without_a_verdict_leave_the_run_incomplete() -> None:
    case = inline_case("Beta ships on Friday.", "Pricing stays where it is.", "We hire two.")
    notes = scripted("- Beta ships Friday [L1]\n- Pricing stays [L2]\n- We hire two [L3]\n")
    # Claim 2 in a form the judge's parser does not read: no verdict, and no error either.
    judge = ScriptedNotesModel(
        ModelScript(steps=("J1: yes\nClaim 2: supported\nJ3: yes\n",)), model_id="judge"
    )

    report = await run_eval([case], notes, provider="openrouter", reasoning="off", judge=judge)

    [scored] = report.cases
    assert scored.judge is not None
    assert scored.judge.error is None
    assert (counted(scored.judge.unsupported), scored.judge.unjudged) == ((0, 2), 1)
    assert report.totals.judge_unjudged == 1
    # "0 of 2: met" would call the target over two of three lines: not measured, and the run
    # exits 1 (`notes_eval._run`).
    assert report.incomplete
    assert judge_row(report) == (
        "| Lines the judge calls unsupported | 0.0% (0 of 2); 1 line not judged "
        "| under 5%: not measured |"
    )


async def test_a_named_judge_with_no_scored_case_is_not_asked_for_again() -> None:
    case = inline_case("Beta ships on Friday.")
    refused = scripted(ModelScript(refuse=LlmProviderError("The provider refused the request")))

    report = await run_eval(
        [case],
        refused,
        provider="openrouter",
        reasoning="off",
        judge=ScriptedNotesModel(model_id="judge"),
    )

    assert report.totals.judge_unsupported is None
    assert judge_row(report) == (
        "| Lines the judge calls unsupported | not judged (no case was scored) | under 5% |"
    )


async def test_the_judge_is_not_called_when_no_line_was_kept() -> None:
    case = inline_case("Beta ships on Friday.")
    # No script: a call would raise LookupError.
    judge = ScriptedNotesModel(model_id="judge")

    report = await run_eval(
        [case],
        scripted("- A line that cites nothing\n"),
        provider="openrouter",
        reasoning="off",
        judge=judge,
    )

    scored = report.cases[0].judge
    assert scored is not None
    assert judge.requests == []
    assert counted(scored.unsupported) == (0, 0)
    # Nothing was sent, so nothing was billed: a known zero, unlike an unreported usage.
    assert scored.usage is not None
    assert scored.usage.cost_usd == 0
    assert report.totals.judge_usage_unknown == 0


async def test_a_failed_case_is_reported_and_the_next_case_still_runs() -> None:
    cut_off = inline_case("Beta ships on Friday.", case_id="cut_off")
    refused = inline_case("Beta ships on Friday.", case_id="refused")
    scored = inline_case("Beta ships on Friday.", case_id="scored")
    model = scripted(
        # Billed though cut off: its usage is kept.
        ModelScript(steps=("- Beta ships [L1",), end=ModelCutOffError(USAGE)),
        ModelScript(refuse=LlmProviderError("The notes model's provider refused the request")),
        ModelScript(steps=("- Beta ships Friday [L1]\n",), end=ModelDone(USAGE)),
    )

    report = await run_eval([cut_off, refused, scored], model, provider="fake", reasoning="off")

    by_id = {case.case_id: case for case in report.cases}
    assert by_id["cut_off"].error is not None
    assert by_id["cut_off"].error.code == "cut_off"
    assert by_id["cut_off"].scores is None
    assert by_id["cut_off"].usage is not None
    assert by_id["cut_off"].usage.cost_usd == Decimal("0.0021")
    assert by_id["refused"].error is not None
    assert by_id["refused"].error.code == "llm_provider_error"
    assert by_id["refused"].usage is None
    assert by_id["scored"].error is None
    assert report.totals.failed == 2
    assert report.totals.scored == 1
    # The refused case's cost is unknown: counted apart, never added as 0, so the total says it
    # is not the whole.
    assert report.totals.usage is not None
    assert report.totals.usage.cost_usd == Decimal("0.0042")
    assert report.totals.usage_unknown == 1
    markdown = render_report(report)
    assert "$0.0042, and 1 call with no usage reported" in markdown
    assert "| cut_off | general | 1 | failed: cut_off |" in markdown


# --- Cases -------------------------------------------------------------------------------------


def write_json(path: Path, value: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")
    return path


def case_json(**overrides: object) -> Json:
    return {
        "schema_version": 1,
        "title": "A call",
        "template_id": "general",
        "lines": [{"speaker": "me", "start_ms": 0, "text": "Hello."}],
        **overrides,
    }


def test_cases_load_from_the_folder_and_its_local_subfolder(tmp_path: Path) -> None:
    write_json(tmp_path / "synthetic.json", case_json())
    write_json(tmp_path / "local" / "client-call.json", case_json(title="Client"))
    write_json(tmp_path / "local" / "notes.txt", {"ignored": True})

    cases = load_cases(tmp_path)

    assert [case.id for case in cases] == ["local/client-call", "synthetic"]
    assert [case.id for case in load_cases(tmp_path, only=["synthetic"])] == ["synthetic"]
    with pytest.raises(CaseError, match="missing"):
        load_cases(tmp_path, only=["missing"])


@pytest.mark.parametrize(
    ("overrides", "problem"),
    [
        ({"template_id": "retro"}, "retro"),
        ({"lines": [], "user_notes": None}, "no transcript lines and no notes"),
        (
            {
                "lines": [
                    {"speaker": "me", "start_ms": 9_000, "text": "Later."},
                    {"speaker": "me", "start_ms": 1_000, "text": "Earlier."},
                ]
            },
            "transcript order",
        ),
        ({"user_notes": {"type": "paragraph"}}, "not a TipTap doc"),
    ],
)
def test_a_bad_case_names_its_file_and_the_problem(
    tmp_path: Path, overrides: Json, problem: str
) -> None:
    write_json(tmp_path / "broken.json", case_json(**overrides))

    with pytest.raises(CaseError, match=r"broken\.json") as raised:
        load_cases(tmp_path)

    assert problem in str(raised.value)


def test_a_case_file_name_is_refused_when_markdown_would_break_on_it(tmp_path: Path) -> None:
    write_json(tmp_path / "a|b.json", case_json())

    with pytest.raises(CaseError, match=r"a\|b\.json"):
        load_cases(tmp_path)


# --- The fix size and the export (Postgres) ----------------------------------------------------


@pytest.fixture
async def database(database_url: str, clean_database: None) -> AsyncIterator[Database]:
    database = Database(database_url)
    yield database
    await database.dispose()


@pytest.fixture
async def principal(database: Database) -> Principal:
    workspace = Workspace(id=uuid4(), name="Linkt")
    async with database.session() as session:
        session.add(workspace)
        await session.commit()
    return Principal(workspace_id=workspace.id, user_id=None)


async def add_meeting(
    database: Database, workspace_id: UUID, *, title: str = "Standup", hours_ago: int = 0
) -> UUID:
    meeting_id = uuid4()
    async with database.session() as session:
        session.add(
            Meeting(
                id=meeting_id,
                workspace_id=workspace_id,
                title=title,
                status="ended",
                started_at=datetime.now(UTC) - timedelta(hours=hours_ago),
            )
        )
        await session.commit()
    return meeting_id


async def add_generated_notes(
    database: Database,
    workspace_id: UUID,
    meeting_id: UUID,
    *,
    generated: Json | None,
    current: Json,
    edited: bool,
) -> UUID:
    """A notes run that wrote `generated` (None: it failed), and the AI note as it is now."""
    run_id = uuid4()
    async with database.session() as session:
        session.add(
            LlmRun(
                id=run_id,
                workspace_id=workspace_id,
                meeting_id=meeting_id,
                kind="notes",
                status="succeeded" if generated is not None else "failed",
                model="xiaomi/mimo-v2.6-pro",
                prompt_version="notes-v1",
                template_id="standup",
                line_count=2,
                ref_map={},
                output_doc=generated,
                dropped=[{"text": "A line with no source", "reason": "no_refs"}],
                flagged_count=2,
                from_notes_count=1,
                cost_usd=Decimal("0.0031") if generated is not None else None,
            )
        )
        await session.flush()
        session.add(
            MeetingNote(
                id=uuid4(),
                workspace_id=workspace_id,
                meeting_id=meeting_id,
                kind="ai",
                doc=current,
                version=3 if edited else 2,
                last_revision_id=uuid4(),
                template_id="standup",
                last_run_id=run_id,
                generated_version=2,
            )
        )
        await session.commit()
    return run_id


async def test_fix_report_measures_edits_between_run_output_and_current_notes(
    database: Database, principal: Principal
) -> None:
    generated = bullets_doc("Beta ships Friday", "Pricing stays at 50k", heading="Decisions")
    workspace_id = principal.workspace_id
    # Newest first: one line added, one line removed, nothing changed.
    added = await add_meeting(database, workspace_id, hours_ago=1)
    await add_generated_notes(
        database,
        workspace_id,
        added,
        generated=generated,
        current=bullets_doc(
            "Beta ships Friday", "Pricing stays at 50k", "Me: send the deck", heading="Decisions"
        ),
        edited=True,
    )
    removed = await add_meeting(database, workspace_id, hours_ago=2)
    await add_generated_notes(
        database,
        workspace_id,
        removed,
        generated=generated,
        current=bullets_doc("Beta ships Friday", heading="Decisions"),
        edited=True,
    )
    untouched = await add_meeting(database, workspace_id, hours_ago=3)
    await add_generated_notes(
        database, workspace_id, untouched, generated=generated, current=generated, edited=False
    )
    # Not measured: a run that wrote nothing, and another workspace's meeting.
    failed = await add_meeting(database, workspace_id)
    await add_generated_notes(
        database, workspace_id, failed, generated=None, current=generated, edited=False
    )
    other = Workspace(id=uuid4(), name="Someone else")
    async with database.session() as session:
        session.add(other)
        await session.commit()
    foreign = await add_meeting(database, other.id)
    await add_generated_notes(
        database, other.id, foreign, generated=generated, current=bullets_doc("Edited"), edited=True
    )

    fixes = await measure_fixes(database, principal, limit=10)

    assert [fix.meeting_id for fix in fixes] == [added, removed, untouched]
    first, second, third = fixes
    assert (first.lines_added, first.lines_removed) == (1, 0)
    assert (first.characters_added, first.characters_removed) == (len("\n- Me: send the deck"), 0)
    assert first.edited
    assert (second.lines_added, second.lines_removed) == (0, 1)
    assert (second.characters_added, second.characters_removed) == (
        0,
        len("\n- Pricing stays at 50k"),
    )
    assert (third.lines_added, third.lines_removed, third.characters_added) == (0, 0, 0)
    assert not third.edited
    # The run's own counts and cost, for the exit check log beside the stopwatch.
    assert (first.dropped_count, first.flagged_count, first.from_notes_count) == (1, 2, 1)
    assert first.cost_usd == Decimal("0.0031")
    assert first.model == "xiaomi/mimo-v2.6-pro"
    assert [fix.meeting_id for fix in await measure_fixes(database, principal, limit=1)] == [added]
    only = await measure_fixes(database, principal, meeting_id=removed, limit=10)
    assert [fix.meeting_id for fix in only] == [removed]
    markdown = render_fixes(fixes)
    assert "+1 / -0" in markdown
    assert f"+0 / -{len(chr(10) + '- Pricing stays at 50k')}" in markdown


async def test_export_writes_a_case_from_a_meeting_and_its_notes(
    database: Database, principal: Principal, tmp_path: Path
) -> None:
    workspace_id = principal.workspace_id
    meeting_id = await add_meeting(database, workspace_id, title="Acme renewal")
    user_doc = bullets_doc("ask about Q3")
    async with database.session() as session:
        for number, (speaker, text) in enumerate([("them", "Second."), ("me", "First.")]):
            session.add(
                TranscriptSegment(
                    id=uuid4(),
                    meeting_id=meeting_id,
                    workspace_id=workspace_id,
                    source="mic" if speaker == "me" else "system",
                    speaker=speaker,
                    # Stored out of order: the export reads the transcript's own order.
                    start_ms=4_000 - 3_000 * number,
                    end_ms=5_000 - 3_000 * number,
                    text=text,
                )
            )
        session.add(
            MeetingNote(
                id=uuid4(),
                workspace_id=workspace_id,
                meeting_id=meeting_id,
                kind="user",
                doc=user_doc,
                version=1,
                last_revision_id=uuid4(),
            )
        )
        await session.commit()
    await add_generated_notes(
        database, workspace_id, meeting_id, generated=user_doc, current=user_doc, edited=False
    )

    case = await export_case(database, principal, meeting_id, template_id=None)

    assert case.title == "Acme renewal"
    assert case.template_id == "standup"  # the AI notes' template
    assert [(line.speaker, line.start_ms, line.text) for line in case.lines] == [
        ("me", 1_000, "First."),
        ("them", 4_000, "Second."),
    ]
    assert case.user_notes == user_doc
    assert case.labels == CaseLabels()  # labelled by hand after the export
    assert case.meeting_id == meeting_id
    path = export_path(tmp_path, meeting_id)
    assert path == tmp_path / "local" / f"{meeting_id}.json"
    write_case(case, path, overwrite=False)
    [loaded] = load_cases(tmp_path)
    assert loaded.id == f"local/{meeting_id}"
    assert loaded.case == case
    chosen = await export_case(database, principal, meeting_id, template_id="general")
    assert chosen.template_id == "general"
    # A second export would erase the hand labels.
    with pytest.raises(FileExistsError):
        write_case(case, path, overwrite=False)


async def test_export_needs_a_template_and_a_meeting_of_the_workspace(
    database: Database, principal: Principal
) -> None:
    meeting_id = await add_meeting(database, principal.workspace_id)
    async with database.session() as session:
        session.add(
            TranscriptSegment(
                id=uuid4(),
                meeting_id=meeting_id,
                workspace_id=principal.workspace_id,
                source="mic",
                speaker="me",
                start_ms=0,
                end_ms=1_000,
                text="Hello.",
            )
        )
        await session.commit()

    with pytest.raises(CaseError, match="--template"):
        await export_case(database, principal, meeting_id, template_id=None)
    with pytest.raises(CaseError, match="retro"):
        await export_case(database, principal, meeting_id, template_id="retro")
    stranger = Principal(workspace_id=uuid4(), user_id=None)
    with pytest.raises(NotFoundError):
        await export_case(database, stranger, meeting_id, template_id="general")


# --- The command line --------------------------------------------------------------------------


def test_run_command_writes_the_report_and_says_where(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    cases = tmp_path / "cases"
    cases.mkdir()
    shutil.copy(CASES_ROOT / "synthetic_standup.json", cases / "synthetic_standup.json")
    out = tmp_path / "report"

    code = main(
        ["run", "--cases", str(cases), "--out", str(out)],
        settings=make_settings(UNUSED_DATABASE_URL),
    )

    assert code == 0
    assert (out / "report.json").is_file()
    printed = capsys.readouterr().out
    assert str(out / "report.md") in printed
    assert "| synthetic_standup |" in printed


def test_run_on_the_local_folder_leaves_the_committed_cases_out_of_the_targets(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # The command the module docstring gives for the exit check: the recorded calls alone, without
    # the synthetic case a default run pools into the targets.
    cases = tmp_path / "cases"
    write_json(cases / "local" / "client-call.json", case_json(title="Client"))
    shutil.copy(CASES_ROOT / "synthetic_standup.json", cases / "synthetic_standup.json")
    out = tmp_path / "report"

    code = main(
        ["run", "--cases", str(cases / "local"), "--out", str(out)],
        settings=make_settings(UNUSED_DATABASE_URL),
    )

    assert code == 0
    report = EvalReport.model_validate_json((out / "report.json").read_text(encoding="utf-8"))
    assert [case.case_id for case in report.cases] == ["client-call"]
    assert "synthetic_standup" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "option",
    [["--model", "anthropic/claude-sonnet-5.5"], ["--reasoning", "on"], ["--judge-model", "x"]],
)
def test_model_options_are_refused_on_the_fake_provider(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], option: list[str]
) -> None:
    out = tmp_path / "report"

    code = main(["run", "--out", str(out), *option], settings=make_settings(UNUSED_DATABASE_URL))

    assert code == 1
    assert "NOTES_PROVIDER=openrouter" in capsys.readouterr().err
    assert not out.exists()


async def test_export_and_fixes_commands_read_the_default_workspace(
    database: Database, database_url: str, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # The commands resolve the API's own principal (one workspace until M6), as a request would.
    settings = make_settings(database_url)
    async with database.session() as session:
        session.add(Workspace(id=settings.default_workspace_id, name="Linkt"))
        await session.commit()
    meeting_id = await add_meeting(database, settings.default_workspace_id, title="Acme renewal")
    async with database.session() as session:
        session.add(
            TranscriptSegment(
                id=uuid4(),
                meeting_id=meeting_id,
                workspace_id=settings.default_workspace_id,
                source="system",
                speaker="them",
                start_ms=0,
                end_ms=2_000,
                text="Beta ships on Friday.",
            )
        )
        await session.commit()
    generated = bullets_doc("Beta ships Friday", heading="Decisions")
    await add_generated_notes(
        database,
        settings.default_workspace_id,
        meeting_id,
        generated=generated,
        current=bullets_doc("Beta ships Monday", heading="Decisions"),
        edited=True,
    )
    case_file = tmp_path / "local" / "acme.json"
    export = ["export", "--meeting", str(meeting_id), "--template", "client_call"]

    # `main` runs its own event loop, so it runs in a thread beside this test's.
    exported = await asyncio.to_thread(main, [*export, "--out", str(case_file)], settings=settings)
    again = await asyncio.to_thread(main, [*export, "--out", str(case_file)], settings=settings)
    fixed = await asyncio.to_thread(
        main, ["fixes", "--out", str(tmp_path / "fixes")], settings=settings
    )

    assert (exported, again, fixed) == (0, 1, 0)
    [case] = load_cases(tmp_path)
    assert case.case.template_id == "client_call"
    assert case.case.meeting_id == meeting_id
    # A second export would have erased the hand labels: refused, the file kept.
    assert "File exists" in capsys.readouterr().err
    fixes = json.loads((tmp_path / "fixes" / "fixes.json").read_text(encoding="utf-8"))
    assert [fix["meeting_id"] for fix in fixes["fixes"]] == [str(meeting_id)]
    assert "Acme renewal" in (tmp_path / "fixes" / "fixes.md").read_text(encoding="utf-8")


def test_fixes_refuses_a_limit_below_one(capsys: pytest.CaptureFixture[str]) -> None:
    # Postgres would refuse a negative LIMIT mid-run; 0 would measure nothing without saying so.
    with pytest.raises(SystemExit) as stopped:
        main(["fixes", "--limit", "0"], settings=make_settings(UNUSED_DATABASE_URL))

    assert stopped.value.code == 2
    assert "must be at least 1" in capsys.readouterr().err
