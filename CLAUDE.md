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
   and `NotesModel` (API). Swapping a vendor is a config change plus one new adapter, never a
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
9. **Every vendor connection goes through the shared STT core and the open budget.**
   Vendors bill every second a session is open, silent or not. An adapter only describes its
   protocol (`SttProtocol`); it never opens, times or closes a socket itself (`SttConnection` does,
   and the conformance suite fails on a leaked socket). Every vendor session open acquires from
   `SttOpenBudget` first, right before `openStream`: `CaptureSession`'s (Start's two and every
   stall or failure reopen on the meeting's allowance, the silence gate's reopens in the per-minute
   window only), the gap re-run's (the per-minute window only, through the one budget
   `createCaptureRuntime.ts` shares with `CaptureService`) and the bench's (its own budget). The
   budget's doc comment lists these callers; a new caller is added there and here in one change.
   A source with no audio never holds an open vendor session: a failed or ended source closes its
   session at once, a silent one after the stall window, and it reopens only with audio. The
   numbers live in `apps/desktop/src/main/costGuards.ts`.

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
- To tell a lost privacy grant from a code bug, read the `tccd` log:
  `/usr/bin/log show --last 1d --predicate 'subsystem == "com.apple.TCC" AND eventMessage CONTAINS[c] "roger"' | grep 'Failed to match existing code requirement'`.
  A hit names the service (`kTCCServiceMicrophone`, `ScreenCapture`, `AudioCapture`): the grant is
  pinned to another designated requirement than `codesign -d -r- /Applications/Roger.app` prints.
  Type `/usr/bin/log`; plain `log` is a zsh builtin. The Error-level `kTCCServiceAccessibility`
  line at launch comes from Electron and is not a grant problem (2026-10-06).
- A packaged app logs to stderr only. Launch it with
  `open --stderr <file> --stdout <file> /Applications/Roger.app` to read its log.
- Ruff `RUF001` rejects lookalike Unicode (en dash, curly quotes, `‹`) in Python string literals:
  write `\u2013`, `\u2019`, `\u2039`. An agent's Write and Edit tools both turn the escapes back
  into literal characters, in tests too (M4-T5, M3-T2, M5-T2), and in TypeScript strings and regexes
  (a BOM in a regex failed `no-irregular-whitespace`; curly quotes passed silently, M3-T10): grep
  `[^\x00-\x7F]` after every write or edit, and fix a hit with a script that emits the escape.
- `eslint-plugin-react-hooks` v7 (`react-hooks/refs`) rejects a ref read inside a closure built in a
  `useState` initializer. Keep the latest callback in a plain variable on the once-made object and
  update it from a layout effect. `renderToString` runs no effects: test effect-based registration
  through the registry, not through server rendering (M4-T21a).
- A vitest test can switch time zones with `process.env.TZ`, but assert
  `new Date(...).getTimezoneOffset()` inside the switch, or a TZ test passes when the switch did
  nothing (M5-T8).
- `vi.setSystemTime(later)` moves `Date.now` and shifts every fake timer with it: each keeps its
  remaining wait and none fires, as Node timers behave over a Mac sleep (their clock stops; libuv
  source, not yet seen on a sleeping Mac). Recheck a deadline that must hold across sleep from the
  wall clock on wake, and test it as `setSystemTime` plus the wake call (M5-T7).
- pnpm 10.28 here does NOT enforce the global `minimum-release-age=10080`: `@tiptap/core@^3.31.0`
  resolved to a 6-day-old 3.31.4 (P2-F3, 2026-10-06). After any `pnpm add`, check each new
  lockfile version's publish date (`npm view <pkg> time`). `@tiptap/react` pulls its bubble and
  floating menus with `^` while they need the exact same `@tiptap/core`: the overrides in
  `pnpm-workspace.yaml` pin them, so bump them together with the five TipTap packages.
- AssemblyAI's session cap, `max_session_duration_seconds`, is a parameter of the temporary-token
  request (the API sets it), not of the websocket URL; `inactivity_timeout` is the other way round
  (the desktop sets it). Its streaming page lists only the second (2026-10-06).
- Alembic revisions 0002-0005 began as empty stubs (P2-F2). A stub filled in place is invisible to a
  database migrated while it was empty: `upgrade head` is a no-op and `downgrade` raises
  `UndefinedTable`. Tests drop and rebuild their database every run, so they never show it. Never
  `make migrate` the dev database from a Phase 2 branch before its stubs are filled; to repair one,
  `uv run --frozen alembic stamp 0001 && uv run --frozen alembic upgrade head` (2026-10-06).
- A NOT NULL column added to a table that holds rows needs a server default in the migration. The
  suite migrates an empty database, so only a test that upgrades a scratch database with rows shows
  a missing one (`test_calendar_schema.py::test_existing_meetings_read_manual_after_the_upgrade`,
  M5-T1).
- IPC stub APIs are `object`. typescript-eslint refuses `{}`, empty interfaces and `object & object`:
  give a stub its first member as an interface, and never rewrite `RogerApi` as `A & B & ...` while
  stubs remain. Two features sharing a member name is no type error (the preload spreads silently
  overwrite); `shared/ipc.test.ts` and `preview/fakeRoger.test.ts` guard it (P2-F1).
- Adding a member to `shared/ipc/<feature>.ts`, or making a shared field required, breaks every test
  double typed as that whole type, in files the task does not own (`AudioCaptureController.test.ts`
  types its double as `CaptureApi`, TS2739; `stream.keyterms` in `SttTokenResponse`). Stub it in
  those doubles in the same commit and name the files in the hand-off (M2-T2, M3-T4a).
- A pydantic-settings mixin with its own `model_config` changes how every setting is read (feature
  config modules are plain `BaseModel`). Pydantic keeps one validator per name across the class
  tree: a mixin validator named like one in `Settings` (`_blank_is_unset`) is silently replaced by
  it and the mixin's fields go unchecked, so name each uniquely (P2-F2, M5-T1).
- To retire a setting, keep it typed `None` with a before-validator that refuses a value. Deleting
  it lets `extra="ignore"` drop a leftover `.env` line in silence, and the API runs something other
  than what `.env` says (`STT_MODEL`, M3-T1).
- Never name a conftest helper `test_*`: imported into a test module, pytest collects it (P2-F2).
- `structlog.testing.capture_logs()` misses a module logger first used under an earlier
  `create_app()`: each `configure_logging` call installs a new processor list, a cached logger
  keeps the one it first saw, and `capture_logs` edits only the current one. In a suite that builds
  an app per test, a "never logged" assertion then passes on nothing. Attach a root
  `logging.Handler` after `create_app()` (`recorded_events()` in `test_stt_providers.py`) and assert
  the expected event arrived before asserting what did not (M3-T1; checked with structlog 26.1).
- STT pacing tests drive a manual clock with real timers: the pace timer only wakes the queue and the
  clock decides what may go. Move the clock, then `waitFor` the frames (M3-T18).
- A migration test that winds `roger.sqlite` back to schema N must also undo every later migration,
  or reopening re-runs them (`duplicate column name`); each new local migration adds its own
  wind-back helper (M2-T3).
- `swiftc` fails with "input file ... was modified during the build" if `native/roger-audio` changes
  while `make check` runs. `roger-audio selftest` must never create a real tap or open a device: that
  would raise a macOS privacy prompt for whatever ran `make` (M2-T7).
- A case-insensitive dedupe feeding a unique index on `lower(...)` takes its keys from Postgres:
  Python's `str.lower()` disagrees on a final capital sigma, U+0130 and, in a C-locale database, any
  non-ASCII letter, and one multi-row `ON CONFLICT DO UPDATE` then fails "cannot affect row a second
  time" (a 500). Postgres 16 has no `lc_ctype` to SHOW; read `pg_database.datctype` (M3-T2).
- A whole-list replace (delete what is missing, then upsert) in two concurrent transactions stores
  the union of both lists. Lock the owner row with `with_for_update(key_share=True)` (FOR NO KEY
  UPDATE), not FOR UPDATE, which blocks the FOR KEY SHARE every foreign-key insert takes (M3-T2).
- A test that streams JSON in byte pieces to cover multi-byte UTF-8 dumps with `ensure_ascii=False`,
  or it only ever sends ASCII. Inside `pytest.raises`, `seen += [e async for e in events]` records
  nothing (the comprehension raises before `+=` assigns): append in a helper (M4-T2).
- With `exactOptionalPropertyTypes`, `{ ...settings, keyterms }` with `keyterms` possibly undefined
  fails tsc (TS2379, TS2412): leave the key out, or type it `T | undefined`. `no-misused-spread`
  refuses `[...text]` on a string; count code points as Python's `len` does with
  `Array.from(text).length` (M3-T4a).
- `src/renderer` and `src/shared` are type-checked without Node types (`tsconfig.web.json`): a test
  there reads a JSON fixture with a JSON import (`shared/notes.test.ts`) and a CSS file through
  `renderer/src/theme/rendererSources.ts`, never `import.meta.glob(..., { query: '?raw' })`, which
  Vitest empties for CSS, so a colour scan through it passes on anything (M4-S2, M4-T13). `?raw`
  is fine for other files: `preview/index.test.ts` imports both `index.html` pages that way (M4-S3).
- A CSS scan with `/\{([^{}]*)\}/` reads only innermost blocks and skips every declaration of a rule
  that holds a nested rule; read declarations with `renderer/src/theme/cssDeclarations.ts` (M4-S2).
- In dark, one colour cannot be both a fill under white text and text on `--panel`; in light,
  danger cannot either (4.46:1 as text on `--bg`, 3.7:1 in the error box). `--accent` and
  `--danger` are fills under `--on-accent`; text in those hues uses `--accent-ink` and
  `--danger-ink`, and `tokens.test.ts` checks the fills, the inks on `--panel` and `--bg`, and
  error text on its `--danger-bg` tint (M4-S2).
- Main's errors reach the renderer as text ("Error invoking remote method '<channel>': ApiError:
  ..."), never as the class: renderer code never checks `instanceof ApiError`;
  `app/describeError.ts` strips the wrapper (M4-S3).
- Never write `location.hash`, `<a href="#/...">`, `history.pushState` or `history.replaceState`
  in the renderer while `lifecycle.ts` stops recording on `did-start-loading`: Chromium starts a
  load on a same-document navigation, a hash change or a `replaceState` (seen in Chrome; Electron
  not yet checked). The shell keeps its route in `sessionStorage` (`app/router.ts`). The
  controller drops this line once M2-T12 removes the stop (M4-S1).
- `tsconfig.e2e.json` compiles every `e2e/` QA script as ONE program: two scripts that each declare
  `Window.roger` with a different type pass alone in their worktrees and fail together after the
  merge (TS2687/TS2717). `window.roger` is typed once in `e2e/previewWindow.d.ts`; a script names
  its own page globals (`__m4t17`, `__abWatch`) and never redeclares `roger` (wave 2, 2026-10-07).
