# M0. Setup

**Phase:** 1 · **Status:** done · **Owner:** Rahul · **Plan written:** 2026-10-05 · **Closed:** 2026-10-05

## Goal

One repo, two apps, one command that proves both are healthy. The house rules, the plan template
and the one-page spec exist so every later milestone starts from the same place.

## Done when

- [x] One command runs tests and lint for both apps: `make check`.

## In scope

- Monorepo layout: `apps/desktop` (Electron, React, TypeScript), `apps/api` (FastAPI, Postgres).
- `CLAUDE.md` house rules, `AGENTS.md` pointer, `docs/plans/TEMPLATE.md`, `docs/spec.md`.
- Root `Makefile`, `docker-compose.yml` for Postgres, `.env.example`, GitHub Actions CI.
- Research notes on the four reference repos (`docs/research/reference-repos.md`).

## Out of scope

- Any product behaviour (M1).
- Signed builds, auto-update (M11).

## Design

| Decision         | Choice                                                                                      | Alternative                                                          | Why                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo tooling | pnpm workspace for TypeScript, uv for Python, a root Makefile that delegates                | Nx or Turborepo                                                      | Two apps in two languages need a neutral entry point, not a JS task runner.                                                                  |
| Desktop build    | electron-vite 5 (Vite 7) with strict TypeScript in main, preload and renderer               | Plain Vite for the renderer and untyped JavaScript main (openwhispr) | One typed build for all three processes; the IPC contract is a shared module, not a hand-kept declaration.                                   |
| Local SQLite     | Node's built-in `node:sqlite`                                                               | `better-sqlite3`                                                     | No native module to rebuild per Electron ABI, nothing to notarize, tests run under plain Node. Verified against Electron 44 before choosing. |
| API stack        | FastAPI, SQLAlchemy 2 async, Alembic, pydantic-settings, uv                                 | Django, raw asyncpg                                                  | Matches team Python skills; migrations from day one.                                                                                         |
| Quality gate     | `ruff`, `mypy --strict`, `pytest` on a real Postgres; `eslint`, `prettier`, `tsc`, `vitest` | SQLite-in-tests for the API                                          | Tests against the real database catch the bugs that matter (constraints, JSONB, ordering).                                                   |
| CI               | Two parallel GitHub Actions jobs (api, desktop) with a Postgres service                     | One job running `make check`                                         | Faster feedback, same commands as local.                                                                                                     |

## Work items

- [x] Root files: `.gitignore`, `.editorconfig`, `.nvmrc`, `pnpm-workspace.yaml`, `package.json`, `Makefile`, `docker-compose.yml`, `.env.example`.
- [x] `CLAUDE.md`, `AGENTS.md`, `README.md`.
- [x] `docs/spec.md`, `docs/roadmap.md`, `docs/plans/TEMPLATE.md`, `docs/api-contract.md`.
- [x] `.github/workflows/ci.yml`.
- [x] `docs/research/reference-repos.md`.

## Tests

| What                                                | Test                                             |
| --------------------------------------------------- | ------------------------------------------------ |
| Both apps lint, typecheck and test from one command | `make check` (see M1 for the test files it runs) |

## Risks

| Risk                                                   | Signal                              | Response                                                                            |
| ------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------- |
| Tool versions move fast (Vite 8, TypeScript 7 are out) | Peer dependency warnings on install | Pin to the versions electron-vite and typescript-eslint support; revisit at Gate 1. |

## Exit check log

2026-10-05: `make check` green locally on Linux with Postgres 16 (output in the M1 plan).

## Review

Engineer: pending.
