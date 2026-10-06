"""Calendar connections and the encrypted refresh token store (M5-T3).

One connection per workspace and user (`calendar_connections`, unique even while `user_id` is
NULL). Every query is scoped to the caller's workspace (house rule 2).

The refresh token is stored as `pgp_sym_encrypt(token, CALENDAR_TOKEN_KEY)` and read back with
`pgp_sym_decrypt` (Postgres pgcrypto; M5 plan, "Token encryption"), so the token and the key are
bind parameters of the statements here. Two traps would put them in the logs:
- A failed statement renders its bind parameters into the error's text, which middleware.py logs
  with the traceback. db/engine.py creates the engine with `hide_parameters=True` for that; it
  points back here. Never turn it off.
- In production a traceback is JSON with every frame's local variables (structlog's
  dict_tracebacks, log.py). Under a failed statement, SQLAlchemy's and asyncpg's frames hold the
  parameters in clear, and FastAPI's hold the request body with the sign-in code and verifier.
  Only structlog's 80-character cut of each local hides the token and the key today, because two
  UUIDs open the parameter tuple: luck, not a guard. So a failed statement here never reaches
  middleware.py as an unhandled error: `_store_failed` logs one `calendar_store_failed` line
  (operation, error class, SQLSTATE) and raises `CalendarStoreError`, a handled 500, `from None`,
  so no traceback is rendered at all. The guard covers the commit too and catches every
  `_STORE_ERRORS`, not only a driver's `DBAPIError`: a lost or busy database fails with errors
  that are not DBAPIErrors, and connect()'s own frame holds the sign-in code and the verifier in
  full. Any other unhandled error under connect() (a bug in the provider, say) still logs them
  in production until log.py stops rendering locals.
Both log formats are tested: tests/test_calendar_api.py::test_db_error_never_leaks_token_or_key
and test_lost_database_never_leaks_the_sign_in_code.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from uuid import UUID, uuid4

from pydantic import SecretStr
from sqlalchemy import ColumnElement, LargeBinary, Row, delete, func, literal, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import DBAPIError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from roger_api.auth import Principal
from roger_api.config_calendar import GoogleOAuthAudience
from roger_api.db.models_calendar import CalendarConnection, CalendarConnectionStatus
from roger_api.errors import AppError, CalendarProviderError, CalendarReconnectRequiredError
from roger_api.log import get_logger
from roger_api.services.calendar.provider import CalendarGrant, CalendarProviderName
from roger_api.services.calendar.runtime import CalendarRuntime

logger = get_logger(__name__)

# Google expires the refresh tokens of an External app in publishing status Testing after 7 days
# (https://developers.google.com/identity/protocols/oauth2, "Refresh token expiration").
GOOGLE_TESTING_GRANT_LIFETIME = timedelta(days=7)
# pgcrypto's "Wrong key or corrupt data": CALENDAR_TOKEN_KEY changed since the token was stored.
_WRONG_KEY_SQLSTATE = "39000"
# The one unique constraint (db/models_calendar.py, migration 0004): one row per workspace and
# user, NULLS NOT DISTINCT, so a NULL user_id row is replaced too.
_ONE_PER_OWNER = "uq_calendar_connections_workspace_id_user_id"
# Every way a statement here can fail. A driver error is a DBAPIError, but a pool that gives up
# waiting raises sqlalchemy.exc.TimeoutError (a SQLAlchemyError, not a DBAPIError), and asyncpg's
# refused or timed-out connect comes up raw as an OSError (builtin TimeoutError is one). Catch
# less and that failure reaches middleware.py with its frames (module docstring).
_STORE_ERRORS = (SQLAlchemyError, OSError)

UNREADABLE_GRANT_MESSAGE = (
    "Roger can no longer read its stored calendar access. Connect Google Calendar again."
)


class CalendarStoreError(AppError):
    """A statement that binds the refresh token or the key failed: a 500 like any unexpected error,
    but handled, so no traceback is logged; `calendar_store_failed` says what failed instead
    (module docstring)."""

    status_code = 500
    code = "internal_error"


@dataclass(frozen=True, slots=True)
class StoredConnection:
    """A connection row as the routes need it."""

    id: UUID
    provider: CalendarProviderName
    account_email: str
    status: CalendarConnectionStatus
    last_error: str | None
    connected_at: datetime
    # pgp_sym_encrypt's output: ciphertext, decrypted only for a refresh or a revoke.
    refresh_token: bytes | None = field(repr=False)

    def expires_hint(self, audience: GoogleOAuthAudience) -> datetime | None:
        """When Google will stop honouring the grant, if it says so in advance.

        Only for Google in Testing; a fake grant and a verified or internal app's never expire on
        a timer.
        """
        if self.provider == "google" and audience == "external_testing":
            return self.connected_at + GOOGLE_TESTING_GRANT_LIFETIME
        return None


# What every query here reads, in this order (`_ConnectionRow`).
_COLUMNS = (
    CalendarConnection.id,
    CalendarConnection.provider,
    CalendarConnection.account_email,
    CalendarConnection.status,
    CalendarConnection.last_error,
    CalendarConnection.connected_at,
    CalendarConnection.refresh_token,
)
type _ConnectionRow = Row[
    UUID,
    CalendarProviderName,
    str,
    CalendarConnectionStatus,
    str | None,
    datetime,
    bytes | None,
]


async def connect(
    session: AsyncSession,
    principal: Principal,
    runtime: CalendarRuntime,
    *,
    code: str,
    code_verifier: str,
    redirect_uri: str,
) -> StoredConnection:
    """Redeems the sign-in code and stores the grant, replacing any connection the caller had.

    Raises `CalendarReconnectRequiredError` (424) when calendar access was not granted or the code
    is no longer valid, `CalendarProviderError` (502) when Google fails; nothing is stored then.
    """
    calendar = runtime.provider
    grant = await calendar.exchange_code(
        code=code, code_verifier=code_verifier, redirect_uri=redirect_uri
    )
    stored = await _save(
        session, principal, provider=calendar.provider, grant=grant, token_key=runtime.token_key
    )
    # The exchange's access token serves the first event lists; no refresh right after connecting.
    runtime.access_tokens.put(principal, stored.id, grant.access_token)
    logger.info(
        "calendar_connected",
        provider=stored.provider,
        connection_id=str(stored.id),
        scopes=list(grant.scopes),
    )
    return stored


async def find_connection(session: AsyncSession, principal: Principal) -> StoredConnection | None:
    row = (await session.execute(select(*_COLUMNS).where(*_owned_by(principal)))).one_or_none()
    return None if row is None else _stored(row)


async def read_refresh_token(
    session: AsyncSession, connection: StoredConnection, token_key: SecretStr | None
) -> SecretStr | None:
    """The connection's refresh token, or None when it has none (the fake provider). A
    `SecretStr`, so no frame here holds it in clear (module docstring); unwrap it in the call.

    Raises `CalendarReconnectRequiredError` when the key cannot decrypt it: CALENDAR_TOKEN_KEY
    changed or is gone, so only connecting again can give Roger a token it can read.
    `CalendarStoreError` (500) when the database fails.
    """
    if connection.refresh_token is None:
        return None
    if token_key is None:
        logger.warning(
            "calendar_token_unreadable",
            connection_id=str(connection.id),
            hint="CALENDAR_TOKEN_KEY is not set",
        )
        raise CalendarReconnectRequiredError(UNREADABLE_GRANT_MESSAGE)
    decrypt = select(
        func.pgp_sym_decrypt(
            literal(connection.refresh_token, LargeBinary), token_key.get_secret_value()
        )
    )
    try:
        decrypted = await session.execute(decrypt)
    # DBAPIError first: it is one of _STORE_ERRORS too, and only a driver error carries the wrong
    # key's SQLSTATE. The other way round, a changed key would be a 500, not a 424.
    except DBAPIError as exc:
        if getattr(exc.orig, "sqlstate", None) != _WRONG_KEY_SQLSTATE:
            raise _store_failed("read the refresh token", exc) from None
        await session.rollback()
        logger.warning(
            "calendar_token_unreadable",
            connection_id=str(connection.id),
            hint="CALENDAR_TOKEN_KEY changed since the calendar was connected",
        )
        raise CalendarReconnectRequiredError(UNREADABLE_GRANT_MESSAGE) from None
    except _STORE_ERRORS as exc:
        raise _store_failed("read the refresh token", exc) from None
    refresh_token: str | None = decrypted.scalar_one()
    return None if refresh_token is None else SecretStr(refresh_token)


def reveal(refresh_token: SecretStr | None) -> str | None:
    """The token in clear, for the provider call it is passed to and nothing else."""
    return None if refresh_token is None else refresh_token.get_secret_value()


async def mark_reconnect_required(
    session: AsyncSession, principal: Principal, connection_id: UUID, message: str
) -> None:
    """Records that only connecting again helps, with the message the 424 gave.

    By id, so a connection made meanwhile (a new row id) keeps its `active` status.
    """
    await session.execute(
        update(CalendarConnection)
        .where(*_owned_by(principal), CalendarConnection.id == connection_id)
        .values(status="reconnect_required", last_error=message)
    )
    await session.commit()


async def disconnect(session: AsyncSession, principal: Principal, runtime: CalendarRuntime) -> None:
    """Deletes the caller's connection, then revokes its grant at the provider. Repeatable.

    The row goes first: a revoke that fails (Google down, the grant already gone) is logged and
    the connection stays deleted, as the user asked.
    """
    deleted = (
        await session.execute(
            delete(CalendarConnection).where(*_owned_by(principal)).returning(*_COLUMNS)
        )
    ).one_or_none()
    await session.commit()
    runtime.access_tokens.drop(principal)
    if deleted is None:
        return
    connection = _stored(deleted)
    logger.info(
        "calendar_disconnected", provider=connection.provider, connection_id=str(connection.id)
    )
    calendar = runtime.provider
    if connection.provider != calendar.provider:
        # Another provider's grant (CALENDAR_PROVIDER changed since): this one cannot revoke it.
        logger.warning(
            "calendar_revoke_skipped",
            provider=connection.provider,
            connection_id=str(connection.id),
            reason=f"CALENDAR_PROVIDER is {calendar.provider} now",
        )
        return
    try:
        refresh_token = await read_refresh_token(session, connection, runtime.token_key)
        # End the read before waiting on Google, as events.py does: the decrypt began a new
        # transaction, and its pooled connection must not sit idle in it for the revoke.
        await session.commit()
        await calendar.revoke(reveal(refresh_token))
    except (CalendarProviderError, CalendarReconnectRequiredError) as exc:
        logger.warning(
            "calendar_revoke_failed",
            provider=connection.provider,
            connection_id=str(connection.id),
            error=exc.message,
        )


async def _save(
    session: AsyncSession,
    principal: Principal,
    *,
    provider: CalendarProviderName,
    grant: CalendarGrant,
    token_key: SecretStr | None,
) -> StoredConnection:
    if grant.refresh_token is not None and token_key is None:
        # pgp_sym_encrypt with a NULL key is NULL: the token would be lost without a word.
        raise RuntimeError("CALENDAR_TOKEN_KEY is required to store a calendar refresh token")
    encrypted_token: ColumnElement[bytes] | None = (
        None
        if grant.refresh_token is None or token_key is None
        else func.pgp_sym_encrypt(
            grant.refresh_token, token_key.get_secret_value(), type_=LargeBinary
        )
    )
    insert_row = insert(CalendarConnection).values(
        # A new id on every connect, also when it replaces a row (so "id" is in `replaced` below):
        # the access token cached for the old grant (runtime.AccessTokenCache) is keyed by it and
        # is never used for the new one. tests/test_calendar_api.py::
        # test_connection_again_replaces_the_connection fails without it.
        id=uuid4(),
        workspace_id=principal.workspace_id,
        user_id=principal.user_id,
        provider=provider,
        account_email=grant.account_email,
        scopes=" ".join(grant.scopes),
        refresh_token=encrypted_token,
        status="active",
        last_error=None,
        connected_at=func.now(),
    )
    replaced = {
        name: insert_row.excluded[name]
        for name in (
            "id",
            "provider",
            "account_email",
            "scopes",
            "refresh_token",
            "status",
            "last_error",
            "connected_at",
        )
    }
    upsert = insert_row.on_conflict_do_update(
        constraint=_ONE_PER_OWNER,
        set_={**replaced, "created_at": func.now(), "updated_at": func.now()},
    ).returning(*_COLUMNS)
    try:
        row = (await session.execute(upsert)).one()
        await session.commit()
    except _STORE_ERRORS as exc:
        raise _store_failed("store the connection", exc) from None
    return _stored(row)


def _store_failed(operation: str, exc: SQLAlchemyError | OSError) -> CalendarStoreError:
    """Logs a failed statement that binds the token or the key, naming no value (module
    docstring). Raise what it returns `from None`: the original error's frames hold both."""
    # A DBAPIError wraps the driver's error, which carries the SQLSTATE.
    cause = exc.orig if isinstance(exc, DBAPIError) and exc.orig is not None else exc
    logger.error(
        "calendar_store_failed",
        operation=operation,
        # Qualified: sqlalchemy.exc.TimeoutError (pool) and builtins.TimeoutError (network) share
        # a name.
        error=f"{type(cause).__module__}.{type(cause).__qualname__}",
        sqlstate=getattr(cause, "sqlstate", None),
    )
    return CalendarStoreError("Internal server error")


def _owned_by(principal: Principal) -> tuple[ColumnElement[bool], ...]:
    return (
        CalendarConnection.workspace_id == principal.workspace_id,
        CalendarConnection.user_id.is_(None)
        if principal.user_id is None
        else CalendarConnection.user_id == principal.user_id,
    )


def _stored(row: _ConnectionRow) -> StoredConnection:
    return StoredConnection(
        id=row.id,
        provider=row.provider,
        account_email=row.account_email,
        status=row.status,
        last_error=row.last_error,
        connected_at=row.connected_at,
        refresh_token=row.refresh_token,
    )
