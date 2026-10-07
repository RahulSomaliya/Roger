"""Scores for one case's AI notes (M4-T12). Pure: no model, no database.

What the plan's targets read (M4 plan, "Done when"): the share of lines dropped, flagged "check
this" and moved to "From your notes"; how much of the user's notes the AI notes kept; whether the
numbers in a kept line are in the lines it cites; and how many of the hand-labelled action items
and facts the notes hold.

Every measure is a `Share`, a count out of a total, so cases pool by adding counts, never by
averaging rates (a 3-line case would weigh as much as a 60-line one).
"""

import re
from collections.abc import Sequence

from pydantic import BaseModel, ConfigDict, SerializerFunctionWrapHandler, model_serializer

from roger_api.evals.notes_cases import ActionItemLabel, CaseLabels
from roger_api.services.citations import CitedLine, DropReason, FromNotesLine, check_support
from roger_api.services.notes_generation import GeneratedNotes, NotesSources
from roger_api.services.notes_markdown import NoteBlock

# A label is found in a line that holds at least this share of its words (`_FILLER` and numbers
# left out) and every number it names. At 1.0 a model that rephrased ("share the runbook for the
# migration") would miss an item it kept; much lower and "send the deck" matches any line about a
# deck.
LABEL_WORD_SHARE = 0.6
# Words compared by their first letters, so "migration" and "migrating" or "runbook" and "runbooks"
# are one word. A word shorter than `_WHOLE_WORD_BELOW` compares whole: "run" is not "runbook".
_STEM_CHARS = 5
_WHOLE_WORD_BELOW = 4

_TOKEN = re.compile(r"[^\W_]+(?:'[^\W_]+)*")
_DIGIT = re.compile(r"[0-9]")
_HEADING_MARKS = re.compile(r"#{1,6} ")
# The colon that ends an action item's owner ("Priya: share ..."), never one inside a time ("3:00").
_OWNER_END = re.compile(r":(?![0-9])")
# Words that say nothing about what was agreed. Numbers are compared apart, by `check_support`.
_WORDS_WITHOUT_CONTENT = """
    a an and or but the to of for by on in at with from as into about is are was were be been
    will would should can could do does did done i we you he she they it its this that these
    those our my your their there here so then also please yes ok okay all just
"""
_FILLER = frozenset(_WORDS_WITHOUT_CONTENT.split())


class Share(BaseModel):
    """`count` out of `total`. The JSON also carries `rate`, for a reader of report.json."""

    model_config = ConfigDict(frozen=True)

    count: int
    total: int

    @property
    def rate(self) -> float | None:
        """None when there is nothing to count, never a made-up 0 or 100%."""
        return self.count / self.total if self.total else None

    def __add__(self, other: "Share") -> "Share":
        return Share(count=self.count + other.count, total=self.total + other.total)

    # Written out, never read back: a report loaded from JSON recomputes it from the counts, so a
    # hand-edited file cannot disagree with itself.
    @model_serializer(mode="wrap")
    def _with_rate(self, handler: SerializerFunctionWrapHandler) -> dict[str, object]:
        data: dict[str, object] = handler(self)
        data["rate"] = self.rate
        return data


NO_SHARE = Share(count=0, total=0)


class DroppedOut(BaseModel):
    text: str
    reason: DropReason


class FlaggedOut(BaseModel):
    text: str
    # Normalised as `citations.py` compares them ("50k" is "50000"; `q3` stays whole).
    missing_numbers: list[str]
    # False when the line shares no content word with what it cites.
    shares_words: bool


class CaseScores(BaseModel):
    # Of every line the model wrote that parsed as a bullet: kept, from the notes or dropped.
    dropped: Share
    # Of the kept lines with transcript citations.
    flagged: Share
    # Of every line kept: cited lines and from-notes lines (M4 D7; reported, no target yet).
    from_notes: Share
    # Of the user's note blocks that are points: a heading names a topic, and the prompt asks to
    # keep every point (`notes_prompt.py`).
    user_note_coverage: Share
    # Of the kept lines that hold a number: those whose every number is in what they cite.
    number_fidelity: Share
    action_items: Share
    facts: Share
    dropped_lines: list[DroppedOut]
    flagged_lines: list[FlaggedOut]
    # The words of each point no kept line cites.
    missed_notes: list[str]
    missed_action_items: list[ActionItemLabel]
    missed_facts: list[str]


def lines_kept(notes: GeneratedNotes) -> list[CitedLine]:
    """The kept lines with transcript citations, in the order the notes show them."""
    return [line for section in notes.sections for line in section.lines]


def score_notes(sources: NotesSources, notes: GeneratedNotes, labels: CaseLabels) -> CaseScores:
    kept = lines_kept(notes)
    from_notes = list(notes.from_notes)
    # Every line the AI notes show: an action item or a fact counts wherever it landed.
    shown: list[CitedLine | FromNotesLine] = [*kept, *from_notes]
    flagged = [line for line in kept if line.support == "weak"]
    with_numbers = [line for line in kept if _numbers(line.text)]
    cited_blocks = {ref for line in shown for ref in line.note_refs}
    points = [block for block in sources.note_blocks if not _is_heading(block)]
    missed_notes = [block.text for block in points if block.ref not in cited_blocks]
    texts = [line.text for line in shown]
    missed_items = [
        item for item in labels.action_items if not _any_holds(texts, item.text, item.owner)
    ]
    missed_facts = [fact for fact in labels.facts if not _any_holds(texts, fact, None)]
    return CaseScores(
        dropped=_share(len(notes.dropped), len(kept) + len(from_notes) + len(notes.dropped)),
        flagged=_share(len(flagged), len(kept)),
        from_notes=_share(len(from_notes), len(kept) + len(from_notes)),
        user_note_coverage=_share(len(points) - len(missed_notes), len(points)),
        number_fidelity=_share(
            sum(not line.check.missing_numbers for line in with_numbers), len(with_numbers)
        ),
        action_items=_share(len(labels.action_items) - len(missed_items), len(labels.action_items)),
        facts=_share(len(labels.facts) - len(missed_facts), len(labels.facts)),
        dropped_lines=[DroppedOut(text=line.text, reason=line.reason) for line in notes.dropped],
        flagged_lines=[_flagged(line) for line in flagged],
        missed_notes=missed_notes,
        missed_action_items=missed_items,
        missed_facts=missed_facts,
    )


def _share(count: int, total: int) -> Share:
    return Share(count=count, total=total)


def _flagged(line: CitedLine) -> FlaggedOut:
    return FlaggedOut(
        text=line.text,
        missing_numbers=list(line.check.missing_numbers),
        shares_words=line.check.shares_words,
    )


def _is_heading(block: NoteBlock) -> bool:
    # The marks `render_markdown` writes for a heading node. Never a bare "#": text is not escaped,
    # so the paragraph "#1 risk is the vendor contract" starts with one and is a point.
    return _HEADING_MARKS.match(block.markdown) is not None


def _numbers(text: str) -> tuple[str, ...]:
    """The numbers and letter-digit tokens in `text`, as `citations.py` reads them: checked
    against no source, every one is missing."""
    return check_support(text, ()).missing_numbers


# --- Finding a hand label in the notes ---------------------------------------------------------
# By words and numbers, not by text: models rephrase, and a label is the labeller's own wording.


def _any_holds(lines: Sequence[str], label: str, owner: str | None) -> bool:
    return any(_holds(line, label, owner) for line in lines)


def _holds(line: str, label: str, owner: str | None) -> bool:
    """Does `line` say `label`: under its owner, with every number it names and most of its words?

    An item under the wrong owner is a wrong item, which is what the plan's action-item recall is
    about (see `_gives_to`).
    """
    if owner is not None and not _gives_to(line, owner):
        return False
    tokens = _tokens(line)
    # Normalised on both sides: "50k" in a label is the line's "fifty thousand".
    if check_support(label, [line]).missing_numbers:
        return False
    wanted = _words(_tokens(label))
    if not wanted:
        # Nothing to compare but numbers: found if it named any, all of which matched above.
        return bool(_numbers(label))
    have = _words(tokens)
    hits = sum(any(_same_word(word, other) for other in have) for word in wanted)
    return hits / len(wanted) >= LABEL_WORD_SHARE


def _gives_to(line: str, owner: str) -> bool:
    """Does `line` give its item to `owner`? The prompt writes one as "Owner: what, by when", so
    the owner is named before the first colon ("Priya and Sam: ..."); a line with no such colon
    must open with the owner ("Priya will share ...").

    Never a name anywhere in the line: "Me" and "Them" are owners and everyday objects too, and
    "Them: send me the contract" is Them's item, not mine.
    """
    wanted = _tokens(owner)
    owner_part, *rest = _OWNER_END.split(line, maxsplit=1)
    if rest:
        return set(wanted) <= set(_tokens(owner_part))
    return _tokens(line)[: len(wanted)] == wanted


def _tokens(text: str) -> list[str]:
    return _TOKEN.findall(text.casefold())


def _words(tokens: Sequence[str]) -> list[str]:
    return [token for token in tokens if token not in _FILLER and not _DIGIT.search(token)]


def _same_word(word: str, other: str) -> bool:
    if len(word) < _WHOLE_WORD_BELOW or len(other) < _WHOLE_WORD_BELOW:
        return word == other
    length = min(_STEM_CHARS, len(word), len(other))
    return word[:length] == other[:length]
