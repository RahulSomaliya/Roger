"""Notes models with no vendor: `FakeNotesModel` for development, `ScriptedNotesModel` for tests.

`FakeNotesModel` (NOTES_PROVIDER=fake, the default) writes notes from the prompt itself: each
template section gets a few transcript lines as bullets citing them, and each of the user's note
blocks comes back as a bullet citing it. Every line passes the API's citation checks, so a
development run streams, saves and shows working chips with no key and no cost. It reports no
usage, so its runs store a null cost, never 0.

`ScriptedNotesModel` replays what a test writes: text pieces, steps that wait for the test, then
the ending (done with usage, a failure mid-stream, a cut-off) or a refusal at open. Tests of the run
registry, generation and chat (M4-T7, T8, T10) drive their failure paths with it.

Both keep the `NotesModel` contract in notes_model.py.
"""

import asyncio
import re
from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from roger_api.domain import RunKind
from roger_api.errors import LlmProviderError
from roger_api.services.notes_model import ModelDone, ModelEvent, ModelRequest, TextDelta

FAKE_MODEL_ID = "fake"

# Small enough that most lines arrive in several pieces, as from a real model, so the stream
# parsers are exercised in development too.
_PIECE_CHARS = 16
_LINES_PER_SECTION = 3
_LINES_PER_ANSWER = 2
_WORDS_PER_BULLET = 20

# The prompt layouts these read are written by notes_prompt.py: `L17 [00:03:12] Them: text` (its
# `transcript_line`, which chat reuses), `N2 text` for a note block, and `## Heading` lines inside
# the `<template>` fence. Headings are read from the fence only: the rules' format example holds
# `## ` lines too.
_TRANSCRIPT_LINE = re.compile(r"^(L\d+) \[\d{2,}:\d{2}:\d{2}\] [^:\n]+: (.+)$", re.MULTILINE)
_NOTE_BLOCK = re.compile(r"^(N\d+) (.+)$", re.MULTILINE)
_TEMPLATE = re.compile(r"<template>\n(.*?)\n</template>", re.DOTALL)
_HEADING = re.compile(r"^## (.+)$", re.MULTILINE)
# What a note block may start with: heading marks, a list marker, a task box, a quote mark. Left in,
# "- ask about pricing" would come back as the bullet "- - ask about pricing".
_LEADING_MARK = re.compile(r"(?:#{1,6}|[-*+>]|\d{1,3}[.)]|\[[ xX]\]) ")


@dataclass(frozen=True, slots=True)
class _Source:
    ref: str
    text: str


@dataclass(frozen=True, slots=True)
class _PromptSources:
    headings: tuple[str, ...]
    lines: tuple[_Source, ...]
    notes: tuple[_Source, ...]

    @classmethod
    def read(cls, request: ModelRequest) -> "_PromptSources":
        texts = [part.text for message in request.messages for part in message.parts]
        templates = [match for text in texts for match in _TEMPLATE.findall(text)]
        return cls(
            headings=tuple(heading for block in templates for heading in _HEADING.findall(block)),
            lines=tuple(
                _Source(ref, text)
                for chunk in texts
                for ref, text in _TRANSCRIPT_LINE.findall(chunk)
            ),
            notes=tuple(
                _Source(ref, text) for chunk in texts for ref, text in _NOTE_BLOCK.findall(chunk)
            ),
        )


class FakeNotesModel:
    """Writes notes, or a chat answer, from the sources in the prompt (see the module docstring)."""

    def model_id(self, kind: RunKind) -> str:
        return FAKE_MODEL_ID

    @asynccontextmanager
    async def stream(self, request: ModelRequest) -> AsyncIterator[AsyncIterator[ModelEvent]]:
        if request.json_schema is not None:
            raise LlmProviderError(
                "The fake notes model writes no structured output; set NOTES_PROVIDER=openrouter"
            )
        sources = _PromptSources.read(request)
        text = _notes(sources) if request.kind == "notes" else _answer(sources)
        yield _in_pieces(text)


def _notes(sources: _PromptSources) -> str:
    sections = sources.headings or ("",)
    out: list[str] = []
    for heading, lines in zip(sections, _spread(sources.lines, len(sections)), strict=True):
        if heading:
            out.append(f"## {heading}")
        out += [_bullet(line) for line in lines[:_LINES_PER_SECTION]]
    # Bullets that cite only note blocks: the API lists them under "From your notes" (M4 D7).
    out += [_bullet(_Source(note.ref, _unmarked(note.text))) for note in sources.notes]
    return "".join(f"{line}\n" for line in out)


def _answer(sources: _PromptSources) -> str:
    quoted = sources.lines[:_LINES_PER_ANSWER]
    if not quoted:
        return "This meeting has no transcript lines to answer from yet."
    return " ".join(f"{_first_words(line.text)} [{line.ref}]" for line in quoted)


def _spread(lines: tuple[_Source, ...], count: int) -> list[tuple[_Source, ...]]:
    """`lines` cut into `count` runs in order, as even as they go."""
    size = len(lines)
    return [lines[size * index // count : size * (index + 1) // count] for index in range(count)]


def _bullet(source: _Source) -> str:
    return f"- {_first_words(source.text)} [{source.ref}]"


def _first_words(text: str) -> str:
    return " ".join(text.split()[:_WORDS_PER_BULLET])


def _unmarked(text: str) -> str:
    while mark := _LEADING_MARK.match(text):
        text = text[mark.end() :]
    return text


async def _in_pieces(text: str) -> AsyncIterator[ModelEvent]:
    for start in range(0, len(text), _PIECE_CHARS):
        # A network read hands the loop over between pieces; so does this, so a cancel or a second
        # subscriber gets its turn mid-answer as it would with a real model.
        await asyncio.sleep(0)
        yield TextDelta(text[start : start + _PIECE_CHARS])
    yield ModelDone(usage=None)


# A text piece, or an event the stream waits on before its next step (`await event.wait()`), so a
# test can hold a run mid-answer.
type ScriptStep = str | asyncio.Event

_DONE = ModelDone(usage=None)


@dataclass(frozen=True, slots=True)
class ModelScript:
    """One stream of a `ScriptedNotesModel`."""

    steps: tuple[ScriptStep, ...] = ()
    # `ModelDone` (with the usage to report) ends the stream normally. An exception is raised after
    # the steps: `LlmProviderError` for a failure mid-stream, `ModelCutOffError` for a cut-off.
    end: ModelDone | Exception = _DONE
    # Raised when the stream is opened, before any step: a refusal (the 502 envelope's case).
    refuse: LlmProviderError | None = None


class ScriptedNotesModel:
    """Plays one `ModelScript` per `stream` call, in order, and records each request."""

    def __init__(self, *scripts: ModelScript, model_id: str = "scripted") -> None:
        self._scripts = deque(scripts)
        self._model_id = model_id
        self.requests: list[ModelRequest] = []
        # Streams opened and not yet closed: 0 after a cancel proves the model was stopped.
        self.open_streams = 0

    def model_id(self, kind: RunKind) -> str:
        return self._model_id

    @asynccontextmanager
    async def stream(self, request: ModelRequest) -> AsyncIterator[AsyncIterator[ModelEvent]]:
        self.requests.append(request)
        if not self._scripts:
            raise LookupError(
                f"ScriptedNotesModel has no script left for request {len(self.requests)}"
            )
        script = self._scripts.popleft()
        if script.refuse is not None:
            raise script.refuse
        self.open_streams += 1
        try:
            yield _play(script)
        finally:
            self.open_streams -= 1


async def _play(script: ModelScript) -> AsyncIterator[ModelEvent]:
    for step in script.steps:
        if isinstance(step, asyncio.Event):
            await step.wait()
        else:
            yield TextDelta(step)
    if isinstance(script.end, ModelDone):
        yield script.end
    else:
        raise script.end
