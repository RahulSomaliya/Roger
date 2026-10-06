"""The Google Calendar provider (M5-T2), with Google mocked by `httpx.MockTransport`.

Never calls Google: every request goes to a handler in this file.
"""

import ast
import shutil
import subprocess
from pathlib import Path

import pytest

import roger_api

API_DIR = Path(__file__).resolve().parents[1]
BANNED_IMPORTS = ("jwt", "cryptography")


def _imported_modules(tree: ast.AST) -> list[str]:
    names: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None and node.level == 0:
            names.append(node.module)
    return names


def test_no_jwt_or_cryptography_import() -> None:
    # Both are installed only because `mcp` pulls in `pyjwt[crypto]`: importing either adds a
    # dependency uv.lock does not declare, which breaks the day `mcp` drops it.
    package = Path(roger_api.__file__).parent
    offenders = [
        f"{path.relative_to(package)}: {name}"
        for path in sorted(package.rglob("*.py"))
        for name in _imported_modules(ast.parse(path.read_text(encoding="utf-8")))
        if name.split(".")[0] in BANNED_IMPORTS
    ]
    assert offenders == []


@pytest.mark.parametrize(
    "source",
    [
        "import jwt\n",
        "from jwt import decode\n",
        "import cryptography\n",
        "import cryptography.fernet\n",
        "from cryptography.fernet import Fernet\n",
    ],
)
def test_ruff_refuses_jwt_and_cryptography(source: str) -> None:
    # The ast walk above checks today's code; this proves the ruff rule in pyproject.toml is live,
    # so `make check` refuses the import before it is ever committed.
    ruff = shutil.which("ruff")
    assert ruff is not None, "ruff is not on PATH"
    result = subprocess.run(  # noqa: S603 - fixed argv from this file, no shell.
        [ruff, "check", "--no-cache", "--select", "TID251", "--stdin-filename", "probe.py", "-"],
        cwd=API_DIR,
        input=source,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 1, result.stdout + result.stderr
    assert "TID251" in result.stdout
