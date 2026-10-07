"""The OpenRouter adapter, against `httpx.MockTransport` serving what OpenRouter streams.

Wire facts (OpenRouter docs, read 2026-10-06): the stream is SSE `data:` lines of
`chat.completion.chunk` JSON, with `: OPENROUTER PROCESSING` comments while the model reads the
prompt, ending `data: [DONE]`. The last chunk carries `usage` and repeats the `finish_reason`. A
failure after the headers is a `200` chunk with a top-level `error` and `finish_reason: "error"`;
one before them is an HTTP status with a JSON `error` body.
"""

import json
from collections.abc import AsyncIterator, Callable, Iterable
from decimal import Decimal
from typing import Any

import httpx
import pytest

from roger_api.config_notes import NotesSettings
from roger_api.errors import LlmProviderError
from roger_api.services import notes_model_openrouter
from roger_api.services.notes_model import (
    JsonSchemaFormat,
    ModelCutOffError,
    ModelDone,
    ModelEvent,
    ModelMessage,
    ModelRequest,
    ModelUsage,
    TextDelta,
    TextPart,
)
from roger_api.services.notes_model_openrouter import OPENROUTER_CHAT_URL, OpenRouterNotesModel

type Json = dict[str, Any]
type Handler = Callable[[httpx.Request], httpx.Response]

API_KEY = "sk-or-v1-secret-key"
NOTES_MODEL = "xiaomi/mimo-v2.6-pro"
CHAT_MODEL = "anthropic/claude-sonnet-5.5"
REQUEST = ModelRequest(
    kind="notes",
    messages=(
        ModelMessage("system", (TextPart("Write meeting notes."),)),
        ModelMessage("user", (TextPart("<transcript>\nL1 [00:00:03] Me: Hi.\n</transcript>"),)),
    ),
)
USAGE = {
    "prompt_tokens": 15_000,
    "completion_tokens": 2_000,
    "total_tokens": 17_000,
    "cost": 0.0082650,
    "prompt_tokens_details": {"cached_tokens": 12_000, "cache_write_tokens": 0},
    "completion_tokens_details": {"reasoning_tokens": 0},
}


def settings(**overrides: object) -> NotesSettings:
    values: dict[str, object] = {
        "notes_provider": "openrouter",
        "openrouter_api_key": API_KEY,
        "notes_model": NOTES_MODEL,
        "chat_model": CHAT_MODEL,
        **overrides,
    }
    return NotesSettings.model_validate(values)


def chunk(
    content: str | None = None,
    *,
    finish: str | None = None,
    reasoning: str | None = None,
    usage: Json | None = None,
) -> Json:
    """One `chat.completion.chunk` as OpenRouter streams it."""
    delta: Json = {"role": "assistant", "content": content or ""}
    if reasoning is not None:
        delta["reasoning"] = reasoning
        delta["reasoning_details"] = [
            {"type": "reasoning.text", "text": reasoning, "format": "unknown", "index": 0}
        ]
    body: Json = {
        "id": "gen-1759750000-abc",
        "provider": "DeepInfra",
        "model": NOTES_MODEL,
        "object": "chat.completion.chunk",
        "created": 1_759_750_000,
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "finish_reason": finish,
                "native_finish_reason": finish,
                "logprobs": None,
            }
        ],
    }
    if usage is not None:
        body["usage"] = usage
    return body


def sse(*events: Json | str) -> bytes:
    """SSE as OpenRouter frames it: a dict is a `data:` event, a str is sent as the line itself."""
    # Raw UTF-8, as OpenRouter sends it: `json.dumps` would escape every non-ASCII character.
    lines = [
        event if isinstance(event, str) else f"data: {json.dumps(event, ensure_ascii=False)}"
        for event in events
    ]
    return "".join(f"{line}\n\n" for line in lines).encode()


def complete(*contents: str, usage: Json | None = USAGE) -> bytes:
    """A finished answer: the text chunks, the stop, then the usage chunk and `[DONE]`."""
    return sse(
        *(chunk(content) for content in contents),
        chunk(finish="stop"),
        *([chunk(finish="stop", usage=usage)] if usage is not None else []),
        "data: [DONE]",
    )


class RecordingStream(httpx.AsyncByteStream):
    """A response body sent in the given pieces, recording whether the client closed it."""

    def __init__(self, pieces: Iterable[bytes]) -> None:
        self.pieces = list(pieces)
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for piece in self.pieces:
            yield piece

    async def aclose(self) -> None:
        self.closed = True


def streaming(body: bytes | RecordingStream, status_code: int = 200) -> httpx.Response:
    stream = body if isinstance(body, RecordingStream) else RecordingStream([body])
    return httpx.Response(status_code, headers={"Content-Type": "text/event-stream"}, stream=stream)


class Vendor:
    """Answers every request with `respond` and keeps what was sent."""

    def __init__(self, respond: Handler) -> None:
        self.respond = respond
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.respond(request)

    def body(self) -> Json:
        [request] = self.requests
        sent: Json = json.loads(request.content)
        return sent


def model_for(vendor: Vendor, **overrides: object) -> OpenRouterNotesModel:
    http = httpx.AsyncClient(transport=httpx.MockTransport(vendor))
    return OpenRouterNotesModel(http, api_key=API_KEY, settings=settings(**overrides))


async def read_into(
    seen: list[ModelEvent], model: OpenRouterNotesModel, request: ModelRequest
) -> None:
    async with model.stream(request) as events:
        async for event in events:
            seen.append(event)


async def read_all(
    model: OpenRouterNotesModel, request: ModelRequest = REQUEST
) -> list[ModelEvent]:
    seen: list[ModelEvent] = []
    await read_into(seen, model, request)
    return seen


def text_of(events: list[ModelEvent]) -> str:
    return "".join(event.text for event in events if isinstance(event, TextDelta))


async def test_request_sends_model_stream_and_zero_retention_routing() -> None:
    vendor = Vendor(lambda request: streaming(complete("## Decisions\n")))

    await read_all(model_for(vendor))

    [request] = vendor.requests
    assert request.method == "POST"
    assert str(request.url) == OPENROUTER_CHAT_URL
    assert OPENROUTER_CHAT_URL == "https://openrouter.ai/api/v1/chat/completions"
    assert request.headers["Authorization"] == f"Bearer {API_KEY}"
    assert request.headers["Content-Type"] == "application/json"
    assert request.headers["Accept"] == "text/event-stream"
    assert vendor.body() == {
        "model": NOTES_MODEL,
        "messages": [
            {"role": "system", "content": "Write meeting notes."},
            {"role": "user", "content": "<transcript>\nL1 [00:00:03] Me: Hi.\n</transcript>"},
        ],
        "stream": True,
        "max_tokens": 8_192,
        "reasoning": {"effort": "none"},
        # "We never train on calls" (M4 D3): only endpoints that keep no data and train on none.
        "provider": {"data_collection": "deny", "zdr": True},
    }


async def test_chat_requests_go_to_the_chat_model() -> None:
    vendor = Vendor(lambda request: streaming(complete("Dana is blocked [L1]")))
    model = model_for(vendor)

    await read_all(model, ModelRequest(kind="chat", messages=REQUEST.messages))

    assert vendor.body()["model"] == CHAT_MODEL
    assert model.model_id("chat") == CHAT_MODEL
    assert model.model_id("notes") == NOTES_MODEL


async def test_a_cached_part_is_sent_with_cache_control() -> None:
    vendor = Vendor(lambda request: streaming(complete("Yes [L1]")))
    request = ModelRequest(
        kind="chat",
        messages=(
            ModelMessage(
                "user",
                (TextPart("<transcript>\n...\n</transcript>", cache=True), TextPart("Who?")),
            ),
        ),
    )

    await read_all(model_for(vendor), request)

    assert vendor.body()["messages"] == [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "<transcript>\n...\n</transcript>",
                    "cache_control": {"type": "ephemeral"},
                },
                {"type": "text", "text": "Who?"},
            ],
        }
    ]


async def test_a_structured_request_requires_providers_that_support_it() -> None:
    vendor = Vendor(lambda request: streaming(complete('{"score": 4}')))
    schema: Json = {
        "type": "object",
        "properties": {"score": {"type": "integer"}},
        "required": ["score"],
        "additionalProperties": False,
    }
    request = ModelRequest(
        kind="notes",
        messages=REQUEST.messages,
        json_schema=JsonSchemaFormat(name="line_support", schema=schema),
    )

    await read_all(model_for(vendor), request)

    body = vendor.body()
    assert body["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "line_support", "strict": True, "schema": schema},
    }
    # Of the model's zero-retention endpoints only some honour a schema; without this a provider
    # that ignores it could answer in free text.
    assert body["provider"] == {"data_collection": "deny", "zdr": True, "require_parameters": True}


@pytest.mark.parametrize(
    ("overrides", "reasoning", "max_tokens"),
    [
        pytest.param({}, {"effort": "none"}, 8_192, id="off"),
        pytest.param(
            {
                "notes_reasoning": "on",
                "notes_reasoning_tokens": 3_000,
                "notes_max_output_tokens": 5_000,
            },
            {"max_tokens": 3_000, "exclude": True},
            8_000,
            id="on",
        ),
    ],
)
async def test_reasoning_is_sent_explicitly_from_the_setting(
    overrides: dict[str, object], reasoning: Json, max_tokens: int
) -> None:
    # Reasoning tokens count against max_tokens on most providers: with reasoning on, the budget
    # grows by the reasoning allowance, or the notes would be cut off by the model's thinking.
    vendor = Vendor(lambda request: streaming(complete("## Decisions\n")))

    await read_all(model_for(vendor, **overrides))

    body = vendor.body()
    assert body["reasoning"] == reasoning
    assert body["max_tokens"] == max_tokens


async def test_reasoning_deltas_are_not_note_text() -> None:
    body = sse(
        chunk(reasoning="The user wants notes. Let me think about Q3."),
        chunk(reasoning=" Pricing first."),
        chunk("## Pricing\n"),
        chunk("- Beta ships Friday [L2]\n", reasoning=" and done."),
        chunk(finish="stop", usage=USAGE),
        "data: [DONE]",
    )
    vendor = Vendor(lambda request: streaming(body))

    events = await read_all(model_for(vendor))

    assert text_of(events) == "## Pricing\n- Beta ships Friday [L2]\n"
    assert "think" not in repr(events)


def _splits_a_character(piece: bytes) -> bool:
    try:
        piece.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


async def test_text_deltas_arrive_in_order_across_chunk_boundaries() -> None:
    contents = [
        "## Pricing\n",
        "- Zo\u00eb asked for \u20ac50k",
        " by the 6th [L3, L4]\n",
        "- Ship [L9]",
    ]
    body = complete(*contents)
    # Seven bytes at a time splits lines, `data:` prefixes, JSON strings and the two-byte and
    # three-byte characters above.
    pieces = [body[start : start + 7] for start in range(0, len(body), 7)]
    assert any(_splits_a_character(piece) for piece in pieces)
    vendor = Vendor(lambda request: streaming(RecordingStream(pieces)))

    events = await read_all(model_for(vendor))

    assert [event for event in events if isinstance(event, TextDelta)] == [
        TextDelta(content) for content in contents
    ]
    assert isinstance(events[-1], ModelDone)


async def test_crlf_framing_and_multi_line_data_are_read() -> None:
    first = json.dumps(chunk("## Pricing\n"), indent=1)
    body = (
        "data: "
        + first.replace("\n", "\r\ndata: ")
        + "\r\n\r\n"
        + f"data: {json.dumps(chunk(finish='stop'))}\r\n\r\n"
        + "data: [DONE]\r\n\r\n"
    ).encode()
    vendor = Vendor(lambda request: streaming(body))

    events = await read_all(model_for(vendor))

    assert events == [TextDelta("## Pricing\n"), ModelDone(usage=None)]


async def test_processing_comments_and_done_marker_are_ignored() -> None:
    body = sse(
        ": OPENROUTER PROCESSING",
        ": OPENROUTER PROCESSING",
        chunk("## Pricing\n"),
        ": OPENROUTER PROCESSING",
        chunk(finish="stop", usage=USAGE),
        "data: [DONE]",
    )
    vendor = Vendor(lambda request: streaming(body))

    events = await read_all(model_for(vendor))

    assert text_of(events) == "## Pricing\n"
    assert len(events) == 2


async def test_nothing_after_done_is_read() -> None:
    body = complete("## Pricing\n") + sse(chunk("- Late text [L1]\n"))
    vendor = Vendor(lambda request: streaming(body))

    events = await read_all(model_for(vendor))

    assert text_of(events) == "## Pricing\n"


async def test_repeated_finish_reason_in_usage_chunk_is_one_finish() -> None:
    body = sse(
        chunk("## Pricing\n"),
        chunk("- Ship [L1]\n", finish="stop"),
        # The usage chunk repeats the finish in a content-free delta. Text that arrives after the
        # first finish is not part of the answer.
        chunk("", finish="stop", usage=USAGE),
        chunk("- ghost [L2]\n", finish="stop"),
        "data: [DONE]",
    )
    vendor = Vendor(lambda request: streaming(body))

    events = await read_all(model_for(vendor))

    assert text_of(events) == "## Pricing\n- Ship [L1]\n"
    assert [event for event in events if isinstance(event, ModelDone)] == [events[-1]]


async def test_usage_and_cost_are_read_from_the_final_chunk() -> None:
    vendor = Vendor(lambda request: streaming(complete("## Pricing\n")))

    events = await read_all(model_for(vendor))

    assert events[-1] == ModelDone(
        usage=ModelUsage(
            input_tokens=15_000,
            output_tokens=2_000,
            cached_tokens=12_000,
            reasoning_tokens=0,
            # Exact: `numeric` in Postgres, never a float that drifts in the last digits.
            cost_usd=Decimal("0.0082650"),
        )
    )


async def test_missing_usage_stores_null_cost_not_zero() -> None:
    no_usage = Vendor(lambda request: streaming(complete("## Pricing\n", usage=None)))
    no_cost = Vendor(
        lambda request: streaming(
            complete("## Pricing\n", usage={"prompt_tokens": 10, "completion_tokens": 3})
        )
    )

    [*_, without_usage] = await read_all(model_for(no_usage))
    [*_, without_cost] = await read_all(model_for(no_cost))

    assert without_usage == ModelDone(usage=None)
    assert without_cost == ModelDone(
        usage=ModelUsage(
            input_tokens=10,
            output_tokens=3,
            cached_tokens=None,
            reasoning_tokens=None,
            cost_usd=None,
        )
    )


class RecordingLogger:
    def __init__(self) -> None:
        self.lines: list[tuple[str, dict[str, object]]] = []

    def _record(self, event: str, **fields: object) -> None:
        self.lines.append((event, fields))

    info = warning = error = _record


@pytest.fixture
def logs(monkeypatch: pytest.MonkeyPatch) -> RecordingLogger:
    recorder = RecordingLogger()
    monkeypatch.setattr(notes_model_openrouter, "logger", recorder)
    return recorder


@pytest.mark.parametrize("status_code", [400, 401, 402, 403, 429, 502, 503])
async def test_http_error_is_an_llm_provider_error_without_the_vendor_body(
    status_code: int, logs: RecordingLogger
) -> None:
    refusal = {
        "error": {
            "code": status_code,
            "message": "No endpoints found matching your data policy",
            # A moderation refusal echoes the input it flagged: transcript text.
            "metadata": {"reasons": ["harassment"], "flagged_input": "Dana's salary is 90k"},
        }
    }
    vendor = Vendor(lambda request: httpx.Response(status_code, json=refusal))
    model = model_for(vendor)

    with pytest.raises(LlmProviderError) as raised:
        async with model.stream(REQUEST):
            pytest.fail("a refused request must not open a stream")

    message = raised.value.message
    assert str(status_code) in message
    assert "data policy" not in message
    assert "salary" not in message
    assert API_KEY not in message
    # The log names the status and OpenRouter's own message (it says which rule refused), never
    # the metadata, which can quote the transcript, and never the key.
    [(event, fields)] = logs.lines
    assert event == "notes_model_refused"
    assert fields["status"] == status_code
    assert fields["vendor_message"] == "No endpoints found matching your data policy"
    assert "salary" not in repr(logs.lines)
    assert API_KEY not in repr(logs.lines)


async def test_a_refusal_with_an_unreadable_body_is_still_an_llm_provider_error(
    logs: RecordingLogger,
) -> None:
    vendor = Vendor(lambda request: httpx.Response(503, text="<html>upstream</html>"))

    with pytest.raises(LlmProviderError, match="503"):
        await read_all(model_for(vendor))
    assert "upstream" not in repr(logs.lines)


async def test_an_unreachable_provider_is_an_llm_provider_error() -> None:
    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(LlmProviderError, match="unreachable"):
        await read_all(model_for(Vendor(unreachable)))


async def test_error_chunk_mid_stream_raises(logs: RecordingLogger) -> None:
    body = sse(
        chunk("## Pricing\n"),
        {
            "id": "gen-1759750000-abc",
            "object": "chat.completion.chunk",
            "created": 1_759_750_000,
            "model": NOTES_MODEL,
            "provider": "DeepInfra",
            "error": {"code": "server_error", "message": "Provider disconnected unexpectedly"},
            "choices": [{"index": 0, "delta": {"content": ""}, "finish_reason": "error"}],
        },
        "data: [DONE]",
    )
    vendor = Vendor(lambda request: streaming(body))
    seen: list[ModelEvent] = []

    with pytest.raises(LlmProviderError) as raised:
        await read_into(seen, model_for(vendor), REQUEST)

    assert seen == [TextDelta("## Pricing\n")]
    assert "disconnected" not in raised.value.message
    failure = {
        "model": NOTES_MODEL,
        "code": "server_error",
        "vendor_message": "Provider disconnected unexpectedly",
    }
    assert ("notes_model_stream_failed", failure) in logs.lines


async def test_error_finish_without_an_error_body_raises() -> None:
    body = sse(chunk("## Pricing\n"), chunk(finish="error"), "data: [DONE]")
    vendor = Vendor(lambda request: streaming(body))

    with pytest.raises(LlmProviderError):
        await read_all(model_for(vendor))


@pytest.mark.parametrize("finish", ["content_filter", "tool_calls"])
async def test_an_unexpected_finish_is_a_failure(finish: str) -> None:
    body = sse(chunk("## P"), chunk(finish=finish), "data: [DONE]")
    vendor = Vendor(lambda request: streaming(body))

    with pytest.raises(LlmProviderError, match=finish):
        await read_all(model_for(vendor))


async def test_length_finish_reason_is_cut_off() -> None:
    usage = {**USAGE, "completion_tokens": 8_192}
    body = sse(
        chunk("## Pricing\n"),
        chunk("- Beta ships", finish="length"),
        chunk(finish="length", usage=usage),
        "data: [DONE]",
    )
    vendor = Vendor(lambda request: streaming(body))
    seen: list[ModelEvent] = []

    with pytest.raises(ModelCutOffError) as raised:
        await read_into(seen, model_for(vendor), REQUEST)

    # The fragment streamed, and the billed tokens are kept for the run's cost.
    assert text_of(seen) == "## Pricing\n- Beta ships"
    assert raised.value.usage is not None
    assert raised.value.usage.output_tokens == 8_192
    assert raised.value.code == "cut_off"


@pytest.mark.parametrize(
    "body",
    [
        pytest.param(sse(chunk("## Pricing\n")), id="no-finish-no-done"),
        pytest.param(sse(chunk("## Pricing\n"), "data: [DONE]"), id="done-without-finish"),
        pytest.param(b"", id="empty"),
    ],
)
async def test_a_stream_that_ends_before_its_finish_raises(body: bytes) -> None:
    vendor = Vendor(lambda request: streaming(body))

    with pytest.raises(LlmProviderError, match="ended"):
        await read_all(model_for(vendor))


@pytest.mark.parametrize(
    "event",
    [
        pytest.param("data: {not json", id="not-json"),
        pytest.param('data: {"choices": "nope"}', id="wrong-shape"),
        pytest.param("data: [1, 2]", id="not-an-object"),
    ],
)
async def test_an_unreadable_chunk_raises(event: str, logs: RecordingLogger) -> None:
    vendor = Vendor(lambda request: streaming(sse(chunk("## Pricing\n"), event)))

    with pytest.raises(LlmProviderError, match="unreadable"):
        await read_all(model_for(vendor))
    assert "nope" not in repr(logs.lines)


async def test_a_read_timeout_mid_stream_raises() -> None:
    class Stalls(RecordingStream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            yield sse(chunk("## Pricing\n"))
            raise httpx.ReadTimeout("no bytes for 120 s")

    vendor = Vendor(lambda request: streaming(Stalls([])))

    with pytest.raises(LlmProviderError, match="stopped answering"):
        await read_all(model_for(vendor))


async def test_leaving_the_stream_closes_the_connection() -> None:
    body = RecordingStream([sse(chunk("## Pricing\n")), sse(chunk("- Ship [L1]\n"))])
    vendor = Vendor(lambda request: streaming(body))

    async with model_for(vendor).stream(REQUEST) as events:
        assert await anext(events) == TextDelta("## Pricing\n")
        assert not body.closed
    # A cancelled run leaves the same way: the connection closes and the model stops.
    assert body.closed
