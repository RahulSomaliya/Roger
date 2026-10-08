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
| `apps/desktop/native` | `roger-audio`, the Swift audio helper: call audio through a Core Audio tap, the mic and call-app monitor, the permission probe. `make native` builds it (macOS). |
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
make bench ARGS="run" # STT benchmark: clip, run, draft, check, score, report, forget, canary
make stt-canary       # synthetic jargon clip through the vendor the local API serves (make dev-api)
make native           # build the Swift audio helper into apps/desktop/native/bin (macOS; make check does it on a Mac)
make test-native-route  # opt-in, audible: plays a tone and switches the default output; the helper's tap must follow
make e2e-desktop      # Electron smoke test: builds, then runs with a fake helper, audio and speech-to-text
make eval-notes       # notes eval over apps/api/evals/notes/cases (ARGS="--judge-model ...")
make eval-notes-fixes # edit size between each meeting's generated notes and the current ones
```

The benchmark's method, results and vendor log are in `docs/research/stt-benchmark.md`, which
also says how to run each command. How to run the notes eval: the module docstring of
`apps/api/src/roger_api/evals/notes_eval.py`. `make e2e-desktop` needs the Electron binary once per
checkout (see the failure log). On a Mac `make check` also runs the helper's selftest and the
`*.mac.test.ts` suite; it never creates a real tap or raises a privacy prompt.

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
   session at once, a stalled one after the stall window and one whose chunks hold no speech after
   the silence gate's hang-over (`sttSilenceCloseSeconds`), and it reopens only with audio, a gated
   one only with speech. The numbers live in `apps/desktop/src/main/costGuards.ts`.

## Where things are (desktop)

| To find | Look in `apps/desktop/src/main/` |
| --- | --- |
| Start, Stop, the status the window reads | `capture/CaptureService.ts`; per-source sessions and reopens: `capture/CaptureSession.ts` |
| Vendor sockets, the open budget, the cost numbers | `stt/core/SttConnection.ts`, `capture/SttOpenBudget.ts`, `capture/GateTokens.ts`, `costGuards.ts` |
| Loud warnings and notifications | `capture/SignalMonitor.ts`, `capture/warnings.ts`, `notify/Notifier.ts` |
| Mic lines that repeat call audio | `capture/echo/` (`EchoFilter` pure, `EchoSink` stores, hides and holds) |
| Call audio, the monitor, the helper's place | `native/HelperProcess.ts`, `native/helperPath.ts`, `detect/MeetingAppMonitor.ts` |
| Offer to take notes, stop when the call ends | `detect/CallDetector.ts` (rules), `detect/CallOffer.ts` |
| Audio backup, gap re-run, crash resume | `backup/`, `rerun/`, `recovery/CrashRecovery.ts` |
| Sleep and wake, quit, window close | `power/PowerCoordinator.ts`, `lifecycle.ts`, `app/windowLifecycle.ts` |
| Permission setup screen's checks | `setup/` (`PermissionService`, the signing and audio probes) |
| Local safety copy and its upload | `store/SqliteTranscriptStore.ts`, `upload/TranscriptUploader.ts`, `upload/SttUsageUploader.ts` |
| Calendar, reminders, the prompt panel | `calendar/createCalendarRuntime.ts`, `prompt/PromptService.ts`, `prompt/PromptWindow.ts` |
| Notes and chat in main | `notes/` (`NotesGenerator`, the IPC in `notes-ipc.ts`) |
| Every feature's wiring, in order | `index.ts` and `capture/createCaptureRuntime.ts`, one `[slot <task>]` marker each |
| The IPC contract | `src/shared/ipc.ts` and `src/shared/ipc/<feature>.ts` |

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

## Words (one word per concept)

What a person reads follows `docs/design.md` (Copy, Naming list); the short form:

- **Start notes** (with a video link **Join and start notes**) and **Stop**; never "New note", "Take
  notes".
- **meeting** is what Roger keeps, **call** only the live audio; the state is **Recording**.
- **My notes**, **AI notes**, **Write notes**, **Write again as**; never "Generate", "Regenerate".
- **Jargon list** (an entry is a **term**), **Settings**, **Set up Roger**, **Details**, **Today**,
  **Earlier**.
- Saving is silent when it works: **Saved on this Mac** (server away), **Not saved** (this Mac
  failed), **Not saved to Roger** (server refused), each with its reason.
- **Try again** (a read), **Check again**, **Transcribe again**, **Dismiss** (a notice), **Cancel**
  (only mid-work), **Reconnect**, **Delete audio**.
- **microphone** is **Me**, **call audio** is **Them**; **Roger's server**, never "Postgres" or
  "API" outside Details.
- Times "9:14 am", durations "1h 23m", offsets "4:07"; sentence case, no full stop on a button.

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
- Do not copy anything from `ROGER_BENCH_DIR` (default `~/Roger-bench`) into the repo: it holds
  recordings of colleagues and their transcripts (M3 D2). Only the aggregate numbers that
  `make bench ARGS="report --summary"` prints go in `docs/research/stt-benchmark.md`.
- Do not add a third app, a shared package or a new service without a plan that says why.
- Do not change the API contract on one side only.
- Do not skip, disable or quarantine a test to get green.
- Do not put a model name or agent name in code, commits or docs.

## Failure log

Each line is a trap someone already hit. Add one when you hit a new one: here when it bites both
apps, the repo's tooling or this Mac; in `apps/desktop/CLAUDE.md` when it bites only the desktop
app (its bench, e2e and QA scripts and the Swift helper included); in `apps/api/CLAUDE.md` when it
bites only the API. Those two files hold the rest of this log: read the one for the app you touch
before you start.

- `uv run` without `--frozen` re-resolves `uv.lock` when the machine has a global `exclude-newer`
  in `~/.config/uv/uv.toml`, and fails on deps newer than the cutoff (`mcp>=2.3`, first Mac run,
  2026-10-05). The Makefile now runs every uv command with `--frozen`; outside make, type
  `uv run --frozen` or export `UV_FROZEN=1`.
- `pnpm install --frozen-lockfile` failed with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` under a global
  `auto-install-peers=false`; `pnpm-workspace.yaml` now pins `autoInstallPeers: true` to match the
  lockfile. Still machine-specific: with a global `ignore-scripts=true` the Electron binary is
  never downloaded. Fetch it once with `node node_modules/electron/install.js` inside
  `apps/desktop`; do not change the global config.
- Ruff `RUF001` rejects lookalike Unicode (en dash, curly quotes, `‹`) in Python string literals:
  write `\u2013`, `\u2019`, `\u2039`. An agent's Write and Edit tools both turn the escapes back
  into literal characters, in tests too (M4-T5, M3-T2, M5-T2), and in TypeScript strings and regexes
  (a BOM in a regex failed `no-irregular-whitespace`; curly quotes passed silently, M3-T10): search
  for non-ASCII after every write or edit and fix a hit with a script that emits the escape. On
  this Mac use `perl -ne 'print if /[^\x00-\x7F]/'`: BSD grep has no `-P` and reads no `\x`
  escapes, so a `grep` for it finds nothing (M3-T19b). A `\u00a0` written into a TSX string came
  back as a literal no-break space, which lint refused (redesign R2).
- pnpm 10.28 here does NOT enforce the global `minimum-release-age=10080`: `@tiptap/core@^3.31.0`
  resolved to a 6-day-old 3.31.4 (P2-F3, 2026-10-06). After any `pnpm add`, check each new
  lockfile version's publish date (`npm view <pkg> time`). `@tiptap/react` pulls its bubble and
  floating menus with `^` while they need the exact same `@tiptap/core`: the overrides in
  `pnpm-workspace.yaml` pin them, so bump them together with the five TipTap packages.
- A speech-to-text token may open only one connection: a second websocket on one xAI client secret,
  at once or after a close, is HTTP 401, so every two-stream Start failed while the one-stream
  canary passed (2026-10-08). Each adapter declares `credentialUse`; a single-connection vendor's
  token never reaches two opens (Start's two sources, the gate's prefetch in `GateTokens.ts`, the
  retry without the jargon list, the re-run, the bench), and every `SpeechToText` test double
  declares it too. Probe a new vendor with two connections on one token, at once and after a
  close, before declaring `'reusable'`.
- Merging does not update `/Applications/Roger.app` or a running API: after the redesign merged,
  Rahul still saw the old UI and the API on 8010 ran without the xAI code (2026-10-08). After
  landing desktop or API changes, run `make install-desktop` and restart the API.
- AssemblyAI's session cap, `max_session_duration_seconds`, is a parameter of the temporary-token
  request (the API sets it), not of the websocket URL; `inactivity_timeout` is the other way round
  (the desktop sets it). Its streaming page lists only the second (2026-10-06).
- Alembic revisions 0002-0005 began as empty stubs (P2-F2). A stub filled in place is invisible to a
  database migrated while it was empty: `upgrade head` is a no-op and `downgrade` raises
  `UndefinedTable`. Tests drop and rebuild their database every run, so they never show it. Never
  `make migrate` the dev database from a Phase 2 branch before its stubs are filled (all four are
  filled on `phase-2` since wave 3); to repair one, stamp the last revision it really holds, then
  upgrade: `uv run --frozen alembic stamp 0001 && uv run --frozen alembic upgrade head` for one
  migrated before any was filled, `stamp 0004` if only 0005 was empty (2026-10-06, M3-T19a).
- On this Mac `cc` aliases `claude --enable-auto-mode`: compile test stand-ins with `/usr/bin/cc`,
  never a copied `/bin/sleep` (macOS SIGKILLs a system binary copied out) (M2-T8).
- No meeting content in logs through an error: `log.py` renders no frame's locals
  (`show_locals=False`, and the dev console pinned to `plain_traceback`, because with `rich`
  installed structlog's default shows them; `tests/test_log.py`), but the exception's text is
  still logged and SQL parameters stay hidden only by `hide_parameters`. Log the error type and
  innermost frame (`llm_runs._log_failure`) or fail as a handled error. V8's `JSON.parse` error
  quotes the text near the fault, and a store error that quotes a column leaks it the same way:
  name the row id (`SqliteTranscriptStore` `parseWords`, `rowToSegment`) (M4-T7, M5-T3, M4-T15,
  P2-C1, M4-S4b).
- The Mac's disk ignores case: two files in one folder whose names differ only in case break in
  silence (an import resolved to the other file, TS1261; a write overwrote it, and a vitest run
  still passed on the wrong content: `echoLines.ts` against `EchoLines.tsx` and their tests). Name
  helpers distinctly and `ls` after creating a pair (M3-T7, M2-T20b).
- A millisecond value the desktop computes can be fractional (a renderer capture time,
  `pcmBytesToMs`), and an API int field refuses it with a 422 (`int_from_float`): the uploaders
  then set the row aside for good. Round where the desktop makes the value
  (`CaptureSession.meetingOffset`, M2-T5), or at the API edge when the field is a measure
  (`UsageMs` in `schemas/stt_usage.py`, M3-T19a).
- A task that renames or moves a shared helper while another task in flight imports the old name
  breaks only after both merge: each branch is green alone. M4-T10 imported
  `schemas.notes._storable_text`, which P2-C1 moved to `schemas/common.py` as `storable_text`, and
  the merged `make check` failed in mypy (attr-defined; fixed in 0c90f89, wave 3). Before you
  rename or move a symbol another file imports, grep its importers on `phase-2` and on the branches
  in flight (`git grep -n <name> $(git for-each-ref --format='%(refname:short)' refs/heads/p2/)`),
  and name the rename in your hand-off.
- BSD `sed -i -E ...` reads `-E` as the backup suffix and leaves a stray `<file>-E` (found in
  `git status`): edit with `perl -pi -e` or a script (M2-T17b). A relative path is read from the
  wrong folder twice over: `git -C <worktree> commit -F <file>` resolves it in the worktree, and
  `pnpm exec vitest ... > ../../x.log` from `apps/desktop` lands in the repo root. Use absolute
  paths for message and log files (M2-T20b).
