"""FastAPI dependencies for the objects `create_app` stores on `app.state`.

Phase 2 features keep their getters and `Dep` aliases in their own service module
(`services/llm_runs.py` for `app.state.llm_runtime`, `services/calendar/runtime.py` for
`app.state.calendar_runtime`), never here, so parallel tasks never edit this file
(phase-2-build-order.md, section 1).
"""

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from roger_api.config import Settings
from roger_api.db.engine import Database
from roger_api.services.stt_tokens import SttTokenIssuer


def _from_state[T](request: Request, name: str, kind: type[T]) -> T:
    value = getattr(request.app.state, name, None)
    if not isinstance(value, kind):
        raise RuntimeError(f"app.state.{name} is not set; build the app with create_app()")
    return value


def get_app_settings(request: Request) -> Settings:
    return _from_state(request, "settings", Settings)


def get_database(request: Request) -> Database:
    return _from_state(request, "database", Database)


def get_stt_token_issuer(request: Request) -> SttTokenIssuer:
    # SttTokenIssuer is a runtime-checkable Protocol: isinstance works, mypy wants a concrete class.
    return _from_state(request, "stt_token_issuer", SttTokenIssuer)  # type: ignore[type-abstract]


async def get_session(
    database: Annotated[Database, Depends(get_database)],
) -> AsyncIterator[AsyncSession]:
    async with database.session() as session:
        yield session


SettingsDep = Annotated[Settings, Depends(get_app_settings)]
DatabaseDep = Annotated[Database, Depends(get_database)]
SessionDep = Annotated[AsyncSession, Depends(get_session)]
SttTokenIssuerDep = Annotated[SttTokenIssuer, Depends(get_stt_token_issuer)]
