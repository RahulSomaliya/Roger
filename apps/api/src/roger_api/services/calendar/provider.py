"""The calendar provider seam (house rule 4): what the calendar routes need from a calendar vendor.

`google.py` talks to Google over httpx; `fake.py` answers from a script with no Google client
(`CALENDAR_PROVIDER=fake`, the default). The routes and the token store (M5-T3) see only this
protocol and these types, never Google's JSON. The types mirror `CalendarEvent` and
`CalendarAttendee` in docs/api-contract.md; the desktop's camelCase copy is
apps/desktop/src/shared/calendar.ts.

Tokens: the desktop never sees a Google token (house rule 3). The refresh token goes from
`exchange_code` into the encrypted store and back into `refresh` and `revoke`; access tokens live
in memory. Neither is ever logged: the token fields here are left out of `repr`, so logging a
grant or a token object by mistake prints no secret.
"""

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Literal, Protocol

from roger_api.errors import CalendarProviderError

type CalendarProviderName = Literal["google", "fake"]
type ResponseStatus = Literal["accepted", "tentative", "declined", "needs_action"]
# The user's own answer to the invite. `organizer`: the user owns the event.
type SelfResponse = ResponseStatus | Literal["organizer", "unknown"]
# Cancelled events are never returned.
type EventStatus = Literal["confirmed", "tentative"]
# Where `video_link` came from. `conference` is the link Google adds by itself; it alone is not
# evidence of a call (the desktop's reminder policy), a link someone typed is. A typed link wins
# over conference data (normalize.py `_video_link`), so `conference` means nothing was typed.
type VideoLinkSource = Literal["conference", "location", "description"]


@dataclass(frozen=True, slots=True)
class CalendarAttendee:
    """A person on the invite. Rooms and other resources are never listed."""

    email: str
    display_name: str | None
    response_status: ResponseStatus
    is_self: bool
    is_organizer: bool


@dataclass(frozen=True, slots=True)
class CalendarEvent:
    """One event instance. Timed events carry UTC instants; all-day events carry plain dates.

    An all-day event is never turned into midnight UTC: west of UTC that moves it a day back.
    """

    provider: CalendarProviderName
    # The instance id for a recurring event: each instance has its own.
    id: str
    ical_uid: str | None
    recurring_event_id: str | None
    # "" when the invite has none.
    title: str
    status: EventStatus
    all_day: bool
    start: datetime | None
    end: datetime | None
    start_date: date | None
    # Exclusive, as Google sends it.
    end_date: date | None
    self_response: SelfResponse
    attendees: tuple[CalendarAttendee, ...]
    # Google left some attendees out (privacy, or more than `maxAttendees`).
    attendees_omitted: bool
    # Allowlisted hosts only (video_links.py).
    video_link: str | None
    video_link_source: VideoLinkSource | None
    html_link: str | None

    def __post_init__(self) -> None:
        # A mixed event (an all-day date with an instant, or a local time) would reach the desktop,
        # which runs prompts on instants and groups all-day events by date: fail where it is made.
        if self.all_day:
            consistent = (
                self.start is None
                and self.end is None
                and self.start_date is not None
                and self.end_date is not None
            )
        else:
            consistent = (
                self.start_date is None
                and self.end_date is None
                and _is_utc(self.start)
                and _is_utc(self.end)
            )
        if not consistent:
            raise ValueError(
                f"Calendar event {self.id}: an all-day event needs start_date and end_date only, "
                "a timed event start and end only, as UTC instants"
            )
        if (self.video_link is None) != (self.video_link_source is None):
            raise ValueError(f"Calendar event {self.id}: video_link and its source go together")


def _is_utc(value: datetime | None) -> bool:
    return value is not None and value.utcoffset() == timedelta(0)


@dataclass(frozen=True, slots=True)
class AccessToken:
    """A short-lived Google access token, kept in memory only (M5-T3 caches it per connection)."""

    value: str = field(repr=False)
    expires_in_seconds: int


@dataclass(frozen=True, slots=True)
class CalendarGrant:
    """What a completed sign-in leaves: the account, its scopes and the tokens to store."""

    account_email: str
    # As the provider granted them, in its order.
    scopes: tuple[str, ...]
    # Encrypted at rest (M5-T3). None only from the fake provider, which has nothing to refresh.
    refresh_token: str | None = field(repr=False)
    access_token: AccessToken


class CalendarAccessTokenRejectedError(CalendarProviderError):
    """The provider refused an access token (Google's `401`), most often because it expired.

    M5-T3 catches it, refreshes once and retries once. Uncaught it is a `502`
    `calendar_provider_error`, never a `424`: only a refused refresh token means reconnect.
    """


class CalendarProvider(Protocol):
    """A calendar vendor. Every method that calls out raises `CalendarProviderError` (502) when the
    vendor fails or answers with something unusable, and `CalendarReconnectRequiredError` (424)
    when the user has to connect again; the message says what to do and holds no secret."""

    @property
    def provider(self) -> CalendarProviderName: ...

    def authorization_url(self, *, redirect_uri: str, code_challenge: str, state: str) -> str:
        """The URL the desktop opens in the default browser to start the sign-in.

        `redirect_uri` is the desktop's loopback listener, already checked by the route;
        `code_challenge` is the S256 of the desktop's PKCE verifier.
        """
        ...

    async def exchange_code(
        self, *, code: str, code_verifier: str, redirect_uri: str
    ) -> CalendarGrant:
        """Redeems the one-time code from the redirect. Raises `CalendarReconnectRequiredError`
        when calendar access was not granted or the code is no longer valid."""
        ...

    async def refresh(self, refresh_token: str | None) -> AccessToken:
        """A fresh access token. Raises `CalendarReconnectRequiredError` when the provider refused
        the refresh token (Google's `invalid_grant`): revoked, expired, or the user removed access.
        """
        ...

    async def revoke(self, refresh_token: str | None) -> None:
        """Ends the grant at the provider (Disconnect). Raises `CalendarProviderError` when the
        provider refused or failed; M5-T3 logs that and deletes the connection anyway."""
        ...

    async def list_events(
        self, access_token: str, *, time_min: datetime, time_max: datetime
    ) -> list[CalendarEvent]:
        """Events on the primary calendar that end after `time_min` and start before `time_max`,
        ordered by start, cancelled ones left out. Both bounds must carry a time zone. Raises
        `CalendarAccessTokenRejectedError` when the access token is refused."""
        ...


def require_aware(value: datetime, name: str) -> datetime:
    """`value` in UTC. A naive bound would be read in the server's zone: hours off, no error."""
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{name} must carry a time zone, got {value.isoformat()}")
    return value.astimezone(UTC)
