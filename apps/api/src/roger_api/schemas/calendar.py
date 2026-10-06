"""The calendar routes on the wire (docs/api-contract.md, Calendar).

The desktop's camelCase copy is apps/desktop/src/shared/calendar.ts (CalendarConnection, events)
and src/main/calendar/ports.ts (the requests); change them with the contract.
"""

import re
from datetime import date, timedelta
from typing import Annotated, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)

from roger_api.db.models_calendar import CalendarConnectionStatus
from roger_api.schemas.common import UtcDatetime
from roger_api.services.calendar.provider import (
    CalendarProviderName,
    EventStatus,
    ResponseStatus,
    SelfResponse,
    VideoLinkSource,
)

# The longest window `GET /v1/calendar/events` lists. The desktop asks for 72 hours, and its
# catch-up fetch after a long absence reaches at most 6 days back (M5 plan, "Polling or push").
MAX_EVENTS_WINDOW = timedelta(days=7)

# Exactly the loopback redirect Google allows a Desktop client, on any port: `http`, the IPv4
# literal (never `localhost`, which Google warns some firewalls trip on), an explicit port and a
# path. Printable ASCII only, so no whitespace or control character can hide in it: Python's
# urlsplit drops a tab or newline before parsing, so a parsed check would pass one.
_LOOPBACK_REDIRECT = re.compile(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})/[!-~]*")
MAX_REDIRECT_URI_LENGTH = 2048


def _loopback_redirect(value: str) -> str:
    match = _LOOPBACK_REDIRECT.fullmatch(value)
    # A fragment is never part of a redirect (RFC 6749, 3.1.2). A backslash, which browsers read
    # as a slash, is refused rather than reasoned about.
    if match is None or int(match.group(1)) > 65535 or "#" in value or "\\" in value:
        raise ValueError("must be the desktop's loopback redirect, http://127.0.0.1:<port>/<path>")
    return value


LoopbackRedirectUri = Annotated[
    str, StringConstraints(max_length=MAX_REDIRECT_URI_LENGTH), AfterValidator(_loopback_redirect)
]
# BASE64URL(SHA-256(verifier)) without padding is always 43 characters (RFC 7636, 4.2).
CodeChallenge = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{43}$")]
# Echoed by Google into the redirect's query: unreserved URL characters only (RFC 3986).
OAuthState = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._~-]{1,512}$")]


class GoogleAuthorizationIn(BaseModel):
    redirect_uri: LoopbackRedirectUri
    code_challenge: CodeChallenge
    state: OAuthState


class GoogleAuthorizationOut(BaseModel):
    authorization_url: str


class GoogleConnectionIn(BaseModel):
    # Until the API redeems them, the code and the verifier together are a Google grant: they are
    # left out of `repr`, so a traceback that shows this model's value prints neither. A
    # validation error names the field and the rule, never the value (error_handlers.py).
    code: Annotated[str, Field(repr=False), StringConstraints(pattern=r"^[!-~]{1,2048}$")]
    # RFC 7636, 4.1: 43 to 128 unreserved characters.
    code_verifier: Annotated[
        str, Field(repr=False), StringConstraints(pattern=r"^[A-Za-z0-9._~-]{43,128}$")
    ]
    redirect_uri: LoopbackRedirectUri


class CalendarConnectionOut(BaseModel):
    provider: CalendarProviderName
    account_email: str
    status: CalendarConnectionStatus
    connected_at: UtcDatetime
    # connected_at + 7 days for a Google connection while the consent screen is External in
    # Testing (GOOGLE_OAUTH_AUDIENCE=external_testing), when Google expires its refresh tokens.
    expires_hint: UtcDatetime | None
    # Why the status is `reconnect_required`, as the 424 said it.
    last_error: str | None


class CalendarConnectionEnvelope(BaseModel):
    connection: CalendarConnectionOut | None


class _FromProvider(BaseModel):
    # Built from the provider's dataclasses (services/calendar/provider.py).
    model_config = ConfigDict(from_attributes=True)


class CalendarAttendeeOut(_FromProvider):
    email: str
    display_name: str | None
    response_status: ResponseStatus
    is_self: bool
    is_organizer: bool


class CalendarEventOut(_FromProvider):
    provider: CalendarProviderName
    id: str
    ical_uid: str | None
    recurring_event_id: str | None
    title: str
    status: EventStatus
    all_day: bool
    start: UtcDatetime | None
    end: UtcDatetime | None
    start_date: date | None
    end_date: date | None
    self_response: SelfResponse
    attendees: list[CalendarAttendeeOut]
    attendees_omitted: bool
    video_link: str | None
    video_link_source: VideoLinkSource | None
    html_link: str | None


class CalendarEventsOut(BaseModel):
    items: list[CalendarEventOut]
    # When the API had Google's answer, not when the desktop asked.
    fetched_at: UtcDatetime


class CalendarEventsQuery(BaseModel):
    """`?from=<instant>&to=<instant>`: both with a time zone, `from` first, at most 7 days apart."""

    # `from` is a Python keyword: the field takes it as its alias.
    from_: UtcDatetime = Field(alias="from")
    to: UtcDatetime

    @model_validator(mode="after")
    def _window_fits(self) -> Self:
        if self.from_ >= self.to:
            raise ValueError("from must be before to")
        if self.to - self.from_ > MAX_EVENTS_WINDOW:
            raise ValueError(f"the window is at most {MAX_EVENTS_WINDOW.days} days")
        return self
