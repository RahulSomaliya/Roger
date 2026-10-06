"""Meeting notes on the wire (M4-T6), and the limits a saved doc must meet.

A meeting has two notes, each a TipTap JSON doc: the user's own notes (`user`) and the AI notes
(`ai`). The API checks that a doc is a `doc`, within the size and depth limits and free of
prototype keys, never every node against the editor's schema: `notes_markdown.py` renders
whatever else a stored doc holds without raising.

The limits mirror `noteDocProblem` in the desktop's `shared/notes.ts` (M4-T13), which refuses a
save over them before it is sent. Count the same way or more leniently, never more strictly: a doc
the desktop saved but the API refuses stays dirty on the Mac and is re-sent forever while the page
says "syncing". Change the two together, with docs/api-contract.md.
"""

import json
import math
import re
from typing import Annotated, Any, Self
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, Field

from roger_api.db.models_notes import MeetingNote
from roger_api.domain import NoteKind
from roger_api.schemas.common import UtcDatetime
from roger_api.services.notes import MeetingNotes

# `MAX_NOTE_DOC_BYTES` in shared/notes.ts: UTF-8 bytes of the compact JSON.
MAX_NOTE_DOC_BYTES = 512 * 1024
# `MAX_NOTE_DOC_DEPTH` in shared/notes.ts, in levels of the doc's tree (see `note_doc_problem`).
MAX_NOTE_DOC_DEPTH = 32

# Keys that reach prototypes when the editor turns doc JSON into DOM attributes
# (GHSA-cp6q-959q-f8rh). Stored docs go back to the editor, so they are refused anywhere in a doc.
_FORBIDDEN_KEYS = ("__proto__", "constructor", "prototype")

# What jsonb cannot hold in a string: U+0000, and a UTF-16 surrogate. Python's JSON parser joins an
# escaped pair into one character, so a surrogate left in a parsed string is an unpaired one.
_UNSTORABLE_CHARACTER = re.compile(r"[\x00\ud800-\udfff]")

# Versions live in a Postgres `integer`.
NoteVersion = Annotated[int, Field(ge=0, le=2_147_483_647)]


def note_doc_problem(doc: object) -> str | None:
    """Why `doc` is not a notes doc the API stores, or None when it is.

    The reason names the rule, never the doc's text, so it can be logged and sent back. Levels are
    counted as `noteDocProblem` counts them: the doc is level 1, and every object or list one level
    below its parent, except a list under a `content` key, which stays on the level of the object
    holding it (so a node is one level below the node holding it). Counting every object and list
    instead refused a bullet list tabbed 7 deep (four containers per list level), and StarterKit
    sinks list items with no cap. Walked with a stack, never by recursion: a body nested thousands
    deep is refused, never a RecursionError. The size is measured last, once the walk has bounded
    what `json.dumps` recurses through.
    """
    if not isinstance(doc, dict) or doc.get("type") != "doc":
        return "not a TipTap doc"
    stack: list[tuple[object, int]] = [(doc, 1)]
    while stack:
        value, level = stack.pop()
        if value is None or isinstance(value, str | int):  # bool is an int
            continue
        if isinstance(value, float) and math.isfinite(value):
            continue
        # NaN and Infinity end up here: Python's JSON parser reads them, but JSON itself, the
        # desktop and jsonb never carry them.
        if not isinstance(value, dict | list):
            return "holds a value JSON cannot carry"
        if level > MAX_NOTE_DOC_DEPTH:
            return f"nested deeper than {MAX_NOTE_DOC_DEPTH} levels"
        if isinstance(value, list):
            stack.extend((child, level + 1) for child in value)
            continue
        # Keys as `storable_doc` stores them. Checked only as sent, "__proto\u0000__" was stored
        # as a "__proto__" key, and "type\u0000" beside "type" as one key, losing a value.
        keys = {_storable_text(key) for key in value}
        if len(keys) < len(value):
            return "holds two keys that are one key once stored"
        forbidden = next((key for key in _FORBIDDEN_KEYS if key in keys), None)
        if forbidden is not None:
            return f'holds a "{forbidden}" key'
        # Any `content` key, not only a node's, as the desktop counts it. Still bounded: every
        # object costs a level, so the JSON nests at most twice MAX_NOTE_DOC_DEPTH.
        for key, child in value.items():
            free = key == "content" and isinstance(child, list)
            stack.append((child, level if free else level + 1))
    # `JSON.stringify`'s length for everything a doc holds (strings, whole numbers, booleans):
    # compact separators, and characters as they are, not as \u escapes. An unpaired surrogate,
    # which plain UTF-8 cannot encode, counts 3 bytes, as the U+FFFD stored for it
    # (`storable_doc`); JSON.stringify writes it as a 6-byte escape, so this stays more lenient.
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    size = len(text.encode("utf-8", "surrogatepass"))
    if size > MAX_NOTE_DOC_BYTES:
        return f"larger than {MAX_NOTE_DOC_BYTES} bytes"
    return None


def storable_doc(doc: dict[str, Any]) -> dict[str, Any]:
    """A copy of `doc` that jsonb can hold: every U+0000 dropped and every unpaired surrogate
    replaced by U+FFFD, in keys and values alike. Call it only on a doc `note_doc_problem` passed:
    it bounds the recursion, and it checks the keys as this stores them, so no key becomes a
    forbidden one here and no two keys of an object become one (which would drop a value).

    Postgres refuses either one in jsonb, so a doc stored as sent was a 500. The desktop's
    `noteDocProblem` lets both through (a pasted NUL, half an emoji), and refusing them would leave
    a character nobody can see holding the note dirty on the Mac forever. Neither is text anyone
    reads, so the API stores the doc without them and answers with the doc as stored. Every other
    writer of a notes doc (the AI doc built from model text, M4-T8) passes it through here too.
    """
    return {_storable_text(key): _storable_value(value) for key, value in doc.items()}


def _storable_value(value: object) -> object:
    if isinstance(value, str):
        return _storable_text(value)
    if isinstance(value, list):
        return [_storable_value(child) for child in value]
    if isinstance(value, dict):
        return storable_doc(value)
    return value


def _storable_text(text: str) -> str:
    return _UNSTORABLE_CHARACTER.sub(
        lambda match: "" if match.group() == "\x00" else "\ufffd", text
    )


def _a_storable_doc(doc: object) -> dict[str, Any]:
    if not isinstance(doc, dict):
        raise ValueError("Doc is not a TipTap doc")
    problem = note_doc_problem(doc)
    if problem is not None:
        raise ValueError(f"Doc {problem}")
    return storable_doc(doc)


# Checked before pydantic reads it as a dict, so a list or a string says "not a TipTap doc" too.
# What the route stores is `storable_doc` of what was sent.
NoteDoc = Annotated[dict[str, Any], BeforeValidator(_a_storable_doc)]


class NoteSave(BaseModel):
    """`PUT /v1/meetings/{id}/notes/{kind}`: one whole doc, and the version it builds on."""

    doc: NoteDoc
    # The stored version this doc was edited from; 0 creates the note.
    base_version: NoteVersion
    # The client's id for this save: the same id again is a re-send of it.
    revision_id: UUID


class NoteOut(BaseModel):
    """`Note` in docs/api-contract.md: one doc as stored."""

    kind: NoteKind
    doc: dict[str, Any]
    version: int
    template_id: str | None
    last_run_id: UUID | None
    generated_version: int | None
    updated_at: UtcDatetime

    @classmethod
    def from_row(cls, note: MeetingNote) -> Self:
        return cls(
            kind=note.kind,
            doc=note.doc,
            version=note.version,
            template_id=note.template_id,
            last_run_id=note.last_run_id,
            generated_version=note.generated_version,
            updated_at=note.updated_at,
        )


class MeetingNotesOut(BaseModel):
    """Both notes of a meeting; null where that doc was never saved."""

    user: NoteOut | None
    ai: NoteOut | None

    @classmethod
    def from_notes(cls, notes: MeetingNotes) -> Self:
        return cls(
            user=None if notes.user is None else NoteOut.from_row(notes.user),
            ai=None if notes.ai is None else NoteOut.from_row(notes.ai),
        )
