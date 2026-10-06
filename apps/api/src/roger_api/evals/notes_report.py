"""The notes eval's report (M4-T12): `report.json` for comparing runs, `report.md` for reading.

Reports go to `apps/api/evals/notes/reports/`, which .gitignore keeps out of the repo: the details
quote the cases' lines, and a local case is a client call. The summary (targets and the case
table) quotes no line, so the command line prints only that.
"""

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from functools import reduce
from pathlib import Path
from typing import Literal, Self

from pydantic import BaseModel

from roger_api.config_notes import NotesProvider, NotesReasoning
from roger_api.evals.notes_score import NO_SHARE, CaseScores, Share
from roger_api.schemas.common import UtcDatetime

# The run registry's rule for adding up model calls, so an eval's cost compares with
# `llm_runs.cost_usd`: unknown when any call's is, never a partial sum that reads as the whole.
# Imported, never copied.
from roger_api.services.llm_runs import _sum_usage
from roger_api.services.notes_markdown import FROM_YOUR_NOTES_HEADING
from roger_api.services.notes_model import ModelUsage
from roger_api.services.transcript_render import format_instant

# The plan's targets (M4 plan, "Done when"): targets, not gates.
DROPPED_UNDER = 0.05
FLAGGED_UNDER = 0.10
UNSUPPORTED_UNDER = 0.05
ACTION_ITEMS_AT_LEAST = 0.80
# Not a target: the risk table's signal that fixing will take over 2 minutes.
COVERAGE_RISK_UNDER = 0.90

REPORT_JSON = "report.json"
REPORT_MARKDOWN = "report.md"


class CaseFailure(BaseModel):
    # `llm_provider_error` or `cut_off`, as a run's `error` event names them.
    code: str
    message: str


class JudgeOut(BaseModel):
    model: str
    prompt_version: str
    # Of the kept lines the judge gave a verdict on.
    unsupported: Share
    # Kept lines the judge gave no verdict on.
    unjudged: int
    unsupported_lines: list[str]
    # None when the vendor reported none or the judge was never called: cost unknown, never 0.
    usage: ModelUsage | None
    error: CaseFailure | None = None


class CaseReport(BaseModel):
    case_id: str
    title: str
    template_id: str
    line_count: int
    note_block_count: int
    # Set when generation failed; then there are no scores.
    error: CaseFailure | None = None
    scores: CaseScores | None = None
    # None when the vendor reported none: cost unknown, never 0 (the fake reports none).
    usage: ModelUsage | None = None
    # From the request to the end of the stream, and to the first line shown.
    latency_ms: int | None = None
    first_line_ms: int | None = None
    judge: JudgeOut | None = None
    # The model's answer as it arrived (made storable), for reading what was dropped and why.
    output_text: str | None = None


class Totals(BaseModel):
    """The scored cases pooled: counts added, never rates averaged."""

    scored: int
    failed: int
    dropped: Share
    flagged: Share
    from_notes: Share
    user_note_coverage: Share
    number_fidelity: Share
    action_items: Share
    facts: Share
    # None when no judge ran.
    judge_unsupported: Share | None
    # Every case's notes calls added up, failed cases included (a cut-off is billed). A case whose
    # vendor reported no usage is counted in `usage_unknown`, never added as 0; None when no case
    # reported any.
    usage: ModelUsage | None
    usage_unknown: int
    judge_usage: ModelUsage | None
    judge_usage_unknown: int

    @classmethod
    def of(cls, cases: Sequence[CaseReport]) -> Self:
        scores = [case.scores for case in cases if case.scores is not None]
        judged = [case.judge for case in cases if case.judge is not None]

        def pooled(measure: Callable[[CaseScores], Share]) -> Share:
            return sum((measure(score) for score in scores), NO_SHARE)

        return cls(
            scored=len(scores),
            failed=len(cases) - len(scores),
            dropped=pooled(lambda score: score.dropped),
            flagged=pooled(lambda score: score.flagged),
            from_notes=pooled(lambda score: score.from_notes),
            user_note_coverage=pooled(lambda score: score.user_note_coverage),
            number_fidelity=pooled(lambda score: score.number_fidelity),
            action_items=pooled(lambda score: score.action_items),
            facts=pooled(lambda score: score.facts),
            judge_unsupported=(
                sum((judge.unsupported for judge in judged), NO_SHARE) if judged else None
            ),
            usage=add_usage([case.usage for case in cases if case.usage is not None]),
            usage_unknown=sum(case.usage is None for case in cases),
            judge_usage=add_usage([judge.usage for judge in judged if judge.usage is not None]),
            judge_usage_unknown=sum(judge.usage is None for judge in judged),
        )


class EvalReport(BaseModel):
    schema_version: Literal[1] = 1
    started_at: UtcDatetime
    provider: NotesProvider
    model: str
    reasoning: NotesReasoning
    prompt_version: str
    judge_model: str | None
    cases: list[CaseReport]
    totals: Totals

    @property
    def incomplete(self) -> bool:
        """A case that did not score, or a judge that did not answer: the run is not complete."""
        return any(
            case.error is not None or (case.judge is not None and case.judge.error is not None)
            for case in self.cases
        )


def add_usage(usages: Sequence[ModelUsage | None]) -> ModelUsage | None:
    """The usages added up as the run registry adds a run's calls: unknown (None) when any is, and
    for none at all."""
    if not usages:
        return None
    return reduce(_sum_usage, usages[1:], usages[0])


@dataclass(frozen=True, slots=True)
class ReportFiles:
    json: Path
    markdown: Path


def stamp(at: datetime) -> str:
    """A report folder's name: the run's UTC time, with no character a file name may not hold."""
    return format_instant(at).replace(":", "-")


def write_report(report: EvalReport, folder: Path) -> ReportFiles:
    folder.mkdir(parents=True, exist_ok=True)
    files = ReportFiles(json=folder / REPORT_JSON, markdown=folder / REPORT_MARKDOWN)
    files.json.write_text(report.model_dump_json(indent=2) + "\n", encoding="utf-8")
    files.markdown.write_text(render_report(report), encoding="utf-8")
    return files


# --- Markdown ----------------------------------------------------------------------------------


def render_report(report: EvalReport) -> str:
    """The summary, then each case's details: what was removed, flagged and missed."""
    details = [_case_details(case) for case in report.cases]
    return "\n".join([render_summary(report), "## Details", "", *details])


def render_summary(report: EvalReport) -> str:
    """The run, the targets and one row per case. It quotes no line of any case."""
    totals = report.totals
    judge = f"`{report.judge_model}`" if report.judge_model else "none"
    lines = [
        "# Notes eval",
        "",
        f"{format_instant(report.started_at)} · model `{report.model}` (provider "
        f"{report.provider}, reasoning {report.reasoning}) · prompt {report.prompt_version} · "
        f"judge {judge}",
        "",
        f"{totals.scored} {_plural(totals.scored, 'case')} scored, {totals.failed} failed.",
        "",
        "## Targets",
        "",
        'Targets, not gates (M4 plan, "Done when"), over the scored cases pooled.',
        "",
        "| Measure | Result | Target |",
        "| --- | --- | --- |",
        _target_row("Dropped lines", totals.dropped, _under(totals.dropped, DROPPED_UNDER)),
        _target_row(
            'Flagged lines ("check this")', totals.flagged, _under(totals.flagged, FLAGGED_UNDER)
        ),
        _judge_row(totals.judge_unsupported),
        _target_row(
            "Action items found",
            totals.action_items,
            _at_least(totals.action_items, ACTION_ITEMS_AT_LEAST),
        ),
        _target_row(
            f'"{FROM_YOUR_NOTES_HEADING}" share',
            totals.from_notes,
            "no target until the owner has seen it (D7)",
        ),
        _target_row(
            "User-note coverage",
            totals.user_note_coverage,
            f"none; under {COVERAGE_RISK_UNDER:.0%} signals slow fixing",
        ),
        _target_row("Numbers backed by cited lines", totals.number_fidelity, "none"),
        _target_row("Facts found", totals.facts, "none"),
        f"| Cost of the notes | {_total_cost(totals.usage, totals.usage_unknown)} | none |",
        *(_judge_cost_row(totals) if report.judge_model else []),
        "",
        "## Cases",
        "",
        "| Case | Template | Lines | Kept | Flagged | From notes | Dropped | Note points kept "
        "| Action items | Facts | Latency | Cost |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        *(_case_row(case) for case in report.cases),
        "",
    ]
    return "\n".join(lines)


def _target_row(measure: str, share: Share, target: str) -> str:
    return f"| {measure} | {_share(share)} | {target} |"


def _judge_cost_row(totals: Totals) -> list[str]:
    cost = _total_cost(totals.judge_usage, totals.judge_usage_unknown)
    return [f"| Cost of the judge | {cost} | none |"]


def _judge_row(unsupported: Share | None) -> str:
    target = f"under {UNSUPPORTED_UNDER:.0%}"
    if unsupported is None:
        return f"| Lines the judge calls unsupported | not judged (pass --judge-model) | {target} |"
    return _target_row(
        "Lines the judge calls unsupported", unsupported, _under(unsupported, UNSUPPORTED_UNDER)
    )


def _under(share: Share, limit: float) -> str:
    target = f"under {limit:.0%}"
    if share.rate is None:
        return target
    return f"{target}: {'met' if share.rate < limit else 'missed'}"


def _at_least(share: Share, limit: float) -> str:
    target = f"at least {limit:.0%}"
    if share.rate is None:
        return target
    return f"{target}: {'met' if share.rate >= limit else 'missed'}"


def _case_row(case: CaseReport) -> str:
    if case.scores is None:
        failure = f"failed: {case.error.code}" if case.error else "failed"
        # The failure in the Kept column; no counts from notes that were never finished.
        cells = [case.case_id, case.template_id, str(case.line_count), failure, *[""] * 6]
        return "| " + " | ".join([*cells, _seconds(case.latency_ms), _cost(case.usage)]) + " |"
    scores = case.scores
    cells = [
        case.case_id,
        case.template_id,
        str(case.line_count),
        # Every kept line with transcript citations is a candidate for the flag.
        str(scores.flagged.total),
        str(scores.flagged.count),
        str(scores.from_notes.count),
        str(scores.dropped.count),
        _of(scores.user_note_coverage),
        _of(scores.action_items),
        _of(scores.facts),
        _seconds(case.latency_ms),
        _cost(case.usage),
    ]
    return "| " + " | ".join(cells) + " |"


def _case_details(case: CaseReport) -> str:
    lines = [f"### {case.case_id}: {_one_line(case.title)}", ""]
    if case.error is not None:
        lines += [f"Failed with `{case.error.code}`: {case.error.message}", ""]
    scores = case.scores
    if scores is not None:
        lines += _listed(
            "Removed lines", (f"{line.text} ({line.reason})" for line in scores.dropped_lines)
        )
        lines += _listed(
            'Flagged "check this"',
            (
                f"{line.text} (numbers not in its cited lines: "
                f"{', '.join(line.missing_numbers) or 'none'}; shares a word: "
                f"{'yes' if line.shares_words else 'no'})"
                for line in scores.flagged_lines
            ),
        )
        lines += _listed("Note points not kept", scores.missed_notes)
        lines += _listed(
            "Action items not found",
            (f"{item.owner}: {item.text}" for item in scores.missed_action_items),
        )
        lines += _listed("Facts not found", scores.missed_facts)
    if case.judge is not None:
        judge = case.judge
        if judge.error is not None:
            lines += [f"The judge failed with `{judge.error.code}`: {judge.error.message}", ""]
        lines += _listed(f"The judge calls unsupported ({judge.model})", judge.unsupported_lines)
        if judge.unjudged:
            lines += [f"The judge gave no verdict on {judge.unjudged} lines.", ""]
    return "\n".join(lines)


def _listed(title: str, items: Iterable[str]) -> list[str]:
    bullets = [f"- {_one_line(item)}" for item in items]
    return [f"{title}: {'none' if not bullets else ''}".rstrip(), *bullets, ""]


def _one_line(text: str) -> str:
    # A note block can span lines (a hard break, a second paragraph in an item): kept, its second
    # line would read as a paragraph of the report instead of part of its bullet.
    return " ".join(text.split())


def _share(share: Share) -> str:
    if share.rate is None:
        return f"n/a ({_of(share)})"
    return f"{share.rate:.1%} ({_of(share)})"


def _of(share: Share) -> str:
    return f"{share.count} of {share.total}"


def _seconds(milliseconds: int | None) -> str:
    return "-" if milliseconds is None else f"{milliseconds / 1000:.1f} s"


def _cost(usage: ModelUsage | None) -> str:
    cost: Decimal | None = None if usage is None else usage.cost_usd
    return "unknown" if cost is None else f"${cost}"


def _total_cost(usage: ModelUsage | None, unknown: int) -> str:
    known = _cost(usage)
    if not unknown or known == "unknown":
        return known
    return f"{known}, and {unknown} {_plural(unknown, 'call')} with no usage reported"


def _plural(count: int, word: str) -> str:
    return word if count == 1 else f"{word}s"
