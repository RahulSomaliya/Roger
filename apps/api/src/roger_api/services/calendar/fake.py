"""The fake calendar provider: `CALENDAR_PROVIDER=fake`, the default.

Every screen, test and demo runs with no Google client (M5 plan, constraint C4):
- Sign-in: the authorization URL is the desktop's own loopback redirect with `code=fake`, so the
  whole browser round trip runs; the exchange grants a fake account and stores no refresh token.
- Events: a script anchored to the API's start time, so they stay put between polls and a restart
  brings a fresh "call in 2 minutes". It is written as Google's own `events.list` JSON and read
  through `normalize.py`, so the fake exercises the same code as Google.
- `FAKE_CALENDAR_FILE` replaces the script with a file in that same JSON, absolute times and all
  (a captured Google answer works as is). It is read once, at startup, and a bad file stops the
  start with its path named.
"""

from datetime import UTC, date, datetime, time, timedelta, tzinfo
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import ValidationError

from roger_api.errors import CalendarReconnectRequiredError
from roger_api.services.calendar.google import CALENDAR_SCOPE
from roger_api.services.calendar.normalize import GoogleEventsPage, UnreadableEventError, read_event
from roger_api.services.calendar.provider import (
    AccessToken,
    CalendarEvent,
    CalendarGrant,
    CalendarProviderName,
    require_aware,
)

FAKE_CODE = "fake"
FAKE_ACCOUNT_EMAIL = "you@example.com"
FAKE_ACCESS_TOKEN = "fake-access-token"  # noqa: S105 - a placeholder that opens nothing
FAKE_SCOPES = ("openid", "email", CALENDAR_SCOPE)
_TOKEN_LIFETIME_SECONDS = 3600

type _Json = dict[str, Any]


class FakeCalendarProvider:
    """Answers like Google from a script (or `FAKE_CALENDAR_FILE`), with no network."""

    def __init__(
        self,
        *,
        started_at: datetime,
        events_file: Path | None = None,
        local_zone: tzinfo | None = None,
    ) -> None:
        anchor = require_aware(started_at, "started_at").replace(microsecond=0)
        # All-day dates are read in this zone, as Google reads them in the calendar's: the
        # machine's own unless a test pins one. `astimezone()` with no argument always sets it.
        self._zone: tzinfo = local_zone or anchor.astimezone().tzinfo or UTC
        # The local date of the start: the built-in all-day item is on it.
        self.today = anchor.astimezone(self._zone).date()
        if events_file is None:
            script = _script(anchor, self.today)
            events = [event for item in script if (event := read_event(item, provider="fake"))]
        else:
            events = _read_file(events_file)
        # Google's `orderBy=startTime`; a stable sort keeps the file's order for equal starts.
        self._events = sorted(events, key=self._starts_at)

    @property
    def provider(self) -> CalendarProviderName:
        return "fake"

    def authorization_url(self, *, redirect_uri: str, code_challenge: str, state: str) -> str:
        # Straight back to the desktop's listener, as Google would after consent. The route has
        # already refused any redirect that is not 127.0.0.1, so this opens nothing else.
        parts = urlsplit(redirect_uri)
        query = [*parse_qsl(parts.query, keep_blank_values=True), ("code", FAKE_CODE)]
        return urlunsplit(parts._replace(query=urlencode([*query, ("state", state)])))

    async def exchange_code(
        self, *, code: str, code_verifier: str, redirect_uri: str
    ) -> CalendarGrant:
        if code != FAKE_CODE:
            # What Google answers for a code it never issued.
            raise CalendarReconnectRequiredError(
                "The fake calendar did not issue this code. Connect the calendar again."
            )
        return CalendarGrant(
            account_email=FAKE_ACCOUNT_EMAIL,
            scopes=FAKE_SCOPES,
            refresh_token=None,
            access_token=await self.refresh(None),
        )

    async def refresh(self, refresh_token: str | None) -> AccessToken:
        return AccessToken(value=FAKE_ACCESS_TOKEN, expires_in_seconds=_TOKEN_LIFETIME_SECONDS)

    async def revoke(self, refresh_token: str | None) -> None:
        return None  # Nothing was granted anywhere.

    async def list_events(
        self, access_token: str, *, time_min: datetime, time_max: datetime
    ) -> list[CalendarEvent]:
        lower = require_aware(time_min, "time_min")
        upper = require_aware(time_max, "time_max")
        # Google's bounds: an event is listed when it ends after timeMin and starts before timeMax.
        return [
            event
            for event in self._events
            if self._ends_at(event) > lower and self._starts_at(event) < upper
        ]

    def _starts_at(self, event: CalendarEvent) -> datetime:
        return event.start or self._midnight(event.start_date)

    def _ends_at(self, event: CalendarEvent) -> datetime:
        return event.end or self._midnight(event.end_date)

    def _midnight(self, day: date | None) -> datetime:
        if day is None:  # CalendarEvent's own check makes this unreachable.
            raise ValueError("an all-day event without its dates")
        return datetime.combine(day, time(), tzinfo=self._zone)


def _read_file(path: Path) -> list[CalendarEvent]:
    try:
        content = path.read_bytes()
    except OSError as exc:
        raise ValueError(f"FAKE_CALENDAR_FILE {path} cannot be read: {exc.strerror}") from exc
    try:
        page = GoogleEventsPage.model_validate_json(content)
    except ValidationError as exc:
        problems = "; ".join(
            f"{'.'.join(str(part) for part in error['loc']) or 'file'}: {error['msg']}"
            for error in exc.errors(include_url=False, include_input=False)
        )
        raise ValueError(
            f"FAKE_CALENDAR_FILE {path} is not an events.list page: {problems}"
        ) from exc
    events: list[CalendarEvent] = []
    for index, item in enumerate(page.items):
        try:
            event = read_event(item, provider="fake")
        except UnreadableEventError as exc:
            raise ValueError(f"FAKE_CALENDAR_FILE {path}, item {index}: {exc}") from exc
        if event is not None:
            events.append(event)
    return events


def _script(anchor: datetime, today: date) -> list[_Json]:
    """Google `events.list` items for the built-in day, relative to the API's start time."""

    def at(minutes: int) -> _Json:
        return {"dateTime": (anchor + timedelta(minutes=minutes)).isoformat()}

    def meet(code: str) -> _Json:
        link = f"https://meet.google.com/{code}"
        return {
            "hangoutLink": link,
            "conferenceData": {"entryPoints": [{"entryPointType": "video", "uri": link}]},
        }

    me = {"email": FAKE_ACCOUNT_EMAIL, "self": True, "responseStatus": "accepted"}
    jane = {"email": "jane@example.com", "displayName": "Jane Cooper", "organizer": True}
    ali = {"email": "ali@example.com", "displayName": "Ali Khan", "responseStatus": "tentative"}
    organizer_me = {"organizer": {"email": FAKE_ACCOUNT_EMAIL, "self": True}}
    standup_start = anchor + timedelta(minutes=30)

    return [
        {
            "id": "fake-all-day",
            "summary": "Release week",
            "start": {"date": today.isoformat()},
            "end": {"date": (today + timedelta(days=1)).isoformat()},
            **organizer_me,
        },
        {
            # The call the prompt is for: two minutes after the API started.
            "id": "fake-call",
            "summary": "Weekly sync",
            "start": at(2),
            "end": at(32),
            "organizer": {"email": jane["email"], "displayName": jane["displayName"]},
            "attendees": [{**jane, "responseStatus": "accepted"}, me, ali],
            **meet("abc-defg-hij"),
        },
        {
            # A recurring instance moved 15 minutes later: Google keeps its original id.
            "id": f"fake-standup_{standup_start:%Y%m%dT%H%M%SZ}",
            "recurringEventId": "fake-standup",
            "originalStartTime": at(30),
            "iCalUID": "fake-standup@example.com",
            "summary": "Daily standup",
            "start": at(45),
            "end": at(60),
            "attendees": [{**jane, "responseStatus": "accepted"}, me],
            **meet("rog-erst-and"),
        },
        {
            "id": "fake-declined",
            "summary": "Vendor demo",
            "start": at(90),
            "end": at(120),
            "attendees": [
                {"email": "sales@vendor.example", "organizer": True, "responseStatus": "accepted"},
                {**me, "responseStatus": "declined"},
            ],
            "location": "https://zoom.us/j/1234567890",
        },
        {
            # Workspace adds a Meet link to every new event: not evidence of a call by itself.
            "id": "fake-focus",
            "summary": "Focus time",
            "start": at(150),
            "end": at(210),
            **organizer_me,
            **meet("foc-usti-mes"),
        },
        {
            # A link someone typed is evidence of a call, guests or not.
            "id": "fake-solo-zoom",
            "summary": "Client call (Zoom link in the location)",
            "start": at(240),
            "end": at(270),
            **organizer_me,
            "location": "https://us02web.zoom.us/j/81234567890?pwd=fake",
        },
        {
            "id": "fake-tomorrow",
            "summary": "Planning with Ali",
            "start": at(24 * 60),
            "end": at(24 * 60 + 30),
            "organizer": {"email": ali["email"], "displayName": ali["displayName"]},
            "attendees": [{**ali, "organizer": True, "responseStatus": "accepted"}, me],
            "description": (
                'Teams: <a href="https://teams.microsoft.com/l/meetup-join/'
                '19%3ameeting_fake%40thread.v2/0?context=%7b%7d">Join the meeting</a>'
            ),
        },
    ]
