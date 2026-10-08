"""The calendar runtime: what the calendar routes share for the app's lifetime (M5-T3).

app.py enters `open_calendar_runtime` once in its lifespan and stores what it yields as
`app.state.calendar_runtime`. The FastAPI getter that reads it and its `Dep` alias live here, never
in dependencies.py (phase-2-build-order.md, section 1), and app.py is not edited again.

The runtime holds the provider (`CALENDAR_PROVIDER`; Google's keeps one HTTP client open), the key
that encrypts the stored refresh tokens, the consent screen's audience, and the Google access
tokens, which live in memory only (`AccessTokenCache`).
"""

import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import Depends, Request
from pydantic import SecretStr

from roger_api.auth import Principal
from roger_api.config import Settings
from roger_api.config_calendar import GoogleOAuthAudience
from roger_api.services.calendar.fake import FakeCalendarProvider
from roger_api.services.calendar.google import GOOGLE_TIMEOUT, GoogleCalendarProvider
from roger_api.services.calendar.provider import AccessToken, CalendarProvider
from roger_api.services.calendar.unconfigured import UnconfiguredCalendarProvider

# An access token is used until this long before Google says it expires: a token that expires on
# its way to Google is a 401, and that costs a refresh and a retry anyway.
ACCESS_TOKEN_MARGIN_SECONDS = 60

type _Owner = tuple[UUID, UUID | None]


@dataclass(frozen=True, slots=True)
class _CachedAccessToken:
    connection_id: UUID
    value: str = field(repr=False)
    # On the cache's clock (monotonic seconds): a change of the wall clock never stretches it.
    usable_until: float


class AccessTokenCache:
    """Google access tokens in memory, one per connection, never stored and never logged.

    Keyed by the owner (workspace and user) and checked against the connection id, so a token
    of a replaced or deleted connection is never handed to its successor: connecting again gives
    the row a new id (connections.py). Per process: a second worker refreshes once for itself.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._tokens: dict[_Owner, _CachedAccessToken] = {}

    def get(self, owner: Principal, connection_id: UUID) -> str | None:
        """The connection's access token, or None when there is none or it is about to expire."""
        cached = self._tokens.get(_owner_key(owner))
        if cached is None or cached.connection_id != connection_id:
            return None
        if self._clock() >= cached.usable_until:
            return None
        return cached.value

    def put(self, owner: Principal, connection_id: UUID, token: AccessToken) -> None:
        self._tokens[_owner_key(owner)] = _CachedAccessToken(
            connection_id=connection_id,
            value=token.value,
            usable_until=self._clock() + token.expires_in_seconds - ACCESS_TOKEN_MARGIN_SECONDS,
        )

    def drop(self, owner: Principal) -> None:
        self._tokens.pop(_owner_key(owner), None)


def _owner_key(owner: Principal) -> _Owner:
    return (owner.workspace_id, owner.user_id)


class CalendarRuntime:
    """What the app holds for its lifetime as `app.state.calendar_runtime`."""

    def __init__(
        self,
        *,
        provider: CalendarProvider,
        token_key: SecretStr | None,
        audience: GoogleOAuthAudience,
        access_tokens: AccessTokenCache | None = None,
    ) -> None:
        self.provider = provider
        # False with no CALENDAR_PROVIDER: connect and events answer `calendar_not_configured`,
        # while a stored connection stays readable and can be disconnected.
        self.configured = not isinstance(provider, UnconfiguredCalendarProvider)
        # CALENDAR_TOKEN_KEY. Settings require it with the Google provider; the fake stores no
        # token, so it may run without one.
        self.token_key = token_key
        self.audience = audience
        self.access_tokens = access_tokens or AccessTokenCache()


@asynccontextmanager
async def open_calendar_runtime(settings: Settings) -> AsyncIterator[CalendarRuntime]:
    """Entered by the app lifespan; exiting it closes the Google HTTP client."""
    if settings.calendar_provider is None:
        yield _runtime(settings, UnconfiguredCalendarProvider())
        return
    if settings.calendar_provider == "fake":
        # Its events are anchored here, at startup: restart the API for a fresh "call in 2
        # minutes". A bad FAKE_CALENDAR_FILE stops the start, naming the file.
        fake = FakeCalendarProvider(
            started_at=datetime.now(UTC), events_file=settings.fake_calendar_file
        )
        yield _runtime(settings, fake)
        return
    client_id = settings.google_oauth_client_id
    client_secret = settings.google_oauth_client_secret
    if client_id is None or client_secret is None:  # Settings validation already guarantees this.
        raise RuntimeError(
            "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are required when "
            "CALENDAR_PROVIDER=google"
        )
    async with httpx.AsyncClient(timeout=GOOGLE_TIMEOUT) as http:
        google = GoogleCalendarProvider(
            http, client_id=client_id, client_secret=client_secret.get_secret_value()
        )
        yield _runtime(settings, google)


def _runtime(settings: Settings, provider: CalendarProvider) -> CalendarRuntime:
    return CalendarRuntime(
        provider=provider,
        token_key=settings.calendar_token_key,
        audience=settings.google_oauth_audience,
    )


def get_calendar_runtime(request: Request) -> CalendarRuntime:
    runtime = getattr(request.app.state, "calendar_runtime", None)
    if not isinstance(runtime, CalendarRuntime):
        raise RuntimeError("app.state.calendar_runtime is not set; build the app with create_app()")
    return runtime


CalendarRuntimeDep = Annotated[CalendarRuntime, Depends(get_calendar_runtime)]
