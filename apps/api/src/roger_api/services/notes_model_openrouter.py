"""`NotesModel` over OpenRouter's OpenAI-compatible chat completions, streamed, on plain httpx.

No SDK and no new dependency (M4 plan, D1). OpenRouter's docs, read 2026-10-06:
- `POST /api/v1/chat/completions` with `stream: true` answers SSE: `data:` lines of
  `chat.completion.chunk` JSON, `: OPENROUTER PROCESSING` comments while the model reads the prompt
  (keep-alives, so a read timeout never trips on a long prompt), then `data: [DONE]`.
- Answer text is `choices[0].delta.content`. Reasoning streams in `delta.reasoning` and
  `delta.reasoning_details`; only `content` is read, so reasoning never becomes note text.
- The last chunk carries `usage` (always sent; `usage: {include: true}` is deprecated) and repeats
  the `finish_reason` in a content-free delta. The first finish ends the text; usage is taken from
  whichever chunk carries it.
- A failure before the headers is an HTTP status with `{"error": {"code", "message", "metadata"}}`.
  After them it is a `200` chunk with a top-level `error` and `finish_reason: "error"`. Moderation
  `metadata` quotes the flagged input, which is transcript text: never log it.
- `reasoning: {"effort": "none"}` asks for no reasoning; `{"max_tokens": n, "exclude": true}`
  caps it and leaves it out of the answer (still billed). On most providers reasoning counts
  against the request's `max_tokens`, and an answer that hits it ends with
  `finish_reason: "length"`.
- Closing the connection cancels the generation, and its billing where the provider supports it.

What is still unchecked without a key: whether the default model's zero-retention endpoints honour
`effort: "none"` (M4 D2 asks for a real call; if not, cap reasoning through NOTES_REASONING=on).
"""

from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from decimal import Decimal

import httpx
from pydantic import BaseModel, Field, ValidationError

from roger_api.config_notes import NotesSettings
from roger_api.domain import RunKind
from roger_api.errors import LlmProviderError
from roger_api.log import get_logger
from roger_api.services.notes_model import (
    ModelCutOffError,
    ModelDone,
    ModelEvent,
    ModelMessage,
    ModelRequest,
    ModelUsage,
    TextDelta,
    TextPart,
)

logger = get_logger(__name__)

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
_DONE_MARKER = "[DONE]"
# OpenRouter's own error message says which rule refused (no zero-retention endpoint, credits, rate
# limit), so it is logged, cut to this length; the metadata never is.
_VENDOR_MESSAGE_CHARS = 300


class OpenRouterNotesModel:
    def __init__(self, http: httpx.AsyncClient, *, api_key: str, settings: NotesSettings) -> None:
        self._http = http
        self._api_key = api_key
        self._settings = settings

    def model_id(self, kind: RunKind) -> str:
        return self._settings.notes_model if kind == "notes" else self._settings.chat_model

    @asynccontextmanager
    async def stream(self, request: ModelRequest) -> AsyncIterator[AsyncIterator[ModelEvent]]:
        model = self.model_id(request.kind)
        async with AsyncExitStack() as stack:
            try:
                # Never log the request: its headers carry the key and its body the transcript.
                response = await stack.enter_async_context(
                    self._http.stream(
                        "POST",
                        OPENROUTER_CHAT_URL,
                        headers={
                            "Authorization": f"Bearer {self._api_key}",
                            "Accept": "text/event-stream",
                        },
                        json=self._body(request, model),
                    )
                )
            except httpx.HTTPError as exc:
                logger.warning("notes_model_unreachable", model=model, error=repr(exc))
                raise LlmProviderError("The notes model's provider is unreachable") from exc
            if response.is_error:
                await _refuse(response, model)
            yield _events(response, model)

    def _body(self, request: ModelRequest, model: str) -> dict[str, object]:
        settings = self._settings
        max_tokens = settings.notes_max_output_tokens
        # Sent on every request, never left to the account or model default: unpinned, reasoning
        # would eat the notes' budget (a false cut-off) and the eval could not compare settings.
        reasoning: dict[str, object] = {"effort": "none"}
        if settings.notes_reasoning == "on":
            reasoning = {"max_tokens": settings.notes_reasoning_tokens, "exclude": True}
            max_tokens += settings.notes_reasoning_tokens
        # "We never train on calls" (M4 D3, the owner's decision): only endpoints that keep no
        # data and collect none. Never drop either key to get past an outage.
        provider: dict[str, object] = {"data_collection": "deny", "zdr": True}
        body: dict[str, object] = {
            "model": model,
            "messages": [_message(message) for message in request.messages],
            "stream": True,
            "max_tokens": max_tokens,
            "reasoning": reasoning,
            "provider": provider,
        }
        if request.json_schema is not None:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": request.json_schema.name,
                    "strict": True,
                    "schema": request.json_schema.schema,
                },
            }
            # Of the default model's zero-retention endpoints only some list structured outputs
            # (2026-10-06: DeepInfra does, Novita does not). Without this, routing may pick one
            # that ignores the schema and answers in free text.
            provider["require_parameters"] = True
        return body


def _message(message: ModelMessage) -> dict[str, object]:
    if len(message.parts) == 1 and not message.parts[0].cache:
        return {"role": message.role, "content": message.parts[0].text}
    return {"role": message.role, "content": [_part(part) for part in message.parts]}


def _part(part: TextPart) -> dict[str, object]:
    content: dict[str, object] = {"type": "text", "text": part.text}
    if part.cache:
        content["cache_control"] = {"type": "ephemeral"}
    return content


class _VendorError(BaseModel):
    code: int | str | None = None
    message: str | None = None


class _Refusal(BaseModel):
    error: _VendorError


class _Delta(BaseModel):
    content: str | None = None


class _Choice(BaseModel):
    delta: _Delta | None = None
    finish_reason: str | None = None


class _PromptTokensDetails(BaseModel):
    cached_tokens: int | None = None


class _CompletionTokensDetails(BaseModel):
    reasoning_tokens: int | None = None


class _Usage(BaseModel):
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    cost: Decimal | None = None
    prompt_tokens_details: _PromptTokensDetails | None = None
    completion_tokens_details: _CompletionTokensDetails | None = None

    def to_usage(self) -> ModelUsage:
        prompt, completion = self.prompt_tokens_details, self.completion_tokens_details
        return ModelUsage(
            input_tokens=self.prompt_tokens,
            output_tokens=self.completion_tokens,
            cached_tokens=prompt.cached_tokens if prompt else None,
            reasoning_tokens=completion.reasoning_tokens if completion else None,
            cost_usd=self.cost,
        )


class _Chunk(BaseModel):
    choices: list[_Choice] = Field(default_factory=list)
    usage: _Usage | None = None
    error: _VendorError | None = None


async def _refuse(response: httpx.Response, model: str) -> None:
    """Logs a refused request and raises; the client's message never carries the vendor's body."""
    vendor: _VendorError | None
    try:
        vendor = _Refusal.model_validate_json(await response.aread()).error
    except (httpx.HTTPError, ValidationError):
        # No readable error body (a proxy's HTML page, a dropped connection). The status alone says
        # what happened, and the refusal is raised below either way.
        vendor = None
    logger.warning(
        "notes_model_refused",
        model=model,
        status=response.status_code,
        code=vendor.code if vendor else None,
        vendor_message=_clip(vendor.message if vendor else None),
    )
    raise LlmProviderError(
        f"The notes model's provider refused the request (HTTP {response.status_code})"
    )


async def _events(response: httpx.Response, model: str) -> AsyncIterator[ModelEvent]:
    finish: str | None = None
    usage: ModelUsage | None = None
    try:
        async for data in _sse_data(response.aiter_lines()):
            if data == _DONE_MARKER:
                break
            chunk = _read_chunk(data, model)
            if chunk.error is not None:
                logger.warning(
                    "notes_model_stream_failed",
                    model=model,
                    code=chunk.error.code,
                    vendor_message=_clip(chunk.error.message),
                )
                raise LlmProviderError("The notes model's provider failed while answering")
            if chunk.usage is not None:
                usage = chunk.usage.to_usage()
            # The usage chunk repeats the finish: only text before the first finish is answer.
            if finish is None and chunk.choices:
                choice = chunk.choices[0]
                if choice.delta is not None and choice.delta.content:
                    yield TextDelta(choice.delta.content)
                finish = choice.finish_reason
    except httpx.HTTPError as exc:
        logger.warning("notes_model_stream_broken", model=model, error=repr(exc))
        raise LlmProviderError("The notes model's provider stopped answering") from exc

    _log_stream_end(model, finish, usage)
    match finish:
        case "stop":
            yield ModelDone(usage=usage)
        case "length":
            raise ModelCutOffError(usage)
        case None:
            raise LlmProviderError("The notes model's answer ended before it finished")
        case "error":
            raise LlmProviderError("The notes model's provider failed while answering")
        case other:
            raise LlmProviderError(f"The notes model stopped without finishing ({other})")


async def _sse_data(lines: AsyncIterator[str]) -> AsyncIterator[str]:
    """The data of each event in an SSE stream (WHATWG event-stream rules).

    `data:` lines are joined with newlines and an empty line ends the event. Comments (lines that
    start with `:`, OpenRouter's keep-alives) and other fields are skipped. httpx's `aiter_lines`
    splits on LF, CRLF and CR, and decodes UTF-8 across network chunks.
    """
    data: list[str] = []
    async for line in lines:
        if not line:
            if data:
                yield "\n".join(data)
                data = []
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        if field == "data":
            data.append(value.removeprefix(" "))
    if data:
        yield "\n".join(data)


def _read_chunk(data: str, model: str) -> _Chunk:
    try:
        return _Chunk.model_validate_json(data)
    except ValidationError as exc:
        # `str(exc)` would quote the input, and a chunk holds note text.
        logger.warning(
            "notes_model_unreadable_chunk",
            model=model,
            errors=exc.errors(include_url=False, include_input=False, include_context=False),
        )
        raise LlmProviderError("The notes model's provider sent an unreadable answer") from exc


def _log_stream_end(model: str, finish: str | None, usage: ModelUsage | None) -> None:
    logger.info(
        "notes_model_stream_ended",
        model=model,
        finish_reason=finish,
        input_tokens=usage.input_tokens if usage else None,
        output_tokens=usage.output_tokens if usage else None,
        cached_tokens=usage.cached_tokens if usage else None,
        reasoning_tokens=usage.reasoning_tokens if usage else None,
        cost_usd=str(usage.cost_usd) if usage and usage.cost_usd is not None else None,
    )


def _clip(message: str | None) -> str | None:
    return message[:_VENDOR_MESSAGE_CHARS] if message else None
