"""The calendar runtime. Stub from P2-F2; owned by M5-T3.

M5-T3 builds here what the calendar routes share for the app's lifetime (the Google provider and
its HTTP client, access tokens cached per connection). app.py enters `open_calendar_runtime` once
in its lifespan and stores what it yields as `app.state.calendar_runtime`; the FastAPI getter that
reads it and its `Dep` alias live in this module, never in dependencies.py
(phase-2-build-order.md, section 1), and app.py is not edited again.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from roger_api.config import Settings


class CalendarRuntime:
    """What the app holds for its lifetime as `app.state.calendar_runtime`. Empty until M5-T3."""


@asynccontextmanager
async def open_calendar_runtime(settings: Settings) -> AsyncIterator[CalendarRuntime]:
    """Entered by the app lifespan; exiting it closes what the runtime holds open."""
    yield CalendarRuntime()
