import re
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.routing import iter_route_contexts

from roger_api.auth import verify_bearer
from tests.helpers import TEST_TOKEN, assert_error

BAD_AUTHORIZATION = [
    pytest.param(None, id="missing"),
    pytest.param("Bearer wrong-token-0123456789", id="wrong-token"),
    pytest.param(f"Basic {TEST_TOKEN}", id="wrong-scheme"),
    pytest.param("Bearer ", id="empty-token"),
    pytest.param(TEST_TOKEN, id="no-scheme"),
]

# Reachable without a token on purpose. Every other route must answer 401 without one, so a new
# route that forgets the auth dependency fails `test_every_other_route_rejects_bad_tokens`.
PUBLIC_PATHS = {"/health", "/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}

# /mcp is a plain Route around an ASGI app, so it lists no methods: it answers any of them.
ANY_METHOD = {"GET", "POST", "DELETE"}


def protected_routes(app: FastAPI) -> list[tuple[str, str]]:
    """(method, path template) for every route outside PUBLIC_PATHS, included routers expanded."""
    found: list[tuple[str, str]] = []
    for route in iter_route_contexts(app.routes):
        assert route.path, f"route without a path: {route.original_route!r}"
        if route.path in PUBLIC_PATHS:
            continue
        methods = (route.methods or ANY_METHOD) - {"HEAD"}  # HEAD is GET without a body.
        found += [(method, route.path) for method in sorted(methods)]
    return found


def test_the_route_walk_finds_every_kind_of_route(app: FastAPI) -> None:
    # Guards the walk itself: if it stopped expanding routers, the test below would pass vacuously.
    routes = protected_routes(app)

    assert ("GET", "/v1/meetings/{meeting_id}/transcript") in routes
    assert ("POST", "/v1/stt/token") in routes
    assert {("GET", "/mcp"), ("POST", "/mcp"), ("DELETE", "/mcp")} <= set(routes)


@pytest.mark.parametrize("authorization", BAD_AUTHORIZATION)
async def test_every_other_route_rejects_bad_tokens(
    app: FastAPI, anonymous_client: httpx.AsyncClient, authorization: str | None
) -> None:
    headers = {} if authorization is None else {"Authorization": authorization}
    responses: dict[str, httpx.Response] = {}

    for method, template in protected_routes(app):
        path = re.sub(r"\{[^}]+\}", str(uuid4()), template)
        responses[f"{method} {template}"] = await anonymous_client.request(
            method, path, headers=headers, json={}
        )

    answers = {
        name: (response.status_code, response.headers.get("WWW-Authenticate"))
        for name, response in responses.items()
    }
    assert answers == dict.fromkeys(responses, (401, "Bearer"))
    for response in responses.values():
        assert_error(response, 401, "unauthorized")


async def test_valid_token_is_accepted(anonymous_client: httpx.AsyncClient) -> None:
    response = await anonymous_client.get(
        "/v1/meetings", headers={"Authorization": f"Bearer {TEST_TOKEN}"}
    )

    assert response.status_code == 200


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        (f"Bearer {TEST_TOKEN}", True),
        (f"bearer {TEST_TOKEN}", True),
        (f"Bearer  {TEST_TOKEN} ", True),
        (f"Bearer {TEST_TOKEN}x", False),
        (f"Bearer {TEST_TOKEN[:-1]}", False),
        (f"Token {TEST_TOKEN}", False),
        ("Bearer", False),
        ("", False),
        (None, False),
    ],
)
def test_verify_bearer(header: str | None, expected: bool) -> None:
    assert verify_bearer(header, TEST_TOKEN) is expected
