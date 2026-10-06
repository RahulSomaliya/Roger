# Roger: house rules

Roger is a Mac meeting-notes app for the Linkt team (a Granola replacement). It records calls
without a bot, transcribes them live, turns rough notes into clean notes, and lets Claude or any
AI tool pull the full transcript of any team call through MCP. The roadmap lives in
`docs/roadmap.md`; the one-page spec in `docs/spec.md`; every milestone has a plan in `docs/plans/`.

This file applies to every person and every coding agent working in this repo. `AGENTS.md` points here.

## Repo map

| Path | What it is |
| --- | --- |
| `apps/desktop` | Electron + React + TypeScript Mac app. Captures audio, streams it to speech-to-text, shows the live transcript. |
| `apps/api` | FastAPI + Postgres. Source of truth for meetings and transcripts. Hosts the MCP server at `/mcp`. |
| `docs/` | Spec, roadmap, milestone plans (`docs/plans/`), research notes (`docs/research/`), the API contract (`docs/api-contract.md`). |
| `scripts/` | Small helper scripts. Anything longer than a screen belongs in an app. |

## Commands

```bash
make setup      # install both apps (uv + pnpm)
make check      # lint + typecheck + test for both apps. Run this before you say you are done.
make format     # auto-format both apps
make dev-db     # Postgres in Docker
make migrate    # alembic upgrade head
make dev-api    # API on http://127.0.0.1:8000 (docs at /docs, MCP at /mcp)
make dev-desktop
make install-desktop  # build Roger.app for this Mac's CPU, sign with a local identity, install it
```

`make help` lists everything. Per-app commands live in `apps/api/pyproject.toml` and
`apps/desktop/package.json`; the Makefile only delegates.

## Architecture rules

These are the rules that are expensive to retrofit. Do not bend them without a note in the
milestone plan.

1. **Postgres is the source of truth. The Mac holds a safety copy.** The desktop app writes every
   transcript line to its local SQLite file the moment it arrives, then uploads in batches. A crash,
   a closed laptop or bad wifi must never lose a call.
2. **Every table row carries `workspace_id`.** Every query filters by it. Every API handler and MCP
   tool resolves a `Principal` (workspace, user) first and never reads across workspaces.
3. **Vendor keys never ship in the app.** The API holds speech-to-text and LLM keys and hands the
   desktop app short-lived tokens. The desktop app only ever holds the Roger API token.
4. **Vendors sit behind our own small interfaces.** `SpeechToText` (desktop), `SttTokenIssuer`
   (API), later `NotesModel`. Swapping a vendor is a config change plus one new adapter, never a
   change to callers.
5. **In Electron, the main process owns secrets, network and persistence.** The renderer captures
   audio and renders UI. It talks to main only through the typed IPC contract in
   `apps/desktop/src/shared/ipc.ts`. `contextIsolation` on, `sandbox` on, `nodeIntegration` off.
6. **Two audio streams, kept separate.** The mic stream is "me", the system audio stream is "them".
   They are never mixed before transcription.
7. **Idempotent writes.** The desktop generates segment and meeting ids. Re-sending a batch is
   always safe. Any retry logic relies on this.
8. **The API contract is a document first.** `docs/api-contract.md` is updated in the same change
   as the code on both sides.

## Code rules

- **TypeScript:** `strict` on, no `any`, no non-null assertions without a comment saying why.
  Prefer small pure modules with unit tests next to them (`foo.ts`, `foo.test.ts`). ESLint and
  Prettier are the law; do not fight them with disables.
- **Python:** 3.12 features are fine, full type hints, `ruff` for lint and format, `mypy` strict.
  Async all the way down in request paths. Pydantic models at the edges, SQLAlchemy models inside.
- **Names say what things are.** `TranscriptUploader`, not `Manager`. `start_ms`, not `start`.
  Milliseconds for durations, UTC ISO 8601 for instants, UUIDv4 for ids.
- **Errors are typed and surfaced.** No swallowed exceptions. The API returns the error envelope in
  `docs/api-contract.md`. The desktop shows a visible error state; a silent failure is the bug this
  product exists to avoid.
- **Logs are structured.** Use the app logger, never `print` or `console.log` in app code.
- **Dependencies are deliberate.** Add one only when it saves real code, pin it in the lockfile and
  say why in the commit message.
- **Tests are the exit check.** Every milestone plan names its tests. Permission tests are never
  skipped or marked flaky. A failing test is fixed or the change is reverted.

## Working process

1. Every milestone starts from `docs/plans/TEMPLATE.md`. Fill it in before writing code.
   Small plans beat big ones; split a milestone rather than write a long plan.
2. Build in small commits with messages in the imperative ("Add transcript uploader"), scoped by
   app (`api:`, `desktop:`, `docs:`, `repo:`).
3. Run `make check` before claiming done. Paste real output when reporting results; never report a
   test as passing that you did not run.
4. An engineer reviews every change. Agents never merge.
5. The milestone closes with its exit check on a real call, written into the plan's log.

## Things agents must not do

- Do not commit secrets, `.env` files or vendor keys. `.env.example` documents every variable.
- Do not add a third app, a shared package or a new service without a plan that says why.
- Do not change the API contract on one side only.
- Do not skip, disable or quarantine a test to get green.
- Do not put a model name or agent name in code, commits or docs.

## Failure log

Each line is a trap someone already hit. Add one when you hit a new one.

- `uv run` without `--frozen` re-resolves `uv.lock` when the machine has a global `exclude-newer`
  in `~/.config/uv/uv.toml`, and fails on deps newer than the cutoff (`mcp>=2.3`, first Mac run,
  2026-10-05). The Makefile now runs every uv command with `--frozen`; outside make, type
  `uv run --frozen` or export `UV_FROZEN=1`.
- `pnpm install --frozen-lockfile` failed with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` under a global
  `auto-install-peers=false`; `pnpm-workspace.yaml` now pins `autoInstallPeers: true` to match the
  lockfile. Still machine-specific: with a global `ignore-scripts=true` the Electron binary is
  never downloaded. Fetch it once with `node node_modules/electron/install.js` inside
  `apps/desktop`; do not change the global config.
- In `make dev-desktop` the terminal is the app macOS asks for capture permission. cmux, iTerm2 and
  Terminal.app have no `NSAudioCaptureUsageDescription`, so the system audio ("Them") stream is
  dead with no error. Test call audio from the installed `Roger.app`: `make install-desktop`.
- An unsigned `electron-builder --mac` build re-signed with `--options runtime` but no Apple team
  id dies at launch (`Electron Framework ... not valid for use in process`). Never sign a local
  build ad hoc either: macOS pins privacy grants to the code hash, so each rebuild silently loses
  call audio while System Settings still shows Roger on (2026-10-06). `make install-desktop` signs
  with a stable per-Mac identity, without hardened runtime; see `apps/desktop/scripts/install-mac.sh`.
- A packaged app logs to stderr only. Launch it with
  `open --stderr <file> --stdout <file> /Applications/Roger.app` to read its log.
