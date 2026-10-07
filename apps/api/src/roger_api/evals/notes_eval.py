"""The notes eval (M4-T12): scores AI notes on recorded calls and measures how much they were fixed.

Run from apps/api, as `make eval-notes` and `make eval-notes-fixes` do:

    uv run --frozen python -m roger_api.evals.notes_eval run [--case ID ...] [--model ID]
        [--reasoning on|off] [--judge-model ID] [--cases DIR] [--out DIR]
    uv run --frozen python -m roger_api.evals.notes_eval export --meeting ID [--template ID]
        [--out FILE] [--force]
    uv run --frozen python -m roger_api.evals.notes_eval fixes [--meeting ID] [--limit N]
        [--out DIR]

- `run` writes each case's notes through `generate_notes`, the DB-free core every API notes run
  uses (services/notes_generation.py), and scores them (notes_score.py; with `--judge-model`, a
  second model's verdicts too, notes_judge.py). It writes `report.json` and `report.md` to
  `evals/notes/reports/<UTC time>/` (git-ignored) and prints the summary. `--model` and
  `--reasoning` compare models and M4 D2's two reasoning settings on the same cases.
  It reads every case in `--cases` and in its `local/` folder and pools their counts in the
  targets, so by default the committed synthetic case is in them too. For the exit check, which
  is about the recorded calls alone, name the local folder:
  `make eval-notes ARGS="--cases evals/notes/cases/local"`.
- `export` copies a meeting from Postgres into `evals/notes/cases/local/<meeting id>.json`
  (git-ignored: client calls) with no labels; write its action items and facts by hand.
- `fixes` measures how much each meeting's AI notes changed since the run that wrote them
  (notes_fixes.py), for the exit check log.

Tiers, after anarlog's contract / smoke / live split: tests/test_notes_eval.py runs the harness on
the fake model in `make check`, offline. A real model runs only by hand, with NOTES_PROVIDER=
openrouter and OPENROUTER_API_KEY in the repo-root `.env`: then every case is a paid request, and
the report records its cost. Settings come from the `.env` like the API's (`config.Settings`);
`run` never opens the database.
"""

import argparse
import asyncio
import sys
import time
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from contextlib import AsyncExitStack, aclosing, asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from uuid import UUID

from roger_api.auth import default_principal
from roger_api.config import Settings, get_settings
from roger_api.config_notes import NotesProvider, NotesReasoning
from roger_api.db.engine import Database
from roger_api.errors import AppError, LlmProviderError
from roger_api.evals.notes_cases import (
    CASES_ROOT,
    EVALS_ROOT,
    CaseError,
    EvalCase,
    NotesCase,
    export_case,
    export_path,
    load_cases,
    write_case,
)
from roger_api.evals.notes_fixes import FixSize, measure_fixes, render_fixes, write_fixes
from roger_api.evals.notes_judge import JUDGE_PROMPT_VERSION, judge_lines
from roger_api.evals.notes_report import (
    CaseFailure,
    CaseReport,
    EvalReport,
    JudgeOut,
    Totals,
    add_usage,
    render_summary,
    stamp,
    write_report,
)
from roger_api.evals.notes_score import CaseScores, Share, lines_kept, score_notes
from roger_api.log import configure_logging, get_logger
from roger_api.services.citations import CitedLine

# The run registry's metering of one model stream (a `ModelDone`'s usage, or a cut-off's), so an
# eval's cost compares with `llm_runs.cost_usd` as `notes_report.add_usage` does. Imported, never
# copied: a copy keeps the old rule after the registry's rule changes, with every test still green.
from roger_api.services.llm_runs import RunEvent, _metered, _StreamUsage
from roger_api.services.notes_generation import GeneratedNotes, NotesSources, generate_notes
from roger_api.services.notes_model import (
    ModelCutOffError,
    ModelEvent,
    ModelRequest,
    ModelUsage,
    NotesModel,
    open_notes_model,
)
from roger_api.services.notes_prompt import PROMPT_VERSION

logger = get_logger(__name__)

REPORTS_ROOT = EVALS_ROOT / "reports"
DEFAULT_FIXES_LIMIT = 20
# The events that put a line on the user's screen: the first one is the wait the user feels.
_LINE_EVENTS = frozenset({"item", "from_notes"})
# A judge with no kept line to check is never called. Zero is the truth then, unlike a call whose
# vendor reported no usage, which stays unknown (None) and never reads as free.
_NO_CALL = ModelUsage(
    input_tokens=0, output_tokens=0, cached_tokens=0, reasoning_tokens=0, cost_usd=Decimal(0)
)


class OptionError(ValueError):
    """Options that cannot give the run they ask for. The message says what to change."""


# --- Metering ----------------------------------------------------------------------------------


class UsageMeter:
    """`model.stream`, with every call's usage added up as the run registry meters a run
    (`llm_runs.RunContext.stream`): a `ModelDone`'s usage, or a cut-off's, which was billed."""

    def __init__(self, model: NotesModel) -> None:
        self._model = model
        self._usages: list[ModelUsage | None] = []

    @property
    def usage(self) -> ModelUsage | None:
        """None before any call (a refusal), or when any call's usage is unknown."""
        return add_usage(self._usages)

    @asynccontextmanager
    async def stream(self, request: ModelRequest) -> AsyncIterator[AsyncIterator[ModelEvent]]:
        async with self._model.stream(request) as events:
            seen = _StreamUsage()
            async with aclosing(_metered(events, seen)) as metered:
                try:
                    yield metered
                finally:
                    self._usages.append(seen.usage)


@dataclass(slots=True)
class _Stopwatch:
    started: float = field(default_factory=time.perf_counter)
    first_line_ms: int | None = None

    def elapsed_ms(self) -> int:
        return round((time.perf_counter() - self.started) * 1000)

    def saw(self, event: RunEvent) -> None:
        if self.first_line_ms is None and event.name in _LINE_EVENTS:
            self.first_line_ms = self.elapsed_ms()


# --- The harness -------------------------------------------------------------------------------


async def run_eval(
    cases: Sequence[EvalCase],
    model: NotesModel,
    *,
    provider: NotesProvider,
    reasoning: NotesReasoning,
    judge: NotesModel | None = None,
) -> EvalReport:
    """Writes and scores the notes of every case, one after another.

    A case whose model call fails is reported with its error and the run goes on; a bug raises.
    """
    started_at = datetime.now(UTC)
    reports = [await eval_case(case, model, judge) for case in cases]
    return EvalReport(
        started_at=started_at,
        provider=provider,
        model=model.model_id("notes"),
        reasoning=reasoning,
        prompt_version=PROMPT_VERSION,
        judge_model=None if judge is None else judge.model_id("notes"),
        cases=reports,
        totals=Totals.of(reports),
    )


async def eval_case(case: EvalCase, model: NotesModel, judge: NotesModel | None) -> CaseReport:
    sources = case.sources()
    meter = UsageMeter(model)
    stopwatch = _Stopwatch()
    try:
        notes = await generate_notes(sources, meter.stream, stopwatch.saw)
    except (LlmProviderError, ModelCutOffError) as error:
        logger.warning("notes_eval_case_failed", case_id=case.id, code=error.code)
        return _case_report(
            case,
            sources,
            error=_failure(error),
            usage=meter.usage,
            latency_ms=stopwatch.elapsed_ms(),
        )
    latency_ms = stopwatch.elapsed_ms()
    scores = score_notes(sources, notes, case.case.labels)
    logger.info(
        "notes_eval_case_scored",
        case_id=case.id,
        kept=scores.flagged.total,
        flagged=scores.flagged.count,
        from_notes=scores.from_notes.count,
        dropped=scores.dropped.count,
        latency_ms=latency_ms,
    )
    return _case_report(
        case,
        sources,
        scores=scores,
        usage=meter.usage,
        latency_ms=latency_ms,
        first_line_ms=stopwatch.first_line_ms,
        judge=None if judge is None else await _judge(judge, sources, notes),
        output_text=notes.output_text,
    )


def _case_report(
    case: EvalCase,
    sources: NotesSources,
    *,
    usage: ModelUsage | None,
    latency_ms: int,
    error: CaseFailure | None = None,
    scores: CaseScores | None = None,
    first_line_ms: int | None = None,
    judge: JudgeOut | None = None,
    output_text: str | None = None,
) -> CaseReport:
    return CaseReport(
        case_id=case.id,
        title=case.case.title,
        template_id=case.case.template_id,
        line_count=len(sources.lines),
        note_block_count=len(sources.note_blocks),
        error=error,
        scores=scores,
        usage=usage,
        latency_ms=latency_ms,
        first_line_ms=first_line_ms,
        judge=judge,
        output_text=output_text,
    )


async def _judge(judge: NotesModel, sources: NotesSources, notes: GeneratedNotes) -> JudgeOut:
    lines = lines_kept(notes)
    if not lines:
        return _judged(judge, lines, verdicts={}, usage=_NO_CALL)
    meter = UsageMeter(judge)
    try:
        verdicts = await judge_lines(lines, sources.refs(), meter.stream)
    except (LlmProviderError, ModelCutOffError) as error:
        logger.warning("notes_eval_judge_failed", model=judge.model_id("notes"), code=error.code)
        return _judged(judge, lines, verdicts={}, usage=meter.usage, error=_failure(error))
    return _judged(judge, lines, verdicts=verdicts, usage=meter.usage)


def _judged(
    judge: NotesModel,
    lines: Sequence[CitedLine],
    *,
    verdicts: Mapping[int, bool],
    usage: ModelUsage | None,
    error: CaseFailure | None = None,
) -> JudgeOut:
    unsupported = [lines[number - 1].text for number, ok in sorted(verdicts.items()) if not ok]
    return JudgeOut(
        model=judge.model_id("notes"),
        prompt_version=JUDGE_PROMPT_VERSION,
        unsupported=Share(count=len(unsupported), total=len(verdicts)),
        unjudged=len(lines) - len(verdicts),
        unsupported_lines=unsupported,
        usage=usage,
        error=error,
    )


def _failure(error: LlmProviderError | ModelCutOffError) -> CaseFailure:
    # Both messages are ours: the adapter never puts the vendor's body in one.
    return CaseFailure(code=error.code, message=str(error))


# --- The command line --------------------------------------------------------------------------


def main(argv: Sequence[str] | None = None, *, settings: Settings | None = None) -> int:
    """Runs one command; returns the exit status. Logging is the caller's (`_cli`)."""
    args = _parser().parse_args(argv)
    command: Callable[[argparse.Namespace, Settings], int] = args.command
    try:
        return command(args, settings or get_settings())
    except (OptionError, CaseError, AppError, FileExistsError) as error:
        # Refusals the person can act on, said in one line. Anything else is a bug and raises.
        sys.stderr.write(f"notes eval: {error}\n")
        return 1


# Each command reads and writes its files here, around one `asyncio.run` for the model or the
# database: file I/O inside the event loop would block it (ruff's ASYNC rules).


def _run(args: argparse.Namespace, settings: Settings) -> int:
    notes_settings = settings.model_copy(update=_model_choices(args, settings))
    cases = load_cases(args.cases, only=args.case)
    out: Path = args.out or REPORTS_ROOT / stamp(datetime.now(UTC))
    # Before any case runs: a folder that exists would fail the write after every case was paid.
    out.mkdir(parents=True, exist_ok=False)
    report = asyncio.run(_run_cases(cases, notes_settings, judge_model=args.judge_model))
    files = write_report(report, out)
    sys.stdout.write(f"{render_summary(report)}\nReport: {files.markdown}\n")
    return 1 if report.incomplete else 0


async def _run_cases(
    cases: Sequence[EvalCase], settings: Settings, *, judge_model: str | None
) -> EvalReport:
    async with AsyncExitStack() as stack:
        model = await stack.enter_async_context(open_notes_model(settings))
        judge = None
        if judge_model is not None:
            # Reasoning off for the judge, always: its numbers stay comparable across runs.
            judge_settings = settings.model_copy(
                update={"notes_model": judge_model, "notes_reasoning": "off"}
            )
            judge = await stack.enter_async_context(open_notes_model(judge_settings))
        return await run_eval(
            cases,
            model,
            provider=settings.notes_provider,
            reasoning=settings.notes_reasoning,
            judge=judge,
        )


def _model_choices(args: argparse.Namespace, settings: Settings) -> dict[str, object]:
    chosen = {
        "--model": args.model,
        "--reasoning": args.reasoning,
        "--judge-model": args.judge_model,
    }
    named = [option for option, value in chosen.items() if value is not None]
    if named and settings.notes_provider == "fake":
        # The fake ignores them: a report labelled "reasoning on" or with a judge's name would
        # compare nothing.
        raise OptionError(
            f"{', '.join(named)} picks an OpenRouter model, but NOTES_PROVIDER is fake; set "
            "NOTES_PROVIDER=openrouter and OPENROUTER_API_KEY in the repo-root .env"
        )
    update: dict[str, object] = {}
    if args.model is not None:
        update["notes_model"] = args.model
    if args.reasoning is not None:
        update["notes_reasoning"] = args.reasoning
    return update


def _export(args: argparse.Namespace, settings: Settings) -> int:
    async def read() -> NotesCase:
        database = Database(settings.database_url)
        try:
            return await export_case(
                database, default_principal(settings), args.meeting, template_id=args.template
            )
        finally:
            await database.dispose()

    case = asyncio.run(read())
    path: Path = args.out or export_path(CASES_ROOT, args.meeting)
    write_case(case, path, overwrite=args.force)
    sys.stdout.write(
        f'Case: {path}\nWrite its action items and facts under "labels" before scoring it.\n'
    )
    return 0


def _fixes(args: argparse.Namespace, settings: Settings) -> int:
    async def measure() -> list[FixSize]:
        database = Database(settings.database_url)
        try:
            return await measure_fixes(
                database, default_principal(settings), meeting_id=args.meeting, limit=args.limit
            )
        finally:
            await database.dispose()

    fixes = asyncio.run(measure())
    out: Path = args.out or REPORTS_ROOT / f"{stamp(datetime.now(UTC))}-fixes"
    files = write_fixes(fixes, out)
    sys.stdout.write(f"{render_fixes(fixes)}\nReport: {files.markdown}\n")
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="notes_eval", description="Score AI notes on recorded calls (M4-T12)."
    )
    commands = parser.add_subparsers(required=True)

    run = commands.add_parser("run", help="write and score notes for every case")
    run.set_defaults(command=_run)
    run.add_argument(
        "--cases",
        type=Path,
        default=CASES_ROOT,
        help=(
            "folder of case files, pooled with its local/ folder; default the committed cases, "
            "the synthetic one included (evals/notes/cases/local: the recorded calls alone)"
        ),
    )
    run.add_argument(
        "--case", action="append", default=[], help="a case id to run (repeatable); default all"
    )
    run.add_argument("--out", type=Path, help="report folder; default reports/<UTC time>")
    run.add_argument("--model", help="the OpenRouter model to write notes with")
    run.add_argument("--reasoning", choices=["on", "off"], help="override NOTES_REASONING")
    run.add_argument("--judge-model", help="a second model that checks each kept line")

    export = commands.add_parser("export", help="copy a meeting into cases/local")
    export.set_defaults(command=_export)
    export.add_argument("--meeting", type=UUID, required=True, help="the meeting id")
    export.add_argument("--template", help="template id; default the AI notes' template")
    export.add_argument("--out", type=Path, help="case file; default cases/local/<meeting>.json")
    export.add_argument("--force", action="store_true", help="replace a case (and its labels)")

    fixes = commands.add_parser("fixes", help="edit size of each meeting's AI notes")
    fixes.set_defaults(command=_fixes)
    fixes.add_argument("--meeting", type=UUID, help="one meeting; default the newest")
    fixes.add_argument(
        "--limit", type=_at_least_one, default=DEFAULT_FIXES_LIMIT, help="meetings to list"
    )
    fixes.add_argument("--out", type=Path, help="report folder; default reports/<UTC time>-fixes")
    return parser


def _at_least_one(value: str) -> int:
    # Postgres refuses a negative LIMIT, and 0 would measure nothing without saying so.
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError(f"must be at least 1, not {number}")
    return number


def _cli() -> int:
    settings = get_settings()
    # Here, not in `main`: tests call `main`, and logging set up there would point the root
    # handler at pytest's captured stderr long after that test closed it.
    configure_logging(settings)
    return main(settings=settings)


if __name__ == "__main__":
    sys.exit(_cli())
