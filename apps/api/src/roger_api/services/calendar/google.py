"""Google Calendar over httpx: the `CalendarProvider` for `CALENDAR_PROVIDER=google`.

Sources (read 2026-10-06):
- OAuth for installed apps, loopback redirect and PKCE:
  https://developers.google.com/identity/protocols/oauth2/native-app
- Refresh tokens, `invalid_grant`, revocation: https://developers.google.com/identity/protocols/oauth2
- The ID token: https://developers.google.com/identity/openid-connect/openid-connect
- `events.list`: https://developers.google.com/workspace/calendar/api/v3/reference/events/list

Nothing here logs a request: the token requests carry the client secret, the code, the PKCE
verifier and the refresh token in their bodies, and `events.list` carries the access token in its
header. Logs name the operation, the HTTP status and Google's error code, nothing else. A success
body holds tokens too, so an unreadable one is logged by error location only, never by `str(exc)`.
"""

import base64
from collections.abc import Awaitable
from datetime import datetime
from urllib.parse import urlencode

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from roger_api.errors import CalendarProviderError, CalendarReconnectRequiredError
from roger_api.log import get_logger
from roger_api.services.calendar.normalize import GoogleEventsPage, UnreadableEventError, read_event
from roger_api.services.calendar.provider import (
    AccessToken,
    CalendarAccessTokenRejectedError,
    CalendarEvent,
    CalendarGrant,
    CalendarProviderName,
    require_aware,
)

logger = get_logger(__name__)

GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - a URL, not a secret
GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
GOOGLE_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
# The narrowest documented scope that reads invites on the primary calendar (M5 plan, Design,
# "Scopes"). `email` names the account in Settings; it comes back in the ID token.
CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly"
SCOPES = ("openid", "email", CALENDAR_SCOPE)
# Set on every request, so the provider times out the same whatever client it was given.
GOOGLE_TIMEOUT = httpx.Timeout(10.0)
# Google's attendee cap per event; it sets `attendeesOmitted` on events it cut.
MAX_ATTENDEES = 100
# A 72-hour window is one page of 250 events. The repeated-token check stops a loop; this stops a
# Google that hands out a new token on every page, which would otherwise hold the request open.
MAX_EVENT_PAGES = 20
# 403 reasons that mean the token lacks calendar access, which only connecting again can grant.
_MISSING_SCOPE_REASONS = frozenset({"insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"})

SCOPE_MISSING_MESSAGE = (
    "Roger cannot see your calendar events. Connect Google Calendar again and tick "
    '"View events on all your calendars".'
)
REFRESH_REFUSED_MESSAGE = (
    "Google no longer accepts Roger's access to your calendar. Reconnect Google Calendar."
)
CODE_REFUSED_MESSAGE = "Google did not accept the sign-in. Connect Google Calendar again."


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)


class _TokenResponse(_Model):
    access_token: str = Field(min_length=1)
    expires_in: int = Field(gt=0)
    refresh_token: str | None = None
    # Space-separated, as granted: the user can untick the calendar scope on the consent screen.
    scope: str = ""
    id_token: str | None = None


class _OAuthError(_Model):
    error: str | None = None


class _ApiErrorItem(_Model):
    reason: str | None = None


class _ApiError(_Model):
    status: str | None = None
    errors: list[_ApiErrorItem] = Field(default_factory=list)
    details: list[_ApiErrorItem] = Field(default_factory=list)


class _ApiErrorBody(_Model):
    error: _ApiError | None = None


class _IdTokenClaims(_Model):
    email: str = Field(min_length=1)


class GoogleCalendarProvider:
    """Google's OAuth endpoints and `events.list` on the primary calendar."""

    def __init__(self, http: httpx.AsyncClient, *, client_id: str, client_secret: str) -> None:
        self._http = http
        self._client_id = client_id
        # Google requires it at the token endpoint for a Desktop client and says installed apps
        # cannot keep it secret; it stays on the API all the same (M5 plan, "OAuth client").
        self._client_secret = client_secret

    @property
    def provider(self) -> CalendarProviderName:
        return "google"

    def authorization_url(self, *, redirect_uri: str, code_challenge: str, state: str) -> str:
        query = urlencode(
            {
                "client_id": self._client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": " ".join(SCOPES),
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
                "state": state,
                # A refresh token, and on every connect: Google returns one only when the consent
                # screen is shown, so a reconnect without `prompt=consent` would store none.
                "access_type": "offline",
                "prompt": "consent",
                # M6's Google sign-in adds its scopes to this same grant.
                "include_granted_scopes": "true",
            }
        )
        return f"{GOOGLE_AUTHORIZATION_URL}?{query}"

    async def exchange_code(
        self, *, code: str, code_verifier: str, redirect_uri: str
    ) -> CalendarGrant:
        response = await _send(
            "exchange",
            self._http.post(
                GOOGLE_TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "code_verifier": code_verifier,
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "redirect_uri": redirect_uri,
                },
                timeout=GOOGLE_TIMEOUT,
            ),
        )
        if response.is_error:
            # A code is single use and short lived: a used or expired one means start over.
            if _oauth_error("exchange", response) == "invalid_grant":
                raise CalendarReconnectRequiredError(CODE_REFUSED_MESSAGE)
            raise CalendarProviderError(
                f"Google refused the calendar sign-in (HTTP {response.status_code})"
            )

        token = _read("exchange", response, _TokenResponse)
        scopes = tuple(token.scope.split())
        if CALENDAR_SCOPE not in scopes:
            logger.info("calendar_scope_missing", granted=list(scopes))
            raise CalendarReconnectRequiredError(SCOPE_MISSING_MESSAGE)
        if not token.refresh_token:
            logger.warning("calendar_google_unreadable", operation="exchange", missing="refresh")
            raise CalendarProviderError("Google sent no refresh token for the calendar")
        return CalendarGrant(
            account_email=_id_token_email(token.id_token),
            scopes=scopes,
            refresh_token=token.refresh_token,
            access_token=AccessToken(value=token.access_token, expires_in_seconds=token.expires_in),
        )

    async def refresh(self, refresh_token: str | None) -> AccessToken:
        if not refresh_token:
            raise CalendarReconnectRequiredError(REFRESH_REFUSED_MESSAGE)
        response = await _send(
            "refresh",
            self._http.post(
                GOOGLE_TOKEN_URL,
                data={
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                },
                timeout=GOOGLE_TIMEOUT,
            ),
        )
        if response.is_error:
            # Revoked, expired (7 days for an External app in Testing), or the user removed
            # Roger's access on their Google account page.
            if _oauth_error("refresh", response) == "invalid_grant":
                raise CalendarReconnectRequiredError(REFRESH_REFUSED_MESSAGE)
            raise CalendarProviderError(
                f"Google refused to refresh calendar access (HTTP {response.status_code})"
            )
        token = _read("refresh", response, _TokenResponse)
        return AccessToken(value=token.access_token, expires_in_seconds=token.expires_in)

    async def revoke(self, refresh_token: str | None) -> None:
        if not refresh_token:
            return  # Nothing was granted that Google could still honour.
        response = await _send(
            "revoke",
            self._http.post(
                GOOGLE_REVOKE_URL, data={"token": refresh_token}, timeout=GOOGLE_TIMEOUT
            ),
        )
        if response.is_error:
            _oauth_error("revoke", response)
            raise CalendarProviderError(
                f"Google refused to revoke calendar access (HTTP {response.status_code})"
            )

    async def list_events(
        self, access_token: str, *, time_min: datetime, time_max: datetime
    ) -> list[CalendarEvent]:
        query = {
            # RFC 3339 with an offset, which Google requires on both bounds.
            "timeMin": require_aware(time_min, "time_min").isoformat(),
            "timeMax": require_aware(time_max, "time_max").isoformat(),
            # Recurring events expanded: each instance has its own id and start.
            "singleEvents": "true",
            "orderBy": "startTime",
            # Drops focus time, out of office, working location, birthdays and Gmail items.
            "eventTypes": "default",
            "maxAttendees": str(MAX_ATTENDEES),
        }
        events: list[CalendarEvent] = []
        seen_tokens: set[str] = set()
        page_token: str | None = None
        for _ in range(MAX_EVENT_PAGES):
            params = query if page_token is None else {**query, "pageToken": page_token}
            page = await self._events_page(access_token, params)
            events.extend(_read_items(page))
            page_token = page.next_page_token
            if page_token is None:
                return events
            # A token seen before would loop forever (anarlog crates/calendar/src/fetch.rs).
            if page_token in seen_tokens:
                logger.warning("calendar_google_unreadable", operation="list_events", page="loop")
                raise CalendarProviderError("Google Calendar repeated a page of events")
            seen_tokens.add(page_token)
        logger.warning("calendar_google_unreadable", operation="list_events", pages=MAX_EVENT_PAGES)
        raise CalendarProviderError(
            f"Google Calendar sent more than {MAX_EVENT_PAGES} pages of events"
        )

    async def _events_page(self, access_token: str, params: dict[str, str]) -> GoogleEventsPage:
        response = await _send(
            "list_events",
            self._http.get(
                GOOGLE_EVENTS_URL,
                params=params,
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=GOOGLE_TIMEOUT,
            ),
        )
        if response.is_error:
            reasons = _api_error_reasons(response)
            if response.status_code == 401:
                raise CalendarAccessTokenRejectedError("Google Calendar refused the access token")
            if response.status_code == 403 and reasons & _MISSING_SCOPE_REASONS:
                raise CalendarReconnectRequiredError(SCOPE_MISSING_MESSAGE)
            raise CalendarProviderError(
                f"Google Calendar refused the event list (HTTP {response.status_code})"
            )
        return _read("list_events", response, GoogleEventsPage)


def _read_items(page: GoogleEventsPage) -> list[CalendarEvent]:
    events: list[CalendarEvent] = []
    for item in page.items:
        try:
            event = read_event(item, provider="google")
        except UnreadableEventError as exc:
            # One odd event must not cost the user every other prompt of the day, so it is left
            # out and logged by id; the error names no title, attendee or description.
            logger.warning("calendar_event_skipped", event_id=exc.event_id, error=str(exc))
            continue
        if event is not None:
            events.append(event)
    return events


async def _send(operation: str, request: Awaitable[httpx.Response]) -> httpx.Response:
    """Awaits a request to Google; a network failure or timeout is a `CalendarProviderError`."""
    try:
        return await request
    except httpx.HTTPError as exc:
        # The exception's class and text only: httpx puts no request body or header in either.
        logger.warning("calendar_google_unreachable", operation=operation, error=repr(exc))
        raise CalendarProviderError("Google Calendar is unreachable") from exc


def _read[M: BaseModel](operation: str, response: httpx.Response, schema: type[M]) -> M:
    try:
        return schema.model_validate_json(response.content)
    except ValidationError as exc:
        # Locations and types only: `str(exc)` would quote the input, and the body holds tokens.
        logger.warning(
            "calendar_google_unreadable",
            operation=operation,
            errors=exc.errors(include_url=False, include_input=False, include_context=False),
        )
        raise CalendarProviderError("Google Calendar sent an unreadable answer") from exc


def _oauth_error(operation: str, response: httpx.Response) -> str | None:
    """Google's OAuth error code (`invalid_grant`, `invalid_client`), logged with the status."""
    try:
        error = _OAuthError.model_validate_json(response.content).error
    except ValidationError:
        error = None  # Not Google's JSON (a proxy's HTML page): the status says enough.
    logger.warning(
        "calendar_google_refused", operation=operation, status=response.status_code, error=error
    )
    return error


def _api_error_reasons(response: httpx.Response) -> set[str]:
    """The reasons in a Calendar API error body, logged with the status."""
    try:
        body = _ApiErrorBody.model_validate_json(response.content).error
    except ValidationError:
        body = None  # Not Google's JSON (a proxy's HTML page): the status says enough.
    reasons = (
        {item.reason for item in [*body.errors, *body.details] if item.reason} if body else set()
    )
    logger.warning(
        "calendar_google_refused",
        operation="list_events",
        status=response.status_code,
        error=body.status if body else None,
        reasons=sorted(reasons),
    )
    return reasons


def _id_token_email(id_token: str | None) -> str:
    """The account email from the ID token, read with stdlib base64 and json only.

    The signature is not verified: the token came straight from Google's token endpoint over TLS
    on a request authenticated with the client secret, which Google says is enough (OpenID
    Connect, "Validating an ID token"). Never `import jwt` for this: pyproject.toml bans it.
    """
    parts = id_token.split(".") if id_token else []
    try:
        if len(parts) != 3:
            raise ValueError("an ID token has three parts")
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        return _IdTokenClaims.model_validate_json(base64.urlsafe_b64decode(payload)).email
    except ValueError as exc:  # binascii.Error and ValidationError are both ValueErrors.
        # The reason without the token: an ID token is a credential too.
        logger.warning("calendar_google_unreadable", operation="exchange", missing="email")
        raise CalendarProviderError("Google sent no readable account email") from exc
