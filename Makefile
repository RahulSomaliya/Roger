# Roger monorepo. `make check` is the one command that lints, typechecks and tests both apps.
SHELL := /bin/bash
.DEFAULT_GOAL := help

API_DIR     := apps/api
DESKTOP_PKG := @roger/desktop

# Every uv command runs against apps/api/uv.lock exactly as committed. Plain `uv run` re-resolves
# the lock first, and on a machine with a global `exclude-newer` in ~/.config/uv/uv.toml that
# re-resolve fails on anything published after the cutoff (`mcp>=2.3`, first Mac run 2026-10-05)
# or silently downgrades. Never drop `--frozen` here; change dependencies with `uv lock` on purpose.
UV_RUN := uv run --frozen

# `make check TEST_DB=roger_test_<task>` points the API tests at that database on the `make dev-db`
# Postgres, so parallel worktrees never truncate each other's tables. Left empty, TEST_DATABASE_URL
# comes from the environment or the repo-root `.env` as before. Make does not check the name. The
# test session migrates that database down to base and truncates it, so the one guard belongs next
# to the TRUNCATE: apps/api/tests/conftest.py refuses any name not starting with roger_test (added
# by P2-F2, not by this file). Without that check, TEST_DB=roger wipes the dev database.
TEST_DB ?=
TEST_DB_SERVER := postgresql+asyncpg://postgres:postgres@localhost:5432
TEST_DB_ENV := $(if $(TEST_DB),TEST_DATABASE_URL=$(TEST_DB_SERVER)/$(TEST_DB))

# Extra arguments for the tool targets: make bench ARGS="run --parallel 3".
ARGS ?=

.PHONY: help setup setup-api setup-desktop check lint lint-api lint-desktop typecheck typecheck-api \
        typecheck-desktop test test-api test-desktop format dev-db migrate dev-api dev-desktop \
        install-desktop native test-native-route e2e-desktop bench stt-canary eval-notes \
        eval-notes-fixes clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
setup: setup-api setup-desktop ## Install dependencies for both apps

setup-api: ## Install API dependencies (uv)
	cd $(API_DIR) && uv sync --frozen

setup-desktop: ## Install desktop dependencies (pnpm)
	pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Quality gate (M0 exit check: one command runs tests and lint for both apps)
# ---------------------------------------------------------------------------
check: lint typecheck test ## Lint, typecheck and test both apps

lint: lint-api lint-desktop ## Lint both apps

lint-api:
	cd $(API_DIR) && $(UV_RUN) ruff check . && $(UV_RUN) ruff format --check .

lint-desktop:
	pnpm --filter $(DESKTOP_PKG) lint
	pnpm --filter $(DESKTOP_PKG) format:check

typecheck: typecheck-api typecheck-desktop ## Typecheck both apps

typecheck-api:
	cd $(API_DIR) && $(UV_RUN) mypy

typecheck-desktop:
	pnpm --filter $(DESKTOP_PKG) typecheck

test: test-api test-desktop ## Test both apps (API tests need Postgres, see TEST_DATABASE_URL)

test-api:
	cd $(API_DIR) && $(TEST_DB_ENV) $(UV_RUN) pytest

test-desktop:
	pnpm --filter $(DESKTOP_PKG) test

format: ## Auto-format both apps
	cd $(API_DIR) && $(UV_RUN) ruff check --fix . && $(UV_RUN) ruff format .
	pnpm --filter $(DESKTOP_PKG) format

# ---------------------------------------------------------------------------
# Local development
# ---------------------------------------------------------------------------
dev-db: ## Start local Postgres in Docker (creates roger and roger_test databases)
	docker compose up -d db

migrate: ## Apply database migrations to DATABASE_URL
	cd $(API_DIR) && $(UV_RUN) alembic upgrade head

dev-api: ## Run the API with auto-reload on :8000
	cd $(API_DIR) && $(UV_RUN) uvicorn roger_api.main:app --reload --port 8000

dev-desktop: ## Run the desktop app in dev mode
	pnpm --filter $(DESKTOP_PKG) dev

# Test real call audio from the installed app, not from dev mode: in dev mode macOS asks the
# terminal for capture permission and the system ("Them") stream is silently dead.
install-desktop: ## Build Roger.app for this Mac's CPU, sign it with a local identity, install to /Applications
	pnpm --filter $(DESKTOP_PKG) install:mac

# ---------------------------------------------------------------------------
# Tools: the Swift audio helper, the Electron smoke test, the STT benchmark and the notes eval
# ---------------------------------------------------------------------------
native: ## Build the Swift audio helper into apps/desktop/native/bin (macOS)
	bash apps/desktop/scripts/build-native.sh

# Not part of `make check`: it plays a tone and switches this Mac's default output device.
test-native-route: native ## Opt-in, audible: the helper's tap follows an output switch (macOS)
	apps/desktop/native/bin/roger-audio selftest --route-switch

e2e-desktop: ## Electron smoke test: build, then run with fake audio, helper and STT
	pnpm --filter $(DESKTOP_PKG) test:e2e

bench: ## STT benchmark CLI: make bench ARGS="run" (data in ROGER_BENCH_DIR)
	pnpm --filter $(DESKTOP_PKG) bench $(ARGS)

stt-canary: ## Synthetic jargon clip through the vendor the local API serves
	pnpm --filter $(DESKTOP_PKG) bench canary $(ARGS)

eval-notes: ## Notes eval over apps/api/evals/notes/cases (ARGS="--judge-model ...")
	cd $(API_DIR) && $(UV_RUN) python -m roger_api.evals.notes_eval run $(ARGS)

eval-notes-fixes: ## Edit size between each meeting's generated notes and the current ones
	cd $(API_DIR) && $(UV_RUN) python -m roger_api.evals.notes_eval fixes $(ARGS)

clean: ## Remove build output and caches
	rm -rf apps/desktop/out apps/desktop/dist apps/desktop/native/bin apps/desktop/bench/dist
	rm -rf $(API_DIR)/.mypy_cache $(API_DIR)/.ruff_cache $(API_DIR)/.pytest_cache
