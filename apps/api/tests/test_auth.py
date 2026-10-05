import httpx
import pytest

from roger_api.auth import verify_bearer
from tests.helpers import TEST_TOKEN, assert_error

BAD_AUTHORIZATION = [
    pytest.param(None, id="missing"),
    pytest.param("Bearer wrong-token-0123456789", id="wrong-token"),
    pytest.param(f"Basic {TEST_TOKEN}", id="wrong-scheme"),
    pytest.param("Bearer ", id="empty-token"),
    pytest.param(TEST_TOKEN, id="no-scheme"),
]

PROTECTED = [
    pytest.param("GET", "/v1/meetings", id="list-meetings"),
    pytest.param("POST", "/v1/meetings", id="create-meeting"),
    pytest.param("POST", "/v1/stt/token", id="stt-token"),
    pytest.param("POST", "/mcp", id="mcp-post"),
    pytest.param("GET", "/mcp", id="mcp-get"),
]


@pytest.mark.parametrize("authorization", BAD_AUTHORIZATION)
@pytest.mark.parametrize(("method", "path"), PROTECTED)
async def test_protected_routes_reject_bad_tokens(
    anonymous_client: httpx.AsyncClient, method: str, path: str, authorization: str | None
) -> None:
    headers = {} if authorization is None else {"Authorization": authorization}

    response = await anonymous_client.request(method, path, headers=headers, json={})

    assert_error(response, 401, "unauthorized")
    assert response.headers["WWW-Authenticate"] == "Bearer"


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
