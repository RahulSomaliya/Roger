import subprocess
import sys
from typing import Any
from uuid import uuid4

import httpx

TEST_TOKEN = "test-token-0123456789"
AUTH_HEADERS = {"Authorization": f"Bearer {TEST_TOKEN}"}
# The MCP transport only accepts localhost Host headers by default, port included.
BASE_URL = "http://localhost:8000"

type Json = dict[str, Any]


def segment_payload(**overrides: object) -> Json:
    return {
        "id": str(uuid4()),
        "source": "mic",
        "speaker": "me",
        "start_ms": 1200,
        "end_ms": 2950,
        "text": "Hello everyone.",
        "confidence": 0.98,
        "words": [{"text": "Hello", "start_ms": 1200, "end_ms": 1600, "confidence": 0.99}],
        **overrides,
    }


async def create_meeting(client: httpx.AsyncClient, **body: object) -> Json:
    response = await client.post("/v1/meetings", json=body)
    assert response.status_code == 201, response.text
    meeting: Json = response.json()
    return meeting


async def append_segments(client: httpx.AsyncClient, meeting_id: str, *segments: Json) -> Json:
    response = await client.post(
        f"/v1/meetings/{meeting_id}/segments", json={"segments": list(segments)}
    )
    assert response.status_code == 200, response.text
    result: Json = response.json()
    return result


def assert_error(response: httpx.Response, status_code: int, code: str) -> str:
    """Asserts the contract's error envelope and returns its message."""
    assert response.status_code == status_code, response.text
    body = response.json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message"}
    assert body["error"]["code"] == code
    message: str = body["error"]["message"]
    return message


_LOADED_MODULES_SCRIPT = """
import importlib, sys
for name in sys.argv[1:]:
    importlib.import_module(name)
print("\\n".join(m for m in sys.modules if m == "roger_api" or m.startswith("roger_api.")))
"""


def modules_loaded_by(*modules: str) -> set[str]:
    """Every `roger_api` module a fresh interpreter holds after importing `modules`.

    A fresh process, because this test session has long since imported every module.
    """
    result = subprocess.run(  # noqa: S603 - fixed argv: this interpreter and module names.
        [sys.executable, "-c", _LOADED_MODULES_SCRIPT, *modules],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return set(result.stdout.split())
