"""Bearer-token auth for M1: one shared secret that resolves to the default workspace."""

import hmac
from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Request

from roger_api.config import Settings
from roger_api.dependencies import get_app_settings
from roger_api.errors import UnauthorizedError

UNAUTHORIZED_MESSAGE = "Missing or invalid bearer token"


@dataclass(frozen=True, slots=True)
class Principal:
    """Who is calling. Every query is scoped by `workspace_id`."""

    workspace_id: UUID
    user_id: UUID | None


def verify_bearer(header_value: str | None, expected: str) -> bool:
    """True when `header_value` is `Bearer <expected>`. Compares in constant time."""
    if not header_value:
        return False
    scheme, _, token = header_value.partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        return False
    return hmac.compare_digest(token.encode(), expected.encode())


def default_principal(settings: Settings) -> Principal:
    # M1 has one shared token and no users; M6 resolves a real user from Google sign-in.
    return Principal(workspace_id=settings.default_workspace_id, user_id=None)


def get_principal(
    request: Request, settings: Annotated[Settings, Depends(get_app_settings)]
) -> Principal:
    # REST only. MCP never calls this: `BearerAuthMiddleware` (mcp_server.py) checks the same
    # token and the tool uses a principal fixed at startup in `create_app` (app.py). When M6
    # makes this resolve per-user tokens, change those two as well, or every MCP caller keeps
    # reading the default workspace.
    expected = settings.roger_api_token.get_secret_value()
    if not verify_bearer(request.headers.get("Authorization"), expected):
        raise UnauthorizedError(UNAUTHORIZED_MESSAGE)
    return default_principal(settings)


PrincipalDep = Annotated[Principal, Depends(get_principal)]
