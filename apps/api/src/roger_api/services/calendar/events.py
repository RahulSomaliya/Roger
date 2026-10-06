"""The caller's calendar events, fetched live from the provider (M5-T3).

Events are not stored on the API (M5 plan, "Where events are kept"): each call lists the window
from Google, and the desktop keeps the last good answer. What is kept is the access token, in
memory (runtime.AccessTokenCache): used until a minute before it expires, refreshed from the stored
refresh token when it is missing or about to expire, and refreshed once more when Google refuses it
(a `401`), with one retry.

A `424` here is final until the user connects again: the connection is marked
`reconnect_required` with the 424's message, and later calls answer it without asking Google. One
`424` stores nothing: CALENDAR_PROVIDER changed since the connect, which restoring the setting
undoes (`list_events`).
"""

from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from roger_api.auth import Principal
from roger_api.errors import CalendarReconnectRequiredError, NotFoundError
from roger_api.log import get_logger
from roger_api.services.calendar import connections
from roger_api.services.calendar.connections import StoredConnection
from roger_api.services.calendar.provider import (
    CalendarAccessTokenRejectedError,
    CalendarEvent,
)
from roger_api.services.calendar.runtime import CalendarRuntime

logger = get_logger(__name__)

NOT_CONNECTED_MESSAGE = "No calendar is connected"
RECONNECT_MESSAGE = "Google Calendar needs to be connected again."


async def list_events(
    session: AsyncSession,
    principal: Principal,
    runtime: CalendarRuntime,
    *,
    time_min: datetime,
    time_max: datetime,
) -> list[CalendarEvent]:
    """Events that end after `time_min` and start before `time_max`, ordered by start.

    Raises `NotFoundError` with no connection, `CalendarReconnectRequiredError` (424) when only
    connecting again helps, `CalendarProviderError` (502) when the provider fails.
    """
    connection = await connections.find_connection(session, principal)
    if connection is None:
        raise NotFoundError(NOT_CONNECTED_MESSAGE)
    if connection.status == "reconnect_required":
        raise CalendarReconnectRequiredError(connection.last_error or RECONNECT_MESSAGE)
    calendar = runtime.provider
    if connection.provider != calendar.provider:
        # CALENDAR_PROVIDER changed since the connect: this provider cannot use that grant. Raised
        # here, outside the `try` below, so it is never stored as reconnect_required: the grant
        # is still good, and setting CALENDAR_PROVIDER back must serve events again without a new
        # sign-in (the desktop stops polling on a 424 until a launch).
        raise CalendarReconnectRequiredError(
            f"Roger now reads the {calendar.provider} calendar. Connect the calendar again."
        )
    # End the read before waiting on Google: a pooled connection must not sit idle in a
    # transaction for the length of a provider call.
    await session.commit()
    try:
        return await _list_with_access(
            session, principal, runtime, connection, time_min=time_min, time_max=time_max
        )
    except CalendarReconnectRequiredError as exc:
        await connections.mark_reconnect_required(session, principal, connection.id, exc.message)
        logger.warning(
            "calendar_reconnect_required",
            provider=connection.provider,
            connection_id=str(connection.id),
            reason=exc.message,
        )
        raise


async def _list_with_access(
    session: AsyncSession,
    principal: Principal,
    runtime: CalendarRuntime,
    connection: StoredConnection,
    *,
    time_min: datetime,
    time_max: datetime,
) -> list[CalendarEvent]:
    calendar = runtime.provider
    access_token = runtime.access_tokens.get(principal, connection.id)
    if access_token is None:
        access_token = await _refresh(session, principal, runtime, connection)
    try:
        return await calendar.list_events(access_token, time_min=time_min, time_max=time_max)
    except CalendarAccessTokenRejectedError:
        # Most often a token that expired early or was revoked with its grant. One refresh and
        # one retry; a second refusal is a 502, never a loop.
        logger.info("calendar_access_token_rejected", connection_id=str(connection.id))
        runtime.access_tokens.drop(principal)
        access_token = await _refresh(session, principal, runtime, connection)
        return await calendar.list_events(access_token, time_min=time_min, time_max=time_max)


async def _refresh(
    session: AsyncSession,
    principal: Principal,
    runtime: CalendarRuntime,
    connection: StoredConnection,
) -> str:
    refresh_token = await connections.read_refresh_token(session, connection, runtime.token_key)
    await session.commit()
    access_token = await runtime.provider.refresh(connections.reveal(refresh_token))
    runtime.access_tokens.put(principal, connection.id, access_token)
    return access_token.value
