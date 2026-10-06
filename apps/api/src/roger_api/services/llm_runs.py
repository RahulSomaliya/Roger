"""The LLM run registry. Stub from P2-F2; owned by M4-T7.

M4-T7 builds here: a background task per notes or chat run, the event buffer a late subscriber
replays, heartbeat, cancel, the stale sweep, usage and cost. app.py enters `open_llm_runtime` once
in its lifespan and stores what it yields as `app.state.llm_runtime`; the FastAPI getter that reads
it and its `Dep` alias live in this module, never in dependencies.py (phase-2-build-order.md,
section 1), and app.py is not edited again.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from roger_api.config import Settings


class LlmRuntime:
    """What the app holds for its lifetime as `app.state.llm_runtime`. Empty until M4-T7."""


@asynccontextmanager
async def open_llm_runtime(settings: Settings) -> AsyncIterator[LlmRuntime]:
    """Entered by the app lifespan; exiting it ends what the runtime still runs."""
    yield LlmRuntime()
