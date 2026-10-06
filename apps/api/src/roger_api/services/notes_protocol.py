"""The line protocol the notes model writes, parsed one finished line at a time as it streams.

The model writes `## Heading` lines and `- bullet text [L12, L15]` lines. `L` refs are numbered
transcript lines and `N` refs are the user's note blocks (`notes_prompt.py` numbers both;
`citations.py` checks them). A finished line can be validated and shown at once, where half a JSON
object cannot (M4 plan, "What the model writes"). If the eval's dropped rate goes over 5%, the
plan switches to strict JSON output: only this module changes.

The parser is lenient about form (other bullet markers, a missing dash, refs mid-line, ranges
written `L12-15`) and strict about content: a ref group is taken only when every entry in the
brackets is a ref, so `[TBD]` or `[sic]` stay in the text. It never decides whether a line is
kept; a bullet with no refs comes out with `refs == ()` for `citations.py` to drop.
"""

import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from typing import Literal

# The prompt asks for at most this many refs per bullet; the parser keeps the first ones written.
MAX_REFS_PER_LINE = 8

type RefKind = Literal["L", "N"]


@dataclass(frozen=True, slots=True)
class Ref:
    """`L12` (transcript line 12) or `N2` (the user's note block 2), numbered from 1."""

    kind: RefKind
    number: int

    def __str__(self) -> str:
        return f"{self.kind}{self.number}"


@dataclass(frozen=True, slots=True)
class Heading:
    text: str


@dataclass(frozen=True, slots=True)
class Bullet:
    """A bullet's text with its ref groups taken out, and its refs in the order written."""

    text: str
    refs: tuple[Ref, ...]


type ProtocolLine = Heading | Bullet

# Every pattern runs on text whose whitespace is already collapsed to single spaces (`_squash`),
# so each optional space is ` ?`, never `\s*`. With `\s*` a long run of spaces from the model makes
# the scan quadratic. Numbers stop at 6 digits: no call has a million lines.
# A range dash: hyphen, en dash or em dash.
_DASH = r"[-\u2013\u2014]"
_REF = rf"[LN]\d{{1,6}}(?: ?{_DASH} ?[LN]?\d{{1,6}})?"
_REF_GROUP = re.compile(rf" ?\[ ?({_REF}(?: ?[,;] ?{_REF})*) ?\]", re.IGNORECASE)
_REF_TOKEN = re.compile(rf"([LN])(\d+)(?: ?{_DASH} ?([LN])?(\d+))?", re.IGNORECASE)
_REF_SEPARATOR = re.compile(r" ?[,;] ?")
_HEADING = re.compile(r"#{1,6} (.*)")
# `-`, `*`, `+`, `•` or `1.` / `1)`, then an optional task box (`[ ]`, `[x]`) models add to actions.
_BULLET = re.compile(r"(?:[-*+•]|\d{1,3}[.)]) (?:\[[ xX]\] )?(.*)")
_FENCES = ("```", "~~~")


class LineProtocolParser:
    """Feed streamed text with `feed`; each call returns the lines its newlines finished.

    Call `finish` once the stream ends, for a last line that has no newline. The items are the
    same for any split of the text into chunks.
    """

    def __init__(self) -> None:
        self._partial: list[str] = []

    def feed(self, chunk: str) -> list[ProtocolLine]:
        if "\n" not in chunk:
            # Kept as pieces and joined once: re-joining on every delta is quadratic on a long line.
            self._partial.append(chunk)
            return []
        first, *middle, last = chunk.split("\n")
        finished = ["".join([*self._partial, first]), *middle]
        self._partial = [last]
        return _parse_all(finished)

    def finish(self) -> list[ProtocolLine]:
        rest = "".join(self._partial)
        self._partial = []
        return _parse_all([rest])


def parse_line(raw: str) -> ProtocolLine | None:
    """One line of model output, or None for a blank line, a code fence or text with no refs.

    Text with no bullet marker and no refs (a preamble such as "Here are your notes:", a closing
    remark) is not a note line and is skipped. Text with refs but no marker is a bullet whose dash
    the model forgot.
    """
    line = _squash(raw)
    if not line or line.startswith(_FENCES):
        return None
    if heading := _HEADING.fullmatch(line):
        text, _ = split_refs(heading.group(1))
        return Heading(text) if text else None
    if marked := _BULLET.fullmatch(line):
        text, refs = split_refs(marked.group(1))
        return Bullet(text, refs) if text else None
    text, refs = split_refs(line)
    return Bullet(text, refs) if text and refs else None


def split_refs(text: str) -> tuple[str, tuple[Ref, ...]]:
    """Take every ref group out of `text`: the cleaned text, then the refs in the order written.

    Ranges expand (`L12-L15` is four refs), repeats count once, and refs past
    `MAX_REFS_PER_LINE` are left out.
    """
    groups: list[str] = []

    def take(match: re.Match[str]) -> str:
        groups.append(match.group(1))
        return ""

    remaining = _REF_GROUP.sub(take, _squash(text))
    return _squash(remaining), _first_unique(_expand(groups), MAX_REFS_PER_LINE)


def _parse_all(lines: Iterable[str]) -> list[ProtocolLine]:
    return [parsed for line in lines if (parsed := parse_line(line)) is not None]


def _squash(text: str) -> str:
    return " ".join(text.split())


def _expand(groups: Iterable[str]) -> Iterator[Ref]:
    for group in groups:
        for token in _REF_SEPARATOR.split(group):
            match = _REF_TOKEN.fullmatch(token)
            if match is None:  # `_REF_GROUP` admits only ref tokens; a mismatch is a bug here.
                raise ValueError(f"Ref token {token!r} does not match the ref pattern")
            kind, start, end_kind, end = match.groups()
            if end is None:
                yield Ref(_kind(kind), int(start))
            elif end_kind is not None and end_kind.upper() != kind.upper():
                # `L3-N5` is not a range; keep both ends rather than guess.
                yield Ref(_kind(kind), int(start))
                yield Ref(_kind(end_kind), int(end))
            else:
                low, high = sorted((int(start), int(end)))
                # `range` is lazy, so `L1-L999999` costs only the refs the cap lets through.
                yield from (Ref(_kind(kind), number) for number in range(low, high + 1))


def _first_unique(refs: Iterator[Ref], limit: int) -> tuple[Ref, ...]:
    seen: dict[Ref, None] = {}
    for ref in refs:
        seen.setdefault(ref)
        if len(seen) == limit:
            break
    return tuple(seen)


def _kind(letter: str) -> RefKind:
    return "L" if letter.upper() == "L" else "N"
