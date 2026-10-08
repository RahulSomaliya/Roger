"""The calendar provider of an API with no calendar set up.

With no `CALENDAR_PROVIDER` the runtime holds this: Connect answers `calendar_not_configured`
(503) instead of signing anyone in. The fake provider used to be the default and granted a made-up
`you@example.com` with meetings that raised real alerts, so the absence of a provider has to be
said out loud. `connections.py` and `events.py` check `CalendarRuntime.configured` before they use
the provider: a connection stored under another provider stays readable and can still be
disconnected, and its events answer `calendar_not_configured` rather than a misleading "connect
again". Every method here raises as well, so a new caller that forgets the check fails loud.
"""

from datetime import datetime

from roger_api.errors import CalendarNotConfiguredError
from roger_api.services.calendar.provider import (
    AccessToken,
    CalendarEvent,
    CalendarGrant,
    CalendarProviderName,
)

NOT_CONFIGURED_MESSAGE = "Google Calendar is not set up on Roger's server yet."


class UnconfiguredCalendarProvider:
    """Every call raises `CalendarNotConfiguredError`."""

    @property
    def provider(self) -> CalendarProviderName:
        # The only provider a person could ever be asked to set up. Stored connections are
        # compared with this name, but the callers check `configured` first.
        return "google"

    def authorization_url(self, *, redirect_uri: str, code_challenge: str, state: str) -> str:
        raise CalendarNotConfiguredError(NOT_CONFIGURED_MESSAGE)

    async def exchange_code(
        self, *, code: str, code_verifier: str, redirect_uri: str
    ) -> CalendarGrant:
        raise CalendarNotConfiguredError(NOT_CONFIGURED_MESSAGE)

    async def refresh(self, refresh_token: str | None) -> AccessToken:
        raise CalendarNotConfiguredError(NOT_CONFIGURED_MESSAGE)

    async def revoke(self, refresh_token: str | None) -> None:
        raise CalendarNotConfiguredError(NOT_CONFIGURED_MESSAGE)

    async def list_events(
        self, access_token: str, *, time_min: datetime, time_max: datetime
    ) -> list[CalendarEvent]:
        raise CalendarNotConfiguredError(NOT_CONFIGURED_MESSAGE)
