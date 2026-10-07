"""Checks every AI notes line against the transcript lines and note blocks it cites.

The prompt numbers transcript lines `L1..Ln` and the user's note blocks `N1..Nk` from one
`RefMap`, and the model ends each bullet with refs (`notes_protocol.py` parses them). Then, per
line (M4 plan, "Lines without support", D4 and D7):

- refs the map does not hold are removed;
- a line left with no valid ref is dropped, with a reason, and listed under "Removed lines";
- a line whose valid refs are all `N` goes to the closing "From your notes" list, with no chips;
- any other line is kept with one citation per `L` ref, and flagged `weak` ("check this") when it
  holds a number that none of its cited lines and blocks hold, or shares no content word with them.

Numbers are normalised on both sides before they are compared: "fifty thousand", "50k", "$50,000"
and "50 thousand" are all 50000; "$2.5m" and "two and a half million" are 2500000; "12%" is "12
percent"; "6th" and "sixth" are 6; "9:00" is 9. Tokens that mix letters and digits (`Q3`, `H1`,
`v2`) compare whole, never as bare digits. Raw digit matching would flag correct lines and push
past the plan's 10% flagged target.
"""

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal
from uuid import UUID

from roger_api.services.notes_protocol import Bullet, Ref

type Support = Literal["ok", "weak"]
# `no_refs`: the line cited nothing. `unknown_refs`: every ref it cited points nowhere.
type DropReason = Literal["no_refs", "unknown_refs"]


@dataclass(frozen=True, slots=True)
class SourceLine:
    """A transcript line the notes may cite."""

    segment_id: UUID
    start_ms: int
    speaker: str
    text: str


@dataclass(frozen=True, slots=True)
class Citation:
    """One `L` ref, resolved: the shape of each entry in the `item` SSE event's `citations`."""

    ref: str
    segment_id: UUID
    start_ms: int


@dataclass(frozen=True, slots=True)
class RefMap:
    """`L1..Ln` are `lines` in transcript order; `N1..Nk` are `note_blocks` in the user's order.

    `notes_prompt.py` numbers the sources it shows the model from this same map, so a ref in the
    output means exactly what the map says. Build the map once per run and use it for both.
    """

    lines: tuple[SourceLine, ...]
    note_blocks: tuple[str, ...]

    def has(self, ref: Ref) -> bool:
        count = len(self.lines) if ref.kind == "L" else len(self.note_blocks)
        return 1 <= ref.number <= count

    def text(self, ref: Ref) -> str:
        self._require(ref)
        if ref.kind == "L":
            return self.lines[ref.number - 1].text
        return self.note_blocks[ref.number - 1]

    def citation(self, ref: Ref) -> Citation:
        if ref.kind != "L":
            raise LookupError(f"{ref} is a note block; only transcript lines have a segment")
        self._require(ref)
        line = self.lines[ref.number - 1]
        return Citation(ref=str(ref), segment_id=line.segment_id, start_ms=line.start_ms)

    def to_json(self) -> dict[str, str]:
        """Each `L` ref and its segment id, as stored on the run.

        `N` refs index the user's notes at the run's `user_notes_version`, so they need no entry.
        """
        return {
            str(Ref("L", number)): str(line.segment_id)
            for number, line in enumerate(self.lines, start=1)
        }

    def _require(self, ref: Ref) -> None:
        if not self.has(ref):
            raise LookupError(
                f"{ref} is not in the ref map "
                f"({len(self.lines)} lines, {len(self.note_blocks)} note blocks)"
            )


@dataclass(frozen=True, slots=True)
class SupportCheck:
    """`missing_numbers`: numbers (normalised, like `50000`) and letter-digit tokens (`q3`) in the
    line that no cited source holds. `shares_words`: the line and its sources share a content
    word, or the line has none to compare."""

    missing_numbers: tuple[str, ...]
    shares_words: bool

    @property
    def support(self) -> Support:
        return "ok" if not self.missing_numbers and self.shares_words else "weak"


@dataclass(frozen=True, slots=True)
class CitedLine:
    """A kept line: citations in transcript order, plus the note blocks it also cited."""

    text: str
    citations: tuple[Citation, ...]
    note_refs: tuple[str, ...]
    check: SupportCheck

    @property
    def support(self) -> Support:
        return self.check.support


@dataclass(frozen=True, slots=True)
class FromNotesLine:
    """A line only the user's notes back: it goes to "From your notes", with no chips (D7)."""

    text: str
    note_refs: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class DroppedLine:
    text: str
    reason: DropReason


type CheckedLine = CitedLine | FromNotesLine | DroppedLine


def check_line(bullet: Bullet, refs: RefMap) -> CheckedLine:
    """Keep, move to "From your notes" or drop one parsed bullet (see the module docstring)."""
    if not bullet.refs:
        return DroppedLine(bullet.text, reason="no_refs")
    valid = [ref for ref in bullet.refs if refs.has(ref)]
    if not valid:
        return DroppedLine(bullet.text, reason="unknown_refs")
    note_refs = tuple(str(ref) for ref in valid if ref.kind == "N")
    line_refs = sorted((ref for ref in valid if ref.kind == "L"), key=lambda ref: ref.number)
    if not line_refs:
        return FromNotesLine(bullet.text, note_refs=note_refs)
    return CitedLine(
        bullet.text,
        citations=tuple(refs.citation(ref) for ref in line_refs),
        note_refs=note_refs,
        check=check_support(bullet.text, [refs.text(ref) for ref in valid]),
    )


def check_support(claim: str, sources: Iterable[str]) -> SupportCheck:
    """Does `claim` hold only numbers its `sources` hold, and share a content word with them?"""
    claimed = _scan(claim)
    found: set[_Fact] = set()
    words: set[str] = set()
    for source in sources:
        scanned = _scan(source)
        found.update(scanned.facts, scanned.loose_numbers)
        words.update(scanned.words)
    missing = (_format_fact(fact) for fact in claimed.facts if fact not in found)
    return SupportCheck(
        missing_numbers=tuple(dict.fromkeys(missing)),
        shares_words=not claimed.words or not claimed.words.isdisjoint(words),
    )


# Below: scanning a text into its numbers, letter-digit tokens and content words.

# A number (`Decimal`, so 1.2m is exactly 1200000) or a letter-digit token compared whole (`q3`).
type _Fact = Decimal | str


@dataclass(frozen=True, slots=True)
class _Scanned:
    facts: tuple[_Fact, ...]
    # "one", "first", "second" and "third" on their own: as often words ("no one", "first, we...",
    # "a second option", "third-party") as numbers. A line is never flagged for them, but in a
    # source they still back a digit ("our next one on one" backs "1:1").
    loose_numbers: tuple[Decimal, ...]
    words: frozenset[str]


def _numbered(words: str, first: int, step: int = 1) -> dict[str, int]:
    return {word: first + position * step for position, word in enumerate(words.split())}


_UNITS = _numbered("zero one two three four five six seven eight nine", 0)
_TEENS = _numbered(
    "ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen", 10
)
_TENS = _numbered("twenty thirty forty fifty sixty seventy eighty ninety", 20, step=10)
# "first".."ninth" can end a compound ("twenty first"); the rest stand alone.
_ORDINAL_UNITS = _numbered("first second third fourth fifth sixth seventh eighth ninth", 1)
_ORDINALS_OF_TEENS_AND_TENS = _numbered(
    "tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth "
    "nineteenth",
    10,
) | _numbered(
    "twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth", 20, step=10
)
_SCALES = {"thousand": 1_000, "million": 1_000_000, "billion": 10**9, "trillion": 10**12}
# A scale word after digits multiplies them: "50 thousand", "1.2 million", "2 hundred".
_DIGIT_SCALES = {"hundred": 100, **_SCALES}
_AMBIGUOUS_NUMBER_WORDS = frozenset({"one", "first", "second", "third"})
# What may follow "and" inside a number: "two hundred and fifty", "a hundred and first".
_AFTER_AND = frozenset([*_UNITS, *_TEENS, *_TENS, *_ORDINAL_UNITS, *_ORDINALS_OF_TEENS_AND_TENS])
# After a number, in words or digits: "two and a half million", "2 and a half hours".
_AND_A_HALF = ["and", "a", "half"]
_HALF = Decimal("0.5")

_PLAIN_NUMBER = re.compile(r"[0-9]+(?:\.[0-9]+)?")
# 50k, 1.2m, 3b or 3bn (magnitudes); 6th, 21st (ordinals); 3pm (times).
_SUFFIXED_NUMBER = re.compile(r"([0-9]+(?:\.[0-9]+)?)(k|m|bn?|st|nd|rd|th|am|pm)")
_SUFFIX_SCALES = {"k": 1_000, "m": 1_000_000, "b": 10**9, "bn": 10**9}
_DIGIT = re.compile(r"[0-9]")
_THOUSANDS = re.compile(r"(?<![0-9.,])[0-9]{1,3}(?:,[0-9]{3})+(?![0-9])")
_CURRENCY = re.compile(r"[$€£¥]")
# A time on the hour loses its minutes: "9:00" is 9 and "3:00pm" is 3pm. Kept, the ":00" would be
# a bare 0 that no source holds ("at nine", "at 9"), and every time on the hour would be flagged.
_ON_THE_HOUR = re.compile(r"(?<=[0-9]):00(?![0-9])")
# Letters and digits, joined by inner points or apostrophes ("1.5", "v2.1", "o'brien").
# Hyphens, slashes and colons split: "twenty-five", "10/6" and "10:30" are two tokens each
# (`_ON_THE_HOUR` has already taken the ":00" out of "9:00").
_TOKEN = re.compile(r"[^\W_]+(?:[.'][^\W_]+)*")
_CONTRACTIONS = [
    (re.compile(r"\bwon't\b"), "will not"),
    (re.compile(r"\bcan't\b"), "can not"),
    (re.compile(r"n't\b"), " not"),
    (re.compile(r"'ll\b"), " will"),
    (re.compile(r"'re\b"), " are"),
    (re.compile(r"'ve\b"), " have"),
    (re.compile(r"'m\b"), " am"),
    (re.compile(r"'d\b"), " would"),
    (re.compile(r"'s\b"), ""),
]

# Words that carry no content of their own. Only the word check reads this.
_WORDS_WITHOUT_CONTENT = """
    a about above after again against all also am an and any are as at be because been before
    being below between both but by can could did do does doing done down during each few for
    from further get gets getting got had has have having he her here hers herself him himself
    his how i if in into is it its itself just let lets like me more most my myself no nor not
    now of off on once only or other our ours ourselves out over own same she should so some
    such than that the their theirs them themselves then there these they this those through to
    too under until up us very was we were what when where which while who whom why will with
    would yes yeah you your yours yourself yourselves okay ok sure um uh hmm oh well really
    maybe percent per cent going gonna want wants need needs think said say says
"""
_STOPWORDS = frozenset(_WORDS_WITHOUT_CONTENT.split())


def _scan(text: str) -> _Scanned:
    tokens = _tokens(text)
    facts: list[_Fact] = []
    loose: list[Decimal] = []
    words: set[str] = set()
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1
        if _PLAIN_NUMBER.fullmatch(token):
            value = Decimal(token)
            if tokens[index : index + 3] == _AND_A_HALF:
                value, index = value + _HALF, index + 3
            if index < len(tokens) and tokens[index] in _DIGIT_SCALES:
                value *= _DIGIT_SCALES[tokens[index]]
                index += 1
            facts.append(value)
        elif suffixed := _SUFFIXED_NUMBER.fullmatch(token):
            digits, suffix = suffixed.groups()
            facts.append(Decimal(digits) * _SUFFIX_SCALES.get(suffix, 1))
        elif _DIGIT.search(token):
            facts.append(token)
        elif spelled := _read_spelled_number(tokens, index - 1):
            value, index, ambiguous = spelled
            (loose if ambiguous else facts).append(value)
        elif len(token) > 1 and token not in _STOPWORDS:
            words.add(_stem(token))
    return _Scanned(facts=tuple(facts), loose_numbers=tuple(loose), words=frozenset(words))


def _tokens(text: str) -> list[str]:
    # `_plain` in evals/notes_score.py copies this NFKC and apostrophe rule so that an owner label
    # tokenises like the line it is matched against: change the two together.
    # NFKC turns full-width digits and superscripts into ASCII digits; curly apostrophes are not
    # touched by it, so they are straightened by hand before contractions expand.
    normal = (
        unicodedata.normalize("NFKC", text).lower().replace("\u2019", "'").replace("\u2018", "'")
    )
    for pattern, replacement in _CONTRACTIONS:
        normal = pattern.sub(replacement, normal)
    normal = _ON_THE_HOUR.sub("", normal)
    normal = _THOUSANDS.sub(lambda match: match.group(0).replace(",", ""), normal)
    normal = _CURRENCY.sub(" ", normal.replace("%", " percent "))
    return _TOKEN.findall(normal)


type _NumberWordState = Literal["start", "unit", "teen", "ten", "hundred", "scale"]


def _read_spelled_number(tokens: list[str], start: int) -> tuple[Decimal, int, bool] | None:
    """The spelled number at `tokens[start]`: (value, index after it, ambiguous), or None.

    Reads one number and stops where the words stop combining: "two three" is 2, then 3;
    "twenty five" is 25; "three thousand five hundred" is 3500; "two point five" and "two and a
    half" are 2.5; "half a million" is 500000.
    """
    total = Decimal(0)
    group = 0
    state: _NumberWordState = "start"
    ceiling: int | None = None  # The last scale used: "two million three thousand" goes down.
    index = start
    # "half a million" is read here, before its "a million" could be read as 1000000.
    if tokens[start : start + 2] == ["half", "a"] and _is_scale(tokens, start + 2):
        return Decimal(_SCALES[tokens[start + 2]]) / 2, start + 3, False
    if (
        tokens[start] == "a" and start + 1 < len(tokens) and tokens[start + 1] in _DIGIT_SCALES
    ):  # "a hundred", "a million"
        group, state, index = 1, "unit", start + 1
    while index < len(tokens):
        word = tokens[index]
        after_whole_part = state in ("start", "hundred", "scale")
        if word in _UNITS and (after_whole_part or state == "ten"):
            group, state = group + _UNITS[word], "unit"
        elif word in _TEENS and after_whole_part:
            group, state = group + _TEENS[word], "teen"
        elif word in _TENS and after_whole_part:
            group, state = group + _TENS[word], "ten"
        elif word in _ORDINAL_UNITS and (after_whole_part or state == "ten"):
            return total + group + _ORDINAL_UNITS[word], index + 1, _alone(tokens, start, index)
        elif word in _ORDINALS_OF_TEENS_AND_TENS and after_whole_part:
            value = total + group + _ORDINALS_OF_TEENS_AND_TENS[word]
            return value, index + 1, False
        elif word == "hundred" and state in ("unit", "teen", "ten") and group < 100:
            group, state = group * 100, "hundred"
        elif (
            word in _SCALES
            and state in ("unit", "teen", "ten", "hundred")
            and (ceiling is None or _SCALES[word] < ceiling)
        ):
            total += group * _SCALES[word]
            group, state, ceiling = 0, "scale", _SCALES[word]
        elif (
            word == "and"
            and state in ("hundred", "scale")
            and index + 1 < len(tokens)
            and tokens[index + 1] in _AFTER_AND
        ):
            pass  # "two hundred and fifty"
        elif word == "point" and state != "start" and _is_unit(tokens, index + 1):
            return _read_decimal_part(tokens, index + 1, total + group, ceiling)
        elif state != "start" and tokens[index : index + 3] == _AND_A_HALF:
            if state == "scale" and ceiling is not None:  # "a million and a half"
                return total + Decimal(ceiling) / 2, index + 3, False
            return _scaled(tokens, index + 3, total + group + _HALF, ceiling)
        else:
            break
        index += 1
    if state == "start":
        return None
    return total + group, index, _alone(tokens, start, index - 1)


def _read_decimal_part(
    tokens: list[str], start: int, whole: Decimal, ceiling: int | None
) -> tuple[Decimal, int, bool]:
    """ "point two five" after `whole`, then an optional scale: "one point two million"."""
    index = start
    digits = ""
    while _is_unit(tokens, index):
        digits += str(_UNITS[tokens[index]])
        index += 1
    return _scaled(tokens, index, whole + Decimal(f"0.{digits}"), ceiling)


def _scaled(
    tokens: list[str], index: int, value: Decimal, ceiling: int | None
) -> tuple[Decimal, int, bool]:
    """`value` times the scale word at `tokens[index]`, if any: "two and a half million".

    Only when the number has no scale yet: "two million three point five" stops at 3.5.
    """
    if ceiling is None and _is_scale(tokens, index):
        return value * _SCALES[tokens[index]], index + 1, False
    return value, index, False


def _alone(tokens: list[str], start: int, last: int) -> bool:
    return start == last and tokens[start] in _AMBIGUOUS_NUMBER_WORDS


def _is_unit(tokens: list[str], index: int) -> bool:
    return index < len(tokens) and tokens[index] in _UNITS


def _is_scale(tokens: list[str], index: int) -> bool:
    return index < len(tokens) and tokens[index] in _SCALES


def _stem(word: str) -> str:
    """A crude stem, so "ships", "shipped" and "shipping" share "ship" and "price" and "pricing"
    share "pric". Both sides go through it; it only has to agree with itself."""
    plural = ""
    if word.endswith("es") and len(word) >= 5:
        word, plural = word[:-2], "es"
    elif word.endswith("s") and len(word) >= 4 and not word.endswith(("ss", "us", "is")):
        word, plural = word[:-1], "s"
    verb = ""
    if word.endswith("ing") and len(word) >= 6:
        word, verb = word[:-3], "ing"
    elif word.endswith("ed") and len(word) >= 5:
        word, verb = word[:-2], "ed"
    # "agree", "agreed", "agrees" and "agreeing" all become "agre": a final e goes, unless "es" or
    # "ed" already took it.
    if plural != "es" and verb != "ed" and word.endswith("e") and len(word) >= 4:
        word = word[:-1]
    # "shipp" (from "shipped") becomes "ship"; "call" and "pass" keep their double letters.
    if len(word) >= 4 and word[-1] == word[-2] and word[-1] not in "aeiouls":
        word = word[:-1]
    return word


def _format_fact(fact: _Fact) -> str:
    return fact if isinstance(fact, str) else format(fact.normalize(), "f")
