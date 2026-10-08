"""Calendar routes (M5-T3): Google sign-in, the connection, and the events window.

app.py includes `router` once; its prefix, tags, responses and routes live here. Every route
resolves the `Principal` first (`PrincipalDep`, its first dependency): FastAPI solves dependencies
before it validates the body or the query, so a request without the token is a 401, never a 422.
tests/test_auth.py fails any route that answers without a token. The desktop never sees a Google
token (house rule 3): it sends the one-time code and the PKCE verifier, and the API keeps the
refresh token, encrypted (services/calendar/connections.py).
"""

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query, Response

from roger_api.auth import PrincipalDep
from roger_api.dependencies import SessionDep
from roger_api.routers.responses import ERROR_RESPONSES
from roger_api.schemas.calendar import (
    CalendarConnectionEnvelope,
    CalendarConnectionOut,
    CalendarEventOut,
    CalendarEventsOut,
    CalendarEventsQuery,
    GoogleAuthorizationIn,
    GoogleAuthorizationOut,
    GoogleConnectionIn,
)
from roger_api.schemas.common import ErrorEnvelope
from roger_api.services.calendar import connections, events
from roger_api.services.calendar.connections import StoredConnection
from roger_api.services.calendar.runtime import CalendarRuntime, CalendarRuntimeDep

router = APIRouter(prefix="/v1/calendar", tags=["calendar"], responses=ERROR_RESPONSES)

_RECONNECT_REQUIRED: dict[int | str, dict[str, Any]] = {
    424: {
        "model": ErrorEnvelope,
        "description": "calendar_reconnect_required: only connecting again helps",
    }
}
_PROVIDER_ERROR: dict[int | str, dict[str, Any]] = {
    502: {"model": ErrorEnvelope, "description": "calendar_provider_error: Google failed"}
}
_NOT_CONFIGURED: dict[int | str, dict[str, Any]] = {
    503: {
        "model": ErrorEnvelope,
        "description": "calendar_not_configured: the server has no calendar provider",
    }
}
_NOT_CONNECTED: dict[int | str, dict[str, Any]] = {
    404: {"model": ErrorEnvelope, "description": "No calendar is connected"}
}


@router.post("/google/authorization", responses=_NOT_CONFIGURED)
async def create_google_authorization(
    principal: PrincipalDep, body: GoogleAuthorizationIn, runtime: CalendarRuntimeDep
) -> GoogleAuthorizationOut:
    url = runtime.provider.authorization_url(
        redirect_uri=body.redirect_uri, code_challenge=body.code_challenge, state=body.state
    )
    return GoogleAuthorizationOut(authorization_url=url)


@router.post(
    "/google/connection",
    status_code=201,
    responses={**_RECONNECT_REQUIRED, **_PROVIDER_ERROR, **_NOT_CONFIGURED},
)
async def connect_google(
    principal: PrincipalDep,
    body: GoogleConnectionIn,
    session: SessionDep,
    runtime: CalendarRuntimeDep,
) -> CalendarConnectionOut:
    connection = await connections.connect(
        session,
        principal,
        runtime,
        code=body.code,
        code_verifier=body.code_verifier,
        redirect_uri=body.redirect_uri,
    )
    return _connection_out(connection, runtime)


@router.get("/connection")
async def get_connection(
    principal: PrincipalDep, session: SessionDep, runtime: CalendarRuntimeDep
) -> CalendarConnectionEnvelope:
    connection = await connections.find_connection(session, principal)
    return CalendarConnectionEnvelope(
        connection=None if connection is None else _connection_out(connection, runtime)
    )


@router.delete("/connection", status_code=204, response_class=Response)
async def disconnect(
    principal: PrincipalDep, session: SessionDep, runtime: CalendarRuntimeDep
) -> None:
    await connections.disconnect(session, principal, runtime)


@router.get(
    "/events",
    responses={**_NOT_CONNECTED, **_RECONNECT_REQUIRED, **_PROVIDER_ERROR, **_NOT_CONFIGURED},
)
async def list_events(
    principal: PrincipalDep,
    window: Annotated[CalendarEventsQuery, Query()],
    session: SessionDep,
    runtime: CalendarRuntimeDep,
) -> CalendarEventsOut:
    items = await events.list_events(
        session, principal, runtime, time_min=window.from_, time_max=window.to
    )
    return CalendarEventsOut(
        items=[CalendarEventOut.model_validate(item) for item in items],
        fetched_at=datetime.now(UTC),
    )


def _connection_out(
    connection: StoredConnection, runtime: CalendarRuntime
) -> CalendarConnectionOut:
    return CalendarConnectionOut(
        provider=connection.provider,
        account_email=connection.account_email,
        status=connection.status,
        connected_at=connection.connected_at,
        expires_hint=connection.expires_hint(runtime.audience),
        last_error=connection.last_error,
    )
