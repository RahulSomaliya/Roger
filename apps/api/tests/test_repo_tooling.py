"""The repo tooling other tasks build on: the root `Makefile` targets and the `.gitignore` rules.

`make --dry-run` prints commands without running them and `git check-ignore` reads only the
rules, so these tests need no database, no network and no build.
"""

import os
import shutil
import subprocess

import pytest

from roger_api.config import REPO_ROOT_ENV_FILE

REPO_ROOT = REPO_ROOT_ENV_FILE.parent

# `make check TEST_DB=x` hands its command-line variables to every child process through
# MAKEFLAGS, so a nested make would inherit TEST_DB (or ARGS) and the "no TEST_DB" case would
# pass a database anyway. The nested make starts from an environment without them.
_MAKE_STATE = {"MAKEFLAGS", "MFLAGS", "MAKELEVEL", "TEST_DB", "ARGS"}


def _tool(name: str) -> str:
    path = shutil.which(name)
    assert path is not None, f"{name} is not on PATH"
    return path


def make_dry_run(*args: str) -> str:
    """The commands `make <args>` would run from the repo root, printed and not run."""
    env = {key: value for key, value in os.environ.items() if key not in _MAKE_STATE}
    result = subprocess.run(  # noqa: S603 - fixed argv from this file, no shell.
        [_tool("make"), "--dry-run", "--no-print-directory", "-C", str(REPO_ROOT), *args],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


def git_ignores(path: str) -> bool:
    """Whether git's rules ignore `path` (from the repo root), even once the file is tracked."""
    result = subprocess.run(  # noqa: S603 - fixed argv from this file, no shell.
        [_tool("git"), "-C", str(REPO_ROOT), "check-ignore", "--quiet", "--no-index", path],
        capture_output=True,
        text=True,
        check=False,
    )
    # 0: ignored, 1: not ignored, anything else: git failed.
    assert result.returncode in (0, 1), result.stderr
    return result.returncode == 0


def test_test_db_points_the_api_tests_at_that_database() -> None:
    commands = make_dry_run("check", "TEST_DB=roger_test_tooling")

    pytest_lines = [line for line in commands.splitlines() if line.endswith("pytest")]
    assert len(pytest_lines) == 1, commands
    assert (
        "TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:5432/roger_test_tooling"
        in pytest_lines[0]
    )


def test_without_test_db_the_api_tests_keep_the_configured_database() -> None:
    """No TEST_DB: TEST_DATABASE_URL still comes from the environment or the repo-root `.env`."""
    assert "TEST_DATABASE_URL" not in make_dry_run("check")


@pytest.mark.parametrize(
    ("make_args", "expected_command"),
    [
        (["bench", "ARGS=run --parallel 3"], "pnpm --filter @roger/desktop bench run --parallel 3"),
        (["stt-canary"], "pnpm --filter @roger/desktop bench canary"),
        (["e2e-desktop"], "pnpm --filter @roger/desktop test:e2e"),
        (
            ["eval-notes", "ARGS=--reasoning on"],
            "python -m roger_api.evals.notes_eval run --reasoning on",
        ),
        (["eval-notes-fixes"], "python -m roger_api.evals.notes_eval fixes"),
        (["native"], "bash apps/desktop/scripts/build-native.sh"),
        (["test-native-route"], "apps/desktop/native/bin/roger-audio selftest --route-switch"),
    ],
)
def test_tool_targets_delegate_with_their_args(make_args: list[str], expected_command: str) -> None:
    assert expected_command in make_dry_run(*make_args)


def test_the_route_test_builds_the_helper_first() -> None:
    """The opt-in route test never runs a stale helper binary."""
    commands = make_dry_run("test-native-route").splitlines()

    build = commands.index("bash apps/desktop/scripts/build-native.sh")
    route = commands.index("apps/desktop/native/bin/roger-audio selftest --route-switch")
    assert build < route


@pytest.mark.parametrize(
    ("path", "ignored"),
    [
        # Notes-eval cases exported from real calls are client conversations, and their reports
        # quote them. Neither may ever be committed. The synthetic case is.
        ("apps/api/evals/notes/cases/local/client-call.json", True),
        ("apps/api/evals/notes/reports/2026-10-06/report.md", True),
        ("apps/api/evals/notes/cases/synthetic_standup.json", False),
        # The backup fixture is a real SQLite file. The root `*.sqlite` rule would drop it from a
        # `git add` of its folder without a word; only `test/fixtures` is let through.
        ("apps/desktop/test/fixtures/backup/roger.sqlite", False),
        ("apps/desktop/test/fixtures/backup/roger.sqlite-wal", True),
        ("apps/desktop/src/main/store/roger.sqlite", True),
        ("roger.sqlite", True),
        # Build output: the Swift helper binary and the benchmark CLI bundle.
        ("apps/desktop/native/bin/roger-audio", True),
        ("apps/desktop/native/roger-audio/main.swift", False),
        ("apps/desktop/bench/dist/cli.js", True),
        ("apps/desktop/bench/cli.ts", False),
    ],
)
def test_gitignore_rules(path: str, ignored: bool) -> None:
    assert git_ignores(path) is ignored
