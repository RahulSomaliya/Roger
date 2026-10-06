"""Request ids, access logging and the error envelope for errors outside any route."""

import re

import httpx
import pytest
from fastapi import FastAPI

from roger_api.config import REPO_ROOT_ENV_FILE
from tests.helpers import assert_error

UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}")

API_CONTRACT = REPO_ROOT_ENV_FILE.parent / "docs" / "api-contract.md"
# A route's heading in the contract: "### `GET /v1/meetings?limit=50...`", or "#### `PUT
# /v1/vocabulary`" under a feature's own heading. The query string is not part of the path.
CONTRACT_ROUTE_HEADING = re.compile(r"^#+ `(GET|POST|PUT|PATCH|DELETE) (/[^`?\s]*)", re.MULTILINE)


async def test_openapi_documents_the_contract_routes(anonymous_client: httpx.AsyncClient) -> None:
    # The expected routes come from the contract, never from a list here. Phase 2 has a dozen
    # route-adding tasks in parallel worktrees; a path literal in this file made every one of them
    # edit the same lines, so their branches conflicted on merge (M3-T2 review, 2026-10-06). A new
    # route needs only its heading in its own contract section (house rule 8), and a route or a
    # heading without the other fails here.
    response = await anonymous_client.get("/openapi.json")

    assert response.status_code == 200
    served = {
        (method.upper(), path)
        for path, operations in response.json()["paths"].items()
        for method in operations
    }
    documented = set(CONTRACT_ROUTE_HEADING.findall(API_CONTRACT.read_text()))
    undocumented = sorted(served - documented)
    unserved = sorted(documented - served)
    assert not undocumented, f"routes with no heading in docs/api-contract.md: {undocumented}"
    assert not unserved, f"docs/api-contract.md headings with no route: {unserved}"


async def test_request_id_is_echoed(client: httpx.AsyncClient) -> None:
    response = await client.get("/health", headers={"X-Request-ID": "desktop-42"})

    assert response.headers["X-Request-ID"] == "desktop-42"


@pytest.mark.parametrize("incoming", [None, "", "has spaces", "x" * 129])
async def test_request_id_is_generated_when_absent_or_unsafe(
    client: httpx.AsyncClient, incoming: str | None
) -> None:
    headers = {} if incoming is None else {"X-Request-ID": incoming}

    response = await client.get("/health", headers=headers)

    assert UUID_PATTERN.fullmatch(response.headers["X-Request-ID"])


async def test_unknown_path_is_a_404_envelope(client: httpx.AsyncClient) -> None:
    assert_error(await client.get("/v1/nope"), 404, "not_found")


async def test_wrong_method_uses_the_envelope(client: httpx.AsyncClient) -> None:
    assert_error(await client.delete("/health"), 405, "method_not_allowed")


async def test_unexpected_exception_is_a_500_envelope_with_request_id(
    app: FastAPI, client: httpx.AsyncClient
) -> None:
    async def explode() -> None:
        raise RuntimeError("secret internals")

    app.add_api_route("/explode", explode)

    response = await client.get("/explode", headers={"X-Request-ID": "trace-me"})

    message = assert_error(response, 500, "internal_error")
    assert "secret internals" not in message
    assert response.headers["X-Request-ID"] == "trace-me"
