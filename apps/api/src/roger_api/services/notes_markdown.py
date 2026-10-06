"""TipTap notes docs as Markdown, for MCP's `get_notes`, the notes prompt and chat.

Models and people read this as raw text; nothing turns it into HTML. So text is never escaped (a
backslash before every `*` would reach the prompt and the citation checks), and a hard break or a
second paragraph in a list item is a plain newline.

The renderer never raises on a doc Postgres accepted. `PUT /notes` checks a doc's shape, size and
depth (32 levels, which bounds the recursion here), not every node and attr, and one odd node must
not take `get_notes` or chat down for the whole meeting: an unknown node keeps its text, an
unknown mark is dropped, and anything in `content` that is not an object is skipped.
"""

import re
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, replace
from itertools import groupby

from roger_api.services.transcript_render import format_offset

# The heading the AI doc builder (notes_generation.py) writes above the lines only the user's notes
# back (M4 D7). The builder must import it from here, never retype it: `render_ai_notes` splits on
# it, and a heading that drifts folds the list into the last AI section of `get_notes`.
FROM_YOUR_NOTES_HEADING = "From your notes"

_INLINE_TYPES = frozenset({"text", "hardBreak", "citation"})

# Innermost first. Code is handled before these, and a link wraps them all.
_MARK_DELIMITERS = (("strike", "~~"), ("italic", "*"), ("bold", "**"))


@dataclass(frozen=True, slots=True)
class AiNotesMarkdown:
    notes: str
    """The AI-written sections."""
    from_your_notes: str
    """Everything under the "From your notes" heading, without it; empty when there is none."""


@dataclass(frozen=True, slots=True)
class NoteBlock:
    """One numbered block of the user's notes, as the notes prompt shows it and a line cites it."""

    ref: str
    """`N1`, `N2`, ... in doc order."""
    markdown: str
    """The block as the prompt shows it: heading marks, list marker and quote marks kept, because
    the user's structure says what matters to them."""
    text: str
    """The content alone. Check a line's numbers against this, never `markdown`: the `3.` of an
    ordered list item is not a number the user wrote."""


def render_markdown(doc: Mapping[str, object]) -> str:
    """Any notes doc as Markdown: the user's notes, or the whole AI doc as chat context."""
    return _render(_node(doc).content)


def render_ai_notes(doc: Mapping[str, object]) -> AiNotesMarkdown:
    """The AI doc with its closing "From your notes" list split off, so MCP can show it apart."""
    nodes = _node(doc).content
    split = _from_your_notes_index(nodes)
    if split is None:
        return AiNotesMarkdown(notes=_render(nodes), from_your_notes="")
    return AiNotesMarkdown(
        notes=_render(nodes[:split]), from_your_notes=_render(nodes[split + 1 :])
    )


def split_note_blocks(doc: Mapping[str, object]) -> tuple[NoteBlock, ...]:
    """The user's notes as numbered blocks: each heading, paragraph, code block and list item.

    Empty blocks and rules take no number, so refs run `N1..Nk` with no gaps. A run stores its ref
    map, so the same doc must always give the same refs: the numbering reads nothing but the doc.
    """
    blocks = (block for block in _walk(_node(doc).content, "", joined=False) if block.numbered)
    return tuple(
        NoteBlock(ref=f"N{number}", markdown=block.markdown, text=block.text)
        for number, block in enumerate(blocks, start=1)
    )


# --- Doc JSON to nodes -------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Mark:
    type: str
    attrs: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class _Node:
    type: str
    attrs: Mapping[str, object]
    content: tuple["_Node", ...]
    text: str
    marks: tuple[_Mark, ...]


def _node(value: Mapping[str, object]) -> _Node:
    marks = (mark for mark in _array(value.get("marks")) if isinstance(mark, Mapping))
    return _Node(
        type=_string(value.get("type")),
        attrs=_object(value.get("attrs")),
        content=tuple(
            _node(child) for child in _array(value.get("content")) if isinstance(child, Mapping)
        ),
        text=_string(value.get("text")),
        marks=tuple(_Mark(_string(mark.get("type")), _object(mark.get("attrs"))) for mark in marks),
    )


def _string(value: object) -> str:
    return value if isinstance(value, str) else ""


def _object(value: object) -> Mapping[str, object]:
    return value if isinstance(value, Mapping) else {}


def _array(value: object) -> list[object]:
    return value if isinstance(value, list) else []


def _whole_number(value: object) -> int | None:
    # `bool` is an `int` in Python; JSON `true` is not a number.
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


# --- Nodes to blocks ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Block:
    lead: str
    """Prefixes the first line: indentation, quote marks, list marker, heading marks."""
    hang: str
    """Prefixes every later line: indentation and quote marks."""
    text: str
    joined: bool
    """Inside a list: one newline from the block before it, not a blank line."""
    numbered: bool = True
    """False for a rule: it is not a point the user made."""

    @property
    def markdown(self) -> str:
        first, *rest = self.text.split("\n")
        later = (self.hang + line if line else self.hang.rstrip() for line in rest)
        return "\n".join([self.lead + first, *later])


def _render(nodes: Sequence[_Node]) -> str:
    out = ""
    for block in _walk(nodes, "", joined=False):
        if out:
            out += "\n" if block.joined else "\n\n"
        out += block.markdown
    return out


def _walk(nodes: Iterable[_Node], hang: str, *, joined: bool) -> Iterator[_Block]:
    """The non-empty blocks of `nodes`, in order. Inline nodes outside a paragraph (in an unknown
    container) read as one paragraph."""
    for is_inline, group in groupby(nodes, key=lambda node: node.type in _INLINE_TYPES):
        if is_inline:
            yield from _text_block(hang, hang, _inline(group), joined=joined)
        else:
            for node in group:
                yield from _walk_node(node, hang, joined=joined)


def _walk_node(node: _Node, hang: str, *, joined: bool) -> Iterator[_Block]:
    match node.type:
        case "paragraph":
            yield from _text_block(hang, hang, _inline(node.content), joined=joined)
        case "heading":
            marks = "#" * _heading_level(node.attrs)
            yield from _text_block(f"{hang}{marks} ", hang, _inline(node.content), joined=joined)
        case "codeBlock":
            code = "".join(child.text for child in node.content)
            if code.strip():
                fence = _fence(code, shortest=3)
                language = _string(node.attrs.get("language"))
                yield _Block(hang, hang, f"{fence}{language}\n{code}\n{fence}", joined)
        case "horizontalRule":
            yield _Block(hang, hang, "---", joined, numbered=False)
        case "blockquote":
            yield from _walk(node.content, f"{hang}> ", joined=joined)
        case "bulletList" | "orderedList":
            yield from _walk_list(node, hang, joined=joined)
        case _:
            # An unknown node keeps its text: its children render as if they stood in its place.
            yield from _walk(node.content, hang, joined=joined)


def _walk_list(node: _Node, hang: str, *, joined: bool) -> Iterator[_Block]:
    number: int | None = None
    if node.type == "orderedList":
        start = _whole_number(node.attrs.get("start"))
        number = 1 if start is None else start
    for item in node.content:
        marker = "- " if number is None else f"{number}. "
        indent = hang + " " * len(marker)
        blocks = list(_walk(item.content, indent, joined=True))
        if blocks:
            first, *rest = blocks
            # The marker goes on the item's first line, which may itself be a heading or a list.
            yield replace(
                first, lead=hang + marker + first.lead.removeprefix(indent), joined=joined
            )
            yield from rest
            joined = True
        if number is not None:
            number += 1


def _text_block(lead: str, hang: str, text: str, *, joined: bool) -> Iterator[_Block]:
    text = text.strip()
    if text:
        yield _Block(lead, hang, text, joined)


def _heading_level(attrs: Mapping[str, object]) -> int:
    level = _whole_number(attrs.get("level"))
    return level if level is not None and 1 <= level <= 6 else 1


# --- Inline content ----------------------------------------------------------------------------


def _inline(nodes: Iterable[_Node]) -> str:
    """Inline nodes as Markdown. A source time is kept one space apart from the words around it."""
    out = ""
    after_source = False
    for node in nodes:
        is_source = node.type == "citation"
        piece = _inline_piece(node)
        if not piece:
            continue
        if (is_source or after_source) and out and not out[-1].isspace() and not piece[0].isspace():
            out += " "
        out += piece
        after_source = is_source
    return out


def _inline_piece(node: _Node) -> str:
    match node.type:
        case "text":
            return _marked(node.text, node.marks)
        case "hardBreak":
            return "\n"
        case "citation":
            return _source_time(node.attrs)
        case _:
            # An unknown inline node keeps its text.
            return _inline(node.content)


def _source_time(attrs: Mapping[str, object]) -> str:
    """A citation chip as the transcript time it points at: `[00:12:03]`.

    `startMs` and `label` are the attrs `citationNode.ts` declares and the builder in
    `notes_generation.py` writes; tests/fixtures/ai_notes_doc.json pins them for both. The time
    comes from `startMs` in `get_transcript`'s own format, so an AI can find the line; `label` is
    the chip's short display ("03:12" has no hours). A chip with no usable `startMs` (PUT does not
    check citation attrs) falls back to that label, which is what the user sees on it.
    """
    start_ms = _whole_number(attrs.get("startMs"))
    if start_ms is not None:
        return f"[{format_offset(start_ms)}]"
    label = _string(attrs.get("label")).strip()
    return f"[{label}]" if label else ""


def _marked(text: str, marks: Sequence[_Mark]) -> str:
    core = text.strip()
    if not core:
        return text
    # Delimiters hug the words: `**on track **` is not bold in Markdown, `**on track** ` is.
    before = text[: len(text) - len(text.lstrip())]
    after = text[len(text.rstrip()) :]
    kinds = {mark.type for mark in marks}
    if "code" in kinds:
        core = _code_span(core)
    for kind, delimiter in _MARK_DELIMITERS:
        if kind in kinds:
            core = f"{delimiter}{core}{delimiter}"
    href = next((_string(mark.attrs.get("href")) for mark in marks if mark.type == "link"), "")
    if href:
        core = f"[{core}]({href})"
    return before + core + after


def _code_span(code: str) -> str:
    fence = _fence(code, shortest=1)
    pad = " " if code.startswith("`") or code.endswith("`") else ""
    return f"{fence}{pad}{code}{pad}{fence}"


def _fence(code: str, *, shortest: int) -> str:
    """A run of backticks longer than any inside `code`, so the code cannot close it early."""
    longest = max((len(run) for run in re.findall(r"`+", code)), default=0)
    return "`" * max(shortest, longest + 1)


def _from_your_notes_index(nodes: Sequence[_Node]) -> int | None:
    """The last top-level "From your notes" heading, matched on its words alone: a user who bolds
    it or changes its level in the editor must not fold the list into the section above."""
    wanted = FROM_YOUR_NOTES_HEADING.casefold()
    for index in range(len(nodes) - 1, -1, -1):
        node = nodes[index]
        if node.type == "heading" and " ".join(_plain(node).split()).casefold() == wanted:
            return index
    return None


def _plain(node: _Node) -> str:
    return node.text + "".join(_plain(child) for child in node.content)
