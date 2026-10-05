# Roger monorepo. `make check` is the one command that lints, typechecks and tests both apps.
SHELL := /bin/bash
.DEFAULT_GOAL := help

API_DIR     := apps/api
DESKTOP_PKG := @roger/desktop

.PHONY: help setup setup-api setup-desktop check lint lint-api lint-desktop typecheck typecheck-api \
        typecheck-desktop test test-api test-desktop format dev-db migrate dev-api dev-desktop clean

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
	cd $(API_DIR) && uv run ruff check . && uv run ruff format --check .

lint-desktop:
	pnpm --filter $(DESKTOP_PKG) lint
	pnpm --filter $(DESKTOP_PKG) format:check

typecheck: typecheck-api typecheck-desktop ## Typecheck both apps

typecheck-api:
	cd $(API_DIR) && uv run mypy

typecheck-desktop:
	pnpm --filter $(DESKTOP_PKG) typecheck

test: test-api test-desktop ## Test both apps (API tests need Postgres, see TEST_DATABASE_URL)

test-api:
	cd $(API_DIR) && uv run pytest

test-desktop:
	pnpm --filter $(DESKTOP_PKG) test

format: ## Auto-format both apps
	cd $(API_DIR) && uv run ruff check --fix . && uv run ruff format .
	pnpm --filter $(DESKTOP_PKG) format

# ---------------------------------------------------------------------------
# Local development
# ---------------------------------------------------------------------------
dev-db: ## Start local Postgres in Docker (creates roger and roger_test databases)
	docker compose up -d db

migrate: ## Apply database migrations to DATABASE_URL
	cd $(API_DIR) && uv run alembic upgrade head

dev-api: ## Run the API with auto-reload on :8000
	cd $(API_DIR) && uv run uvicorn roger_api.main:app --reload --port 8000

dev-desktop: ## Run the desktop app in dev mode
	pnpm --filter $(DESKTOP_PKG) dev

clean: ## Remove build output and caches
	rm -rf apps/desktop/out apps/desktop/dist $(API_DIR)/.mypy_cache $(API_DIR)/.ruff_cache $(API_DIR)/.pytest_cache
