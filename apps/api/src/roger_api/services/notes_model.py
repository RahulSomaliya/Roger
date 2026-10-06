"""`NotesModel`: how the API asks a language model for notes or a chat answer (house rule 4).

Callers (the run registry M4-T7, notes generation M4-T8, chat M4-T10, the eval M4-T12) never name a
vendor. They build a `ModelRequest`, open a stream and read its events:

    async with notes_model.stream(request) as events:  # LlmProviderError: refused, nothing sent
        async for event in events:
            match event:
                case TextDelta(text=text): ...
                case ModelDone(usage=usage): ...

Every adapter keeps this contract, the fakes too, so a test through a fake means something:
- Entering `stream` sends the request. A vendor that refuses it or cannot be reached raises
  `LlmProviderError` there, before any event: the one case that can still answer with the
  `502 llm_provider_error` envelope instead of a `200` stream.
- Then `TextDelta`s of answer text, in order, and exactly one `ModelDone` last. Reasoning is never
  answer text.
- A failure after the stream started raises `LlmProviderError` from the iteration: by then the
  `200` is sent, so it becomes an `error` event. An answer stopped by the output limit raises
  `ModelCutOffError` after its text: the run fails as `cut_off` and keeps the previous AI notes.
- Leaving the `async with`, normally, by an exception or by cancelling the task that reads it,
  closes the connection, which stops the model (and, where the provider supports it, its billing).

Settings and the provider choice: `config_notes.py`. A new provider is one adapter module and one
branch in `open_notes_model`; callers never change.
"""

from collections.abc import AsyncIterator, Mapping
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal, Protocol

from roger_api.domain import RunKind
from roger_api.services.notes_prompt import NotesPrompt

type MessageRole = Literal["system", "user", "assistant"]


@dataclass(frozen=True, slots=True)
class TextPart:
    text: str
    # True marks the end of a prefix the provider may cache, so a later request that repeats it
    # reads it at a fraction of the input price (chat's transcript block, M4-T10).
    cache: bool = False


@dataclass(frozen=True, slots=True)
class ModelMessage:
    role: MessageRole
    parts: tuple[TextPart, ...]


@dataclass(frozen=True, slots=True)
class JsonSchemaFormat:
    """Ask for strict JSON that matches `schema` (structured outputs) instead of free text."""

    name: str
    schema: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class ModelRequest:
    # Picks the model: NOTES_MODEL for `notes`, CHAT_MODEL for `chat`.
    kind: RunKind
    messages: tuple[ModelMessage, ...]
    json_schema: JsonSchemaFormat | None = None


def notes_request(prompt: NotesPrompt) -> ModelRequest:
    """The request for a notes prompt (`notes_prompt.py`): its rules, then its sources."""
    return ModelRequest(
        kind="notes",
        messages=(
            ModelMessage("system", (TextPart(prompt.system),)),
            ModelMessage("user", (TextPart(prompt.user),)),
        ),
    )


@dataclass(frozen=True, slots=True)
class ModelUsage:
    """What the vendor reported for one request. A field it did not send is None, never 0: a
    stored 0 would read as a free run (`llm_runs.cost_usd` is null when unknown)."""

    input_tokens: int | None
    output_tokens: int | None
    cached_tokens: int | None
    # Part of `output_tokens`, billed as output, even when the reasoning itself is not returned.
    reasoning_tokens: int | None
    cost_usd: Decimal | None


@dataclass(frozen=True, slots=True)
class TextDelta:
    text: str


@dataclass(frozen=True, slots=True)
class ModelDone:
    """The answer is complete. `usage` is None when the vendor sent none."""

    usage: ModelUsage | None


type ModelEvent = TextDelta | ModelDone


class ModelCutOffError(Exception):
    """The answer stopped at the output limit: whatever streamed is a fragment, not notes.

    Not an `AppError`: it can only happen after the stream started, so it is an SSE `error` event
    with code `cut_off`, never an HTTP envelope.
    """

    code = "cut_off"

    def __init__(self, usage: ModelUsage | None) -> None:
        super().__init__("The notes model reached its output limit before it finished")
        # The output tokens were still billed, so the run stores them.
        self.usage = usage


class NotesModel(Protocol):
    def model_id(self, kind: RunKind) -> str:
        """The model a request of `kind` goes to, stored on the run (`llm_runs.model`)."""
        ...

    def stream(
        self, request: ModelRequest
    ) -> AbstractAsyncContextManager[AsyncIterator[ModelEvent]]:
        """Send `request` and stream its answer (see the module docstring for the contract)."""
        ...
