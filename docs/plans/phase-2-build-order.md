# Phase 2 build order (M2 to M5)

**Status:** draft for the owner's sign-off · **Owner:** Rahul · **Written:** 2026-10-06 ·
**Updated:** 2026-10-06, after `m1-assemblyai` merged into `phase-2` (what changed: section 9.2),
and after a review of that update (section 9.3)

This is the integration plan that parallel coding agents run, each in its own git worktree. It
sits above the four milestone plans:
[M2](M2-capture-you-can-trust.md), [M3](M3-live-transcript.md), [M4](M4-notes-and-ai.md) and
[M5](M5-calendar.md). Each milestone plan says **what** a task builds and how it is tested. This
file says **when** each task runs, **which files** it may touch, and **how** the work is merged.
Where this file and a milestone plan disagree on ownership, ids, migration ids or order, this file
wins. The plans were edited to match (see "Changes made to the milestone plans").

Paths: desktop paths are under `apps/desktop/src/` unless they start with `apps/`, `preview/`,
`bench/`, `e2e/`, `native/`, `scripts/` or `test/` (those are under `apps/desktop/`). API paths are
under `apps/api/src/roger_api/` unless they start with `tests/` (`apps/api/tests/`) or `apps/`.

## 0. Before wave 0: close M1

M0 is closed (2026-10-05). M1 is "in review" and needs three things.

1. **`m1-assemblyai`: merged into `phase-2` on 2026-10-06 (merge commit a3be3ee), not yet on
   `main`.** It holds the owner decisions of 2026-10-06: AssemblyAI Universal-Streaming English
   replaces Deepgram as the vendor (Deepgram stays as the second adapter), the STT layer must be
   very easy to switch between providers, and opening and closing live audio sessions must be
   very conservative about cost (AssemblyAI bills every second a session is open, silent or not,
   and a meeting opens two). Its 38 commits add, on top of the plans as first written:
   - API: the AssemblyAI token issuer (with the 3-hour session cap asked for explicitly), the
     vendor registry `roger_api/stt_vendors.py` (issuer, default model, model prefix, token TTL
     limit, list price per stream-hour by model), and `stream.price_per_hour_usd` in
     `/v1/stt/token`.
   - Desktop: one websocket lifecycle in `src/main/stt/core/` (`SttProtocol`, `SttConnection`,
     `WebSocketSpeechToText`) that every vendor runs on; the AssemblyAI and Deepgram protocols on
     it; `stt/registry.ts`; a conformance suite (`stt/conformance.test.ts`,
     `stt/testing/{conformanceVendors,fakeVendorServer}.ts`) that fails any registered vendor that
     leaves a socket open.
   - Cost guards, G1 to G7: `costGuards.ts` (every number, validated, a refused value blocks
     Start); a failed or ended source closes its session at once; a source with no chunk for 30 s
     is `paused` and reopens with a fresh token and at most 3 s of held audio; vendor failures are
     `retrying` with a doubling backoff; every open passes `capture/SttOpenBudget.ts` (4 a minute,
     30 a meeting); `lifecycle.ts` stops the recording on quit (5 s bound), sleep, window close,
     renderer crash and reload; auto-stop after 15 minutes without a final line or at 4 hours
     (`capture/stopReasons.ts`); AssemblyAI's `inactivity_timeout`; a meter and a stop notice in
     `CaptureStatus`; local SQLite migration 3, `stt_usage`.
   - CLAUDE.md architecture rule 9: every vendor connection goes through the shared core and the
     open budget.

   Every Phase 2 task builds on it; none re-builds or fights it. The M2 and M3 tasks it overlaps
   were rescoped (section 9.2). Rahul merges `m1-assemblyai` into `main` when he closes M1
   (`main` is its ancestor, so the merge is clean); the phase gate carries it to `main` otherwise.
2. **M2-T1's Mac check** (wave 0). On the installed app (`make install-desktop`): Start, grant,
   quit, relaunch, Start again. There must be no new prompt and call audio must be present. This
   is the field report from today ("can't detect system audio", "asks for the mic every
   restart"). The `tccd` log shows those were ad-hoc-signed builds, from before commit 30e137c
   (stable signing identity). T1 proves the fix, or finds the next cause.
3. **The M1 real call.** First, opt AssemblyAI out of training in its dashboard (owner, free).
   Then hold a 30-minute Meet call on the installed app (built from `phase-2` or `m1-assemblyai`)
   with `STT_PROVIDER=assemblyai` on the API, and ask Claude through MCP to quote a line. Record it
   in the M1 exit check log, with the call's `stt meter at stop` log line (sessions opened,
   connected time, estimated cost).

Until M2-T10 lands, call audio still goes through Electron's `desktopCapturer`. It needs Screen &
System Audio Recording turned on for Roger.

## 1. Shared foundations (wave 0)

Each foundation has exactly one owning task. A foundation creates the seams and the empty
(stub) files that later tasks fill in. After that, a feature task adds new files and fills its
own stubs. It does not edit a file another task owns. A stub file starts with a comment that names
its owner ("Stub from P2-F1; owned by M4-T13").

| Foundation | Owner | What it creates |
| --- | --- | --- |
| App shell and navigation | M4-S1 (frame, routes, slots, `app:navigate`), M4-S2 (tokens, `PreferencesStore`), M4-S4 and M4-S4b (meeting page and meeting reads) | M5's `SHELL-0` is folded in: its `app:navigate` spec goes to S1 and its preferences spec goes to S2. "SHELL" in any plan means M4-S1 to M4-S4b. |
| IPC contract extensions and the main-process composition root | **P2-F1** | Per-feature IPC modules, preload bridges, preview fakes, the trusted-sender helpers, a shared HTTP core for the API client, and named slots in `main/index.ts` |
| API router, service, model, settings and migration layout | **P2-F2** | Router stubs registered once, lifespan hooks, per-domain model modules, the fixed Alembic chain, every Phase 2 error class, test-database isolation and the contract skeleton |
| Tooling, the Swift helper build step, new dependencies | **P2-F3** (Make targets, scripts, configs, dependencies, lockfile); **M2-T7** (the Swift sources, `scripts/build-native.sh` and the Darwin `make check` wiring) | One lockfile change and one Makefile change for all of Phase 2 |
| Test fixtures | M2-T3 (`test/fixtures/backup/`, moved from M2-T15 so M3-T12 can start early), M2-T10 (`test/fixtures/fake-roger-audio.mjs`), M4-T4 then M4-T8 (`apps/api/tests/fixtures/ai_notes_doc.json`), M5-T2 (`tests/fixtures/calendar/`), M3-T5 (`stt/assemblyai/fixtures/`), P2-F1 (`preview/fakes/*` stubs), M4-S3 (preview scenarios and fixtures) | Each fixture has one writer; the tests that read it are listed in the owning plan |
| STT layer and cost guards (landed, `m1-assemblyai`) | Not a Phase 2 task. Later edits are owned per file in section 3.1: `stt/core/*`, `stt/conformance.test.ts` and `stt/testing/*` (M3-T18, T4a, T5, M2-T6, M3-T15), `stt/registry.ts` (M3-T15), `costGuards.ts` (M3-T18's comment, M3-T20), `capture/SttOpenBudget.ts` (M2-T4), `lifecycle.ts` (P2-F1, M2-T12, M2-T18, M5-T11), `capture/stopReasons.ts` (M2-T12, M2-T17b), `stt_vendors.py` (M3-T1, T3, T14) | The shared lifecycle every vendor runs on, the registries on both sides, the conformance suite, `costGuards.ts`, `capture/SttOpenBudget.ts`, `capture/stopReasons.ts`, `lifecycle.ts`, the meter and local migration 3 (`stt_usage`). Every task keeps their tests green; a vendor is one protocol file, one issuer, one line per registry and one conformance entry |

### P2-F1. Desktop seams (S/M, no dependencies)

- `shared/ipc.ts` becomes a barrel. `IpcChannel` spreads per-feature channel maps, and `RogerApi`
  is the intersection of per-feature API types. Each feature has one module: `shared/ipc/capture.ts`
  (today's content moved here), `setup.ts`, `app.ts`, `prefs.ts`, `meetings.ts`, `vocabulary.ts`,
  `notes.ts`, `chat.ts`, `calendar.ts`, `loginItem.ts`, and `prompt.ts` (the prompt panel's own
  API; it is not part of `RogerApi`). After F1 nobody edits `shared/ipc.ts`.
  `shared/ipc.test.ts` asserts that channel names and keys are unique across features, because a
  duplicate key in a spread overwrites another channel with no error. The barrel keeps exporting
  `PCM_SAMPLE_RATE` and `PCM_ENCODING`: `CaptureSession`, `CaptureService`, `stt/streamSettings.ts`
  and the AssemblyAI protocol import them from `shared/ipc`. `shared/capture.ts` does not move; its
  landed status fields (`streams` with `paused` and `retrying`, `streamMessages`, `meter`,
  `notice`) come through unchanged, and `preview/fakes/capture.ts` builds every status from
  `idleCaptureStatus()` so the fakes always carry them.
- `preload/index.ts` composes `preload/bridges/<feature>.ts` with the helpers in
  `preload/bridge.ts`. After F1 nobody edits `preload/index.ts`. `renderer/src/roger.d.ts` does
  not change.
- `preview/fakes/<feature>.ts` stubs and `preview/fakeRoger.ts` (the composer). The rule: **the
  task that adds members to `shared/ipc/<feature>.ts` also writes the bridge in
  `preload/bridges/<feature>.ts` and the fake in `preview/fakes/<feature>.ts`**. The type check
  enforces it.
- `main/ipc/trust.ts` (with a test): `isTrustedSender`, `handleTrusted`, `onTrusted`, taken out of
  `main/ipc.ts`. Every feature registrar imports them. This replaces M4-T16's "export the
  trusted-sender check".
- `main/api/http.ts`: `apiRequest(method, path, body)` for GET, POST, PUT and DELETE, plus
  `toApiError` and `authHeaders`. `ApiClient.ts` is rebuilt on top of it with no change in
  behaviour (the token response type keeps `price_per_hour_usd` optional, as an older API omits
  it). Feature clients live in their own files: `api/vocabularyClient.ts` (M3-T8),
  `api/sttUsageClient.ts` (M3-T19b), `api/notesClient.ts` (M4-T14), `api/streamRequest.ts`
  (M4-T15) and `api/calendarClient.ts` (M5-T6). This replaces M4-T13's ApiClient prep. DELETE is
  included because M5-T6 needs it. After F1, only M3-T4a (the token type) and M5-T5 (the create
  payload) edit `ApiClient.ts`.
- **The quit sequence** (`main/lifecycle.ts`, landed): `RecordingLifecycle` owns `before-quit` and
  `will-quit` since the cost guards landed (stop the recording within `quitStopTimeoutMs`, then a
  synchronous `beforeExit` that stops the uploader and closes the store, then `app.quit()`). F1
  turns `beforeExit` into an ordered list of quit hooks, each awaited with its own bound and each
  failure logged, so M4-T16's notes flush (asynchronous, up to 1 s) runs after the stop and before
  M2-T4's uploader stop and store close; with a test in `lifecycle.test.ts` (order, a hook that
  throws or hangs still quits). Nobody adds a `before-quit` listener of their own.
- **Conformance stays green.** F1 moves no file under `src/main/stt/`, `costGuards.ts`,
  `capture/SttOpenBudget.ts` or `capture/stopReasons.ts`. Its gate includes the conformance suite,
  `costGuards.test.ts` and `lifecycle.test.ts` unchanged except for the quit-hook cases.
- `main/index.ts` gets named **slots**, with no change in behaviour. Each slot is a marker comment
  line, `// [slot <task>] <what>`, followed by a blank line. A task inserts its block under its
  own marker and never moves a marker. Two tasks that edit different slots merge cleanly, because
  the next marker is an unchanged line between them. The slots, in file order:
  1. `[slot M2-T13]` e2e mode: temporary user data and no TCC prompt. It must come before the
     single-instance lock.
  2. `[slot M5-T11 userData]` sets the "Roger Dev" data folder when not packaged. It must come
     before the lock, and it must never override userData under `ROGER_E2E=1` or an explicit
     `--user-data-dir` (M2-T13).
  3. `[slot M4-S2]` the preferences store.
  4. `[slot M2-T4 store]` today's store creation.
  5. `[slot M2-T23]` today's `endMeetingsLeftOpen` lines. M2-T23 replaces them with
     `CrashRecovery`.
  6. `[slot M4-T16 notes store]` creates `notes.sqlite`. It sits before the uploader because the
     uploader and capture need `hasNotes`.
  7. `[slot M2-T4 runtime]` today's API client, uploader, capture service and capture IPC, with
     the cost-guard wiring as it is today: `config.costGuards` into `createSpeechToText` and
     `CaptureService`, `config.errors` into the startup error (a refused guard blocks Start), and
     the `RecordingLifecycle` with `watchApp`.
  8. `[slot M4-S1]` navigation and the app menu.
  9. `[slot M4-S4b]` meetings IPC.
  10. `[slot M3-T8]` vocabulary IPC.
  11. `[slot M4-T16 notes]` notes and chat IPC, the generator and the sync.
  12. `[slot M5-T9c]` the calendar runtime and the start-request enricher.
  13. Window creation (today's lines, `watchWindow(lifecycle, window)` included).
  14. `[slot M5-T11 lifecycle]` the tray, the login item, `activate`, and today's
      `window-all-closed` handler, which moves into this slot.
  15. In the lifecycle's quit-hook list (see "The quit sequence" above): `[slot M4-T16 quit]`
      (flush notes) before `[slot M2-T4 quit]` (today's uploader stop and store close; the stop
      itself is `RecordingLifecycle`'s).

  M2's own features (T6, T10, T11, T14b, T15, T16, T17a, T17b, T18, T19) and M3-T19b's usage
  uploader register through the slots that M2-T4 makes in `capture/createCaptureRuntime.ts`, not
  in `index.ts`.

### P2-F2. API seams (M, no dependencies)

- **Routers.** Stub `routers/vocabulary.py`, `note_templates.py`, `notes.py`, `notes_runs.py`,
  `chat.py`, `calendar.py` and `stt_usage.py` (M3-T19a), each with an empty
  `router = APIRouter()`. All of them are included in `app.py` once. After F2, only M3-T1 edits
  `app.py` (the `api_started` fields).
- **Lifespan hooks.** `app.py` already enters `open_stt_token_issuer(settings)` (from
  `stt_vendors.py`, landed); F2 adds `open_llm_runtime(settings)` (stub in
  `services/llm_runs.py`, owned by M4-T7) and `open_calendar_runtime(settings)` (stub in
  `services/calendar/runtime.py`, owned by M5-T3) beside it, and stores both on `app.state`.
  **Rule:** a feature's FastAPI getters and `Dep` aliases live in its own service module, never in
  `dependencies.py`. Nobody edits `dependencies.py` in Phase 2.
- **Models.** Stub modules `db/models_vocabulary.py` (M3-T2), `db/models_notes.py` (M4-T1),
  `db/models_calendar.py` (M5-T1) and `db/models_stt_usage.py` (M3-T19a), imported at the end of
  `db/models.py` so that Alembic and the test truncation see them. Only M5-T1 edits
  `db/models.py` afterwards (the new `Meeting` columns).
- **The Alembic chain** (section 2): four no-op revisions with fixed ids (`0002` to `0005`).
  `test_migrations.py` gains `test_alembic_has_one_head` and `test_revision_chain_is_fixed`.
- **Settings.** `config.py` composes `Settings` from two pydantic mixins with no `model_config`:
  `NotesSettings` in `config_notes.py` (M4-T2) and `CalendarSettings` in `config_calendar.py`
  (M5-T1). The STT fields stay in `config.py`, owned by M3-T1, with the landed registry wiring
  untouched: `config.py` imports `STT_VENDORS` from `stt_vendors.py`, while `stt_vendors.py`,
  `services/stt_tokens.py` and `log.py` import `Settings` only under `TYPE_CHECKING` (a runtime
  import back is an import cycle that fails at startup; the comments at each site say so). The
  mixin files import neither. F2 leaves `test_config.py`'s STT cases and `test_stt_token.py`
  untouched and green; M3-T1 rewrites their `STT_MODEL` cases in wave 1.
- **Errors.** `errors.py` gains every Phase 2 error class:
  - `LlmProviderError` (502 `llm_provider_error`)
  - `EmptyMeetingError` (422 `empty_meeting`)
  - `MeetingTooLongError` (422 `meeting_too_long`)
  - `CalendarProviderError` (502 `calendar_provider_error`)
  - `CalendarReconnectRequiredError` (424 `calendar_reconnect_required`)

  Each has an envelope test.
- **Domain types.** `domain.py` gains `NoteKind`, `RunKind`, `RunStatus` and `StartSource` (all
  five values, `call_detected` included). It keeps the landed `SttProvider` (the vendor ids;
  M3-T14 adds `soniox` in wave 3).
- **Contract skeleton.** In `docs/api-contract.md`: the title loses "(M1)". The error table gains
  the five codes above. The 409 row is generalised and "This is the only `409`" is deleted. Each
  route's 409s are written in that route's section by its owner. Empty sections are added, each
  with its owner: Vocabulary (M3-T2), STT usage (M3-T19a), Note templates (M4-T3), Notes (M4-T6),
  Notes runs and streaming (M4-T8), Chat (M4-T10) and Calendar (M5-T3). The Database section gets
  one line per table group: M3-T2, M3-T19a, M4-T1 and M5-T1. The token section (provider table,
  `price_per_hour_usd`, landed) is left as it is for M3-T1.
- **`.env.example`.** Empty sections, each filled by its owner: Notes and AI (M4-T2), Calendar
  (M5-T1) and, in the desktop part, Benchmark (M3-T13). The landed STT section (M3-T1's next) and
  the desktop cost-guard block (`ROGER_STT_*` and the other guards; `costGuards.test.ts` fails if
  a guard is missing from it or from the README table; M3-T20 adds its three) stay as they are.
- **`tests/conftest.py`.** It creates the database named in `TEST_DATABASE_URL` when it is
  missing, connecting through the `postgres` maintenance database. It refuses any database whose
  name does not start with `roger_test`, so a worktree never truncates the dev database `roger`.

### P2-F3. Tooling and dependencies (S, needs the owner's sign-off on OD-8)

- **`apps/desktop/package.json` and `pnpm-lock.yaml`** (the only lockfile change in Phase 2):
  - Exact versions: dev `playwright-core` 1.63.0, plus `@tiptap/core`, `@tiptap/react`,
    `@tiptap/pm`, `@tiptap/starter-kit` and `@tiptap/extensions`, all at 3.31.3.
  - Scripts: `test:mac`, `test:e2e`, `preview:renderer` and `bench` (it builds to
    `bench/dist/cli.js`).
  - `engines.node` becomes `>=22.13.0`.
  - Install with pnpm only. `~/.npmrc` pins npm to 2026-05-06, so never use `npm install`. This
    Mac's global pnpm rc sets `minimum-release-age=10080`, but pnpm 10.28 does NOT enforce it
    (P2-F3, 2026-10-06: `^3.31.0` resolved to a 6-day-old 3.31.4). Check every new lockfile
    version's age by hand. `pnpm-workspace.yaml` overrides pin `@tiptap/extension-bubble-menu` and
    `@tiptap/extension-floating-menu` to the same version as the five TipTap packages.
  - Re-check `npm view <pkg> time` and the weekly downloads for each package at install time, and
    write the numbers in the commit message.
- **Vitest configs.** `vitest.config.ts` includes `src/**`, `bench/**` and `preview/**` tests, and
  excludes `**/*.mac.test.ts` and `e2e/**`. New `vitest.mac.config.ts` and `vitest.e2e.config.ts`
  (with `passWithNoTests`).
- **Type check and lint.** `tsconfig.node.json` includes `bench/**`, `e2e/**`, `vitest.*.ts` and
  `vite.preview.config.ts`. `tsconfig.web.json` includes `preview/**`. `eslint.config.mjs` gets
  node globals for `bench/**` and `e2e/**` and browser globals for `preview/**`. As built:
  `e2e/**` and `qa/**` live in a new `tsconfig.e2e.json` (Node plus DOM types, because
  `page.evaluate` callbacks run in the page) that the type-check script also runs; DOM stays out
  of `tsconfig.node.json`. Node scripts under `test/` should be `.mjs`. This replaces M3-T10's
  `tsconfig.bench.json`, eslint and type-check edits.
- **Root `Makefile`:**
  - A `TEST_DB` variable: `make check TEST_DB=roger_test_m3_t2` exports `TEST_DATABASE_URL` for
    `test-api`.
  - Targets `native`, `test-native-route`, `e2e-desktop`, `bench`, `stt-canary`, `eval-notes`
    and `eval-notes-fixes`, each one line that delegates. The `check` wiring that runs
    `roger-audio selftest` and `pnpm test:mac` on Darwin is M2-T7's, because it needs the helper
    to exist.
- **`.gitignore`.**
  - The root file ignores `apps/api/evals/notes/cases/local/` and `apps/api/evals/notes/reports/`.
  - The root file un-ignores `apps/desktop/test/fixtures/**/*.sqlite`. The root `*.sqlite` rule
    would otherwise drop M2-T3's backup fixture without a word.
  - `apps/desktop/.gitignore` ignores `native/bin/` and `bench/dist/`.

## 2. Migration ids

**Alembic** (`apps/api/src/roger_api/migrations/versions/`). P2-F2 creates the files as no-op
revisions, so every worktree has the whole chain and one head from the start. The owner fills in
`upgrade()` and `downgrade()` in the same commit as its models. Nobody re-points a
`down_revision`. A new Phase 2 revision needs a row here and an update to
`test_revision_chain_is_fixed`.

| Revision | File | `down_revision` | Owner | Contents |
| --- | --- | --- | --- | --- |
| `0001` | `0001_initial_schema.py` | `None` | M1 | workspaces, meetings, transcript_segments |
| `0002` | `0002_vocabulary_terms.py` | `0001` | M3-T2 | `vocabulary_terms` |
| `0003` | `0003_notes.py` | `0002` | M4-T1 | `meeting_notes`, `llm_runs`, `chat_messages` |
| `0004` | `0004_calendar.py` | `0003` | M5-T1 | `pgcrypto`, `calendar_connections`, `meeting_attendees`, the new `meetings` columns with the five-value `start_source` check |
| `0005` | `0005_stt_usage.py` | `0004` | M3-T19a | `stt_usage`, one row per workspace and meeting, no foreign key to `meetings` |

This replaces M3's `apps/api/migrations/versions/0002_...` (wrong folder), M4's unnamed revision,
M5's `0005_calendar`, and every "down_revision is whatever head phase-2 has at merge" note.

**Local SQLite.**

- `roger.sqlite` (`SqliteTranscriptStore.MIGRATIONS`): migration 3 is taken by M1's cost guards
  (`stt_usage`, landed with `m1-assemblyai`). Migration 4 is M2-T3's, migration 5 is M5-T5's
  (`meetings.start_source`, `meetings.calendar_event_json`) and migration 6 is M3-T19b's
  (`stt_usage.synced_at`, `stt_usage.gated_ms`). Each starts after the one before has merged
  (waves 1, 4 and 5). A migration test winds a file back to the schema before it, as the landed
  `stt_usage` test does.
- `notes.sqlite` (M4-T14) and `calendar.sqlite` (M5-T7) have their own `user_version` and take no
  number from this list.

## 3. Waves

A wave's tasks run in parallel. **Wave N starts when every task of wave N−1 has merged into
`phase-2`.** Inside a wave, no two tasks edit the same file, except through the slot and
section mechanisms in section 3.1, or where a merge order is stated. Size: S is under an hour of
agent time, M is one to two hours. "(Mac)" means a person runs a check on the Mac. "Optional" means
the task depends on an owner decision.

**Wave 0. Foundations, the M1 close, pure modules**

Merged on `phase-2` by 2026-10-06: M2-T1, M2-T14a, M3-T6a, M4-T4, M4-T5, M4-T21a, M5-T8, P2-F3,
and `m1-assemblyai` (a3be3ee). Still to run: P2-F1, P2-F2 and M3-T18 (M2-T0 is the human spike).

| Task | Size | Owns | Needs |
| --- | --- | --- | --- |
| P2-F1 | S/M | see section 1 (also `main/lifecycle.ts` and its test: the quit hooks) | `m1-assemblyai` (merged into `phase-2`) |
| P2-F2 | M | see section 1 | `m1-assemblyai` (merged; it edits `config.py` and `app.py` too) |
| P2-F3 | S | see section 1 | OD-8 |
| M2-T0 | S | throwaway branch, never merged; the result goes into M2 D2 | human (Mac) |
| M2-T1 | S | `main/signing.ts`, `main/settingsPanes.ts` (with tests), the M1 exit log entry | (Mac) |
| M2-T14a | S | `main/capture/echo/EchoFilter.ts` (with test): pure, no Electron imports | - |
| M3-T6a | S | `main/stt/LatencyMeter.ts` (with test) | - |
| M3-T18 | M | Pacing in the STT core: `stt/core/AudioPacer.ts` (with test), `audioPacing` in `stt/core/SttProtocol.ts` and the paced queue in `stt/core/SttConnection.ts`, `stt/assemblyai/AudioFrameSizer.ts` moved unchanged to `stt/core/` (with its test), the `audioPacing` lines in the AssemblyAI and Deepgram protocol files, a conformance case for every vendor, one line of the README's vendor checklist, and the comments pacing makes false: `capture/CaptureSession.ts` (the `hold()` doc and the pacing comment at the flush in `attach()`), `costGuards.ts` (the `sttReopenBufferMs` `why`) and the README's "Reopen buffer" row | - |
| M4-T4 | S | `services/notes_markdown.py`, `tests/fixtures/ai_notes_doc.json`, `tests/test_notes_markdown.py` | - |
| M4-T5 | M | `services/notes_prompt.py`, `notes_protocol.py`, `citations.py` (with tests) | - |
| M4-T21a | S | `renderer/src/transcript/transcriptNavigator.ts` (the contract commit, with test) | - |
| M5-T8 | S | `shared/calendar.ts`, `shared/calendarPrefs.ts`, `main/calendar/ports.ts`, `main/calendar/reminderPolicy.ts`, `shared/meetingLinks.ts` (with tests) | - |

**Wave 1**

| Task | Size | Owns |
| --- | --- | --- |
| M2-T2 | M | `shared/capture.ts` (adds `offline`; keeps every landed status field), the `offline` case of `describeStream` in `renderer/src/format.ts` (its switch has no default, so without it the type check fails, TS2366), `shared/ipc/capture.ts`, `shared/ipc/setup.ts`, the `capture` and `setup` bridges and fakes, `main/config.ts`, `main/ipc-validation.ts` (with tests) |
| M2-T3 | M | `main/store/*` except the sync statements, with local migration 4; `test/fixtures/backup/` (a small `roger.sqlite` plus WAV and m4a chunks with a gap, and the script that makes them) |
| M2-T7 | M | `native/roger-audio/{main,Protocol,Tap,RingBuffer,Lifecycle,SelfTest}.swift`, stub `Probe.swift` and `Monitor.swift` (called by `main.swift`), `scripts/build-native.sh`, the Darwin lines of `make check` |
| M3-T1 | S | `stt_vendors.py` (`STT_PRESETS`), `config.py` (the STT fields: a preset id, `STT_MODEL` refused), `schemas/stt.py`, `app.py` (`api_started` fields), `tests/test_stt_providers.py`, `tests/test_config.py` (STT cases), `.env.example` (STT section), the STT settings in `apps/api/README.md`, the contract's token `provider` line and presets, the three `stt_model="nova-2"` cases of `tests/test_stt_token.py` (they fail once `STT_MODEL` is refused), and in `stt_vendors.py` the issuer lookup by the resolved vendor (`open_stt_token_issuer`, line 114, else `assemblyai-pro` is a `KeyError` at startup). The landed issuers, price table and `test_assemblyai_*` cases are not rewritten |
| M3-T2 | M | `db/models_vocabulary.py`, `0002_vocabulary_terms.py`, `services/vocabulary.py`, `schemas/vocabulary.py`, `routers/vocabulary.py`, `tests/test_vocabulary.py`, the contract's Vocabulary section and its Database line, the route check in `tests/test_http_plumbing.py` (section 3.1) |
| M3-T4a | M | `main/stt/SpeechToText.ts` (optional `keyterms`, `SttConnectError.keytermsRejected`), `main/stt/keyterms.ts`, `stt/core/{SttProtocol,SttConnection}.ts` (the keyterm-rejection signal; no retry), `main/stt/deepgram/DeepgramSpeechToText.ts` (`keyterm`, `mip_opt_out`), the keyterm case in `stt/conformance.test.ts` and Deepgram's in `stt/testing/conformanceVendors.ts`, `main/stt/fake/FakeSpeechToText.ts`, `main/api/ApiClient.ts` (token type), the fake-settings literal and the `keyterms` line of `resolveStt` in `CaptureService.ts`, one line of the README's vendor checklist, their tests |
| M3-T10 | M | `bench/core/*` (with tests) |
| M4-S1 | M | `renderer/src/main.tsx`, `App.tsx`, `renderer/src/app/*`, placeholder `meeting/MeetingPage.tsx` and `app/RecentMeetings.tsx` (M4-S4 owns them afterwards), `app/slots/{m2-capture-status,m2-setup,m2-capture-details,m3-transcript,m4-notes,m5-calendar}.ts` (empty; each owned by its mount task), `main/navigation.ts`, `main/appMenu.ts`, `shared/ipc/app.ts` with its bridge and fake, `[slot M4-S1]`. Merges after M4-S2 (it adds `useTheme()` in `AppLayout`) |
| M4-S2 | M | `renderer/src/theme/*`, `renderer/src/styles.css`, `shared/preferences.ts`, `main/preferences/*`, `shared/ipc/prefs.ts` with its bridge and fake, `[slot M4-S2]` |
| M4-S3 | S | `preview/{index.html,main.tsx,control.ts,scenarios.ts,fixtures/*}`, `vite.preview.config.ts`, `qa/README.md`, `qa/driver.ts` (playwright-core with system Chrome, port 0, forced theme, screenshot helper; the one QA driver for every task) |
| M4-T1 | S | `db/models_notes.py`, `0003_notes.py`, `tests/test_notes_schema.py`, the contract's Database line |
| M4-T2 | M | `services/notes_model*.py`, `config_notes.py`, `tests/test_notes_model_*.py`, `tests/test_notes_config.py`, `.env.example` (Notes section), CLAUDE.md rule 4 wording |
| M4-T3 | S | `note_templates/*`, `schemas/note_templates.py`, `routers/note_templates.py`, `tests/test_note_templates.py`, the contract's templates section |
| M4-T13 | S | `shared/notes.ts` (with test), `shared/ipc/{notes,chat}.ts` with their bridges and fakes |
| M5-T1 | M | `config_calendar.py`, `db/models_calendar.py`, the `Meeting` columns in `db/models.py`, `0004_calendar.py`, `.env.example` (Calendar section), `docker-compose.yml`, `tests/test_calendar_schema.py`, `tests/test_calendar_config.py` |
| M5-T2 | M | `services/calendar/{provider,google,fake,normalize,video_links}.py`, `tests/fixtures/calendar/`, their tests, the ruff `banned-api` block in `apps/api/pyproject.toml` |
| M5-T7 | M | `main/calendar/CalendarSync.ts`, `main/calendar/SqliteCalendarCache.ts` (with tests) |

**Wave 2**

| Task | Size | Owns |
| --- | --- | --- |
| M2-T3b | S | `upload/TranscriptUploader.ts` (with test), the sync statements in `store/SqliteTranscriptStore.ts` and `store/InMemoryTranscriptStore.ts` |
| M2-T4 | M | `capture/CaptureService.ts` (adds a status-contributor seam, so warnings, echo and backup add status without editing it; session event listeners; a resume start that takes the saved `stt_usage` row, its open allowance starting afresh; an optional injected `SttOpenBudget`; keeps every landed cost guard and its tests), `capture/SttOpenBudget.ts` (a minute-only acquire for M2-T16's re-run and M3-T20's gate reopens; the doc comment names every allowed caller), `capture/AudioFanout.ts`, `capture/createCaptureRuntime.ts` (builds the one budget and passes it to `CaptureService` and the T16 slot; slots for T6, T10, T11, T14b, T15, T16, T17a, T17b, T18, T19 and M3-T19b), `main/ipc.ts`, the `[slot M2-T4 …]` blocks, architecture rule 9's wording in `CLAUDE.md` (every open acquires first, right before `openStream`; the re-run and the bench are named callers) |
| M2-T7b | S | `native/roger-audio/Probe.swift`, the route-switch case in `SelfTest.swift` |
| M2-T8 | M | `native/roger-audio/{Monitor,Route,ParentWatch}.swift`, `main/native/monitorRelaunch.mac.test.ts` |
| M2-T9 | S | `electron-builder.yml`, `scripts/install-mac.sh`, `main/native/helperPath.ts` (with test) |
| M3-T3 | S | `routers/stt.py`, the `keyterms` field in `schemas/stt.py`, the keyterm surcharge in `stt_vendors.py`, the keyterm tests in `tests/test_stt_token.py`, the contract's token section |
| M3-T5 | M | `main/stt/assemblyai/*` (extends the landed protocol: Pro model, keyterms, keyterm rejection, model warning, wire fixtures), AssemblyAI's keyterm entry in `stt/testing/conformanceVendors.ts`, the wire tap in `stt/core/{WebSocketSpeechToText,SttConnection}.ts` with its conformance case, `stt/streamSettings.ts` (comment and one test case) |
| M3-T7 | M | `renderer/src/transcript/{liveTranscript.ts,LiveTranscript.tsx,useLiveTranscript.ts,transcript.css}` (with tests) |
| M3-T8 | M | `shared/vocabulary.ts`, `shared/ipc/vocabulary.ts` with its bridge and fake, `main/vocabulary/vocabularyIpc.ts` (validation included), `main/api/vocabularyClient.ts`, `renderer/src/settings/*`, `[slot M3-T8]`, their tests |
| M3-T11 | M | `bench/{cli.ts,vite.config.ts,canary.ts}`, `bench/run/*` (adapters from the registry, opens through a bench `SttOpenBudget`), `bench/report/*` (cost from each token's price; no price table of its own) (with tests) |
| M3-T12 | M | `bench/dataset/*` (with tests) |
| M4-S4 | M | `renderer/src/meeting/*`, `app/RecentMeetings.tsx`, `shared/meetings.ts`, `shared/ipc/meetings.ts` with its bridge and fake; it seeds the M1 `StatusPanel` and `TranscriptView` into `slots/m2-capture-status.ts` and `slots/m3-transcript.ts` |
| M4-T6 | M | `services/notes.py`, `schemas/notes.py`, `routers/notes.py`, `tests/test_notes_api.py`, the contract's Notes section |
| M4-T7 | M | `services/llm_runs.py` (registry, `open_llm_runtime`, getters), `tests/test_llm_runs.py` |
| M4-T14 | M | `main/notes/{NotesStore,SqliteNotesStore,NotesSync}.ts`, `main/api/notesClient.ts` (with tests) |
| M4-T15 | M | `main/api/{sse,streamRequest}.ts`, `main/notes/LlmStreams.ts` (with tests) |
| M4-T17 | M | `renderer/src/notes/{NoteEditor.tsx,citationNode.ts,CitationChip.tsx,useNoteDocument.ts,debouncedSaver.ts,saveStatus.ts,ConflictBanner.tsx,notes.css}` (with tests) |
| M5-T3 | M | `services/calendar/{connections,events,runtime}.py`, `routers/calendar.py`, `schemas/calendar.py`, `db/engine.py` (`hide_parameters`), `tests/test_calendar_api.py`, the contract's Calendar section, the `apps/api/README.md` pointer |
| M5-T4 | S | the calendar parts of `schemas/meetings.py`, `services/meetings.py` and `routers/meetings.py`, `tests/test_meetings_calendar.py`, the contract's meetings section |
| M5-T9a | M | `main/calendar/{ReminderScheduler,PromptLog}.ts` (with tests), `scripts/calendar-streak.sql` |

**Wave 3**

| Task | Size | Owns |
| --- | --- | --- |
| M2-T5 | M | `capture/AudioTimeline.ts`, `capture/CaptureSession.ts` (with tests) |
| M2-T10 | M | `main/native/HelperProcess.ts`, `main/audio/system/*`, `test/fixtures/fake-roger-audio.mjs`, the T10 runtime slot |
| M2-T11 | M | `capture/SignalMonitor.ts`, `capture/warnings.ts`, `notify/Notifier.ts`, the T11 runtime slot. (Mac: input volume 0 and a revoked mic) |
| M2-T12 | M | `renderer/src/audio/*`, `renderer/src/state/useCapture.ts`, `main/window.ts`, `main/lifecycle.ts` (a renderer crash or reload no longer stops the recording), `capture/stopReasons.ts` (drops `page-reloaded`) |
| M3-T13 | S | CLAUDE.md commands and benchmark lines, `docs/research/stt-benchmark.md`, `.env.example` (Benchmark section) |
| M3-T14 | S | Optional (OD-10). `services/stt_tokens.py` (one class), `stt_vendors.py` (one vendor entry and its preset), `domain.py` (`soniox`), `config.py` (the key and its case), `.env.example` (the key line), the Soniox lines in `apps/api/README.md`, `tests/test_stt_token_soniox.py`, the contract's provider line |
| M3-T19a | M | `db/models_stt_usage.py`, `0005_stt_usage.py`, `services/stt_usage.py`, `schemas/stt_usage.py` (`stop_reason` bounded free text, never an enum: M1-era rows say `page-reloaded`, M2-T17b adds `call-ended` later), `routers/stt_usage.py`, `tests/test_stt_usage.py`, the contract's STT usage section and its Database line |
| M4-S4b | S | `store/{TranscriptStore,SqliteTranscriptStore,InMemoryTranscriptStore}.ts` (adds `listMeetings` and `listSegments`), `main/meetings/meetings-ipc.ts` (with test), `[slot M4-S4b]` |
| M4-T8 | M | `services/notes_generation.py`, `schemas/notes_runs.py`, `routers/notes_runs.py`, the fixture (owned by T8 from here on), its tests, the contract's runs and SSE section |
| M4-T10 | M | `services/chat.py`, `services/chat_prompt.py`, `schemas/chat.py`, `routers/chat.py`, its tests, the contract's Chat section |
| M4-T11 | S | `mcp_server.py` (`get_notes`), `tests/test_mcp_notes.py`, the contract's MCP section |
| M4-T21b | S | `transcriptNavigator.ts` behaviour and `transcriptNavigator.css` |
| M4-T22 | S | `upload/TranscriptUploader.ts` (`hasNotes`, the pending rule, `markMeetingMissing`), `capture/CaptureService.ts` (`hasNotes` at both delete sites), their tests |
| M4-T23 | M | `main/notes/NotesGenerator.ts`, `shared/suggestTemplate.ts` (with tests) |

**Wave 4**

| Task | Size | Owns |
| --- | --- | --- |
| M2-T6 | M | Deltas on the landed reopen, no wrapper: ping liveness in `stt/core/SttConnection.ts` with its conformance cases and the pong control in `stt/testing/fakeVendorServer.ts`, `stt/networkStatus.ts` (with test), the T6 runtime slot, and in `capture/CaptureSession.ts` `suspendStreams`/`resumeStreams`, the `offline` state, gap rows, capture events and the watermark. Merges before M3-T6b |
| M2-T13 | M | `e2e/{harness.ts,capture.e2e.ts}`, `main/e2eMode.ts` (with test), `[slot M2-T13]` |
| M2-T15 | M | `main/backup/*` (with tests, `AudioCompressor.mac.test.ts` included), the T15 runtime slot |
| M3-T6b | S | `capture/CaptureSession.ts` (one meter call per event and the `stt latency` line), its test. Merges after M2-T6 and rebases on it |
| M4-T9 | M | `services/notes_long.py`, the budget switch in `notes_generation.py` |
| M4-T12 | M | the `roger_api/evals/` package, `apps/api/evals/notes/cases/synthetic_standup.json`, `tests/test_notes_eval.py` |
| M4-T16 | M | `main/notes/{notes-ipc,notes-ipc-validation,notesQuitGuard}.ts` (with tests), `[slot M4-T16 …]` (three slots) |
| M5-T5 | M | `shared/capture.ts` (`StartSource`, `StartCaptureRequest`, `title`), `shared/ipc/capture.ts` with its bridge and fake, `main/ipc.ts`, `main/ipc-validation.ts`, `capture/CaptureService.ts` (`start(request)`, the enricher port, `requestStart` and `takePendingStart`), `roger.sqlite` migration 5 and `findMeetingIdsByEventIds`, `upload/TranscriptUploader.ts` (the create payload), `ApiClient.createMeeting`, `renderer/src/state/useCapture.ts` |

**Wave 5**

| Task | Size | Owns |
| --- | --- | --- |
| M2-T14b | M | `capture/echo/*` except `EchoFilter.ts` (with tests), the T14b runtime slot (including T3b's `beforeFirstTick`) |
| M2-T18 | S | `power/PowerCoordinator.ts` (with test), the T18 runtime slot, the `suspend` handling in `main/lifecycle.ts` (a sleep no longer stops the recording unless it lasts `noSpeechStopMs`) |
| M2-T19 | M | `main/setup/*`, `renderer/src/components/setup/*`, `e2e/setup.shots.e2e.ts`, `app/slots/m2-setup.ts`, the T19 runtime slot |
| M2-T20a | S | `renderer/src/components/capture/{WarningBanner,StreamStatus,LevelMeter,Notices}.tsx`, `e2e/capture-status.shots.e2e.ts`, `app/slots/m2-capture-status.ts`, the stream wording in `renderer/src/format.ts` (keeps the meter line and the stop notice) |
| M3-T4b | S | `capture/CaptureSession.ts` (a connect rejected for its keyterms reopens once without them, through `SttOpenBudget`), `capture/CaptureService.ts` (the `keyterms_rejected` capture warning), their tests |
| M3-T9 | S | `app/slots/m3-transcript.ts` (`LiveTranscript` and `VocabularySettings`), `renderer/src/state/useCapture.ts` (drops the segment and interim state), deletes `components/TranscriptView.tsx` |
| M3-T15 | M | Optional (OD-10). `main/stt/soniox/*`, one line in `stt/registry.ts`, one entry in `stt/testing/conformanceVendors.ts`, the opening-messages hook in `stt/core/{SttProtocol,SttConnection}.ts` if Soniox needs it, the Soniox note and step 7 of the vendor checklist in `apps/desktop/README.md`, the `soniox` line of `AWAITING_A_DESKTOP_ADAPTER` in `apps/api/tests/test_stt_providers.py` (deleted) |
| M3-T19b | M | `upload/SttUsageUploader.ts` (a `422` is a rejected row, marked and never retried until a later save), `api/sttUsageClient.ts`, local migration 6 and the usage sync statements in `store/*`, the M3-T19b runtime slot (with tests) |
| M4-T18 | M | `renderer/src/notes/{AiNotesPanel,TemplatePicker,NotesSettings}.tsx`, `aiNotesStream.ts`, `aiNotesActions.ts` (with tests) |
| M4-T19 | M | `renderer/src/chat/*` (with tests) |
| M5-T6 | M | `main/calendar/{oauthLoopback,CalendarAccount,calendarIpc}.ts`, `main/api/calendarClient.ts`, `shared/ipc/calendar.ts` with its bridge and fake (with tests) |
| M5-T9b | M | `main/prompt/{PromptService,promptIpc}.ts`, `main/calendar/consentNotice.ts`, `shared/ipc/prompt.ts` (with tests) |

**Wave 6**

| Task | Size | Owns |
| --- | --- | --- |
| M2-T16 | M | `main/rerun/*` (with tests), the T16 runtime slot (it opens through the budget M2-T4 injects there, with the minute-only acquire; no edit to `CaptureService.ts` or `SttOpenBudget.ts`) |
| M2-T17a | S | `detect/{MeetingAppMonitor,callApps}.ts` (with test), the T17a runtime slot |
| M4-T20 | S | `app/slots/m4-notes.ts`, the M4 QA script and gallery, the two `fromApi` marks in M4-T13's `preview/fakes/notes.ts` (section 10) |
| M5-T9c | M | `main/calendar/createCalendarRuntime.ts`, the enricher, `calendarFlow.test.ts`, `[slot M5-T9c]` |
| M5-T10 | M | `main/prompt/{PromptWindow,promptBounds}.ts`, `preload/prompt.ts`, `renderer/prompt.html`, `renderer/src/prompt/*`, `electron.vite.config.ts`, `main/page-policy.ts` |
| M5-T11 | M | `main/app/*` (`windowLifecycle.ts`, not `lifecycle.ts`), `shared/ipc/loginItem.ts` with its bridge and fake, `build/tray*.png`, `main/window.ts` (close hides unless `lifecycle.quitting`), `main/lifecycle.ts` (`watchWindow` stops only on a real close, never on a hide; a public `quitting` getter, so the close a quit sends is not turned into a hide that cancels it; test: Cmd+Q with the window open quits), `[slot M5-T11 …]` (two slots) |
| M3-T20 | M | Silence-gated streaming: `capture/SilenceGate.ts` (with test), `capture/CaptureSession.ts` (pause cause per source; token prefetch; hold bound pre-roll plus reopen buffer; gate reopens through the minute-only acquire and their own count; gap start at the speech onset; gated sources stay gated across `resumeStreams()`; the reopened-session latency figures), `capture/CaptureService.ts` (meter, token expiry in the credentials), `main/costGuards.ts` (three settings and the pre-roll check), `shared/capture.ts` (optional `SttMeter.gatedMs`, `estimatedSavedUsd`, optional `SttMeterStatus.silenceGate`), `renderer/src/format.ts` (savings, gate spent, the gated `paused` wording), the gate rows of the README's "Cost guards" table and their `.env.example` lines, the gate in rule 9 of `CLAUDE.md`, `bench/run/replay.ts` (`--gate`) and the `--gate` columns of `bench/report/report.ts` (with tests) |

**Wave 7**

| Task | Size | Owns |
| --- | --- | --- |
| M2-T17b | M | `detect/{CallDetector,CallOffer}.ts` (with test), the T17b runtime slot, `capture/stopReasons.ts` (`call-ended`) |
| M2-T23 | M | `recovery/CrashRecovery.ts` (with test), `[slot M2-T23]` |
| M5-T12 | M | `renderer/src/calendar/*` (with tests) |

**Wave 8**

| Task | Size | Owns |
| --- | --- | --- |
| M2-T20b | S | `components/capture/{EchoLines,AudioKept,RerunProgress,CaptureReport,ResumedNotice}.tsx`, `e2e/capture-details.shots.e2e.ts`, `app/slots/m2-capture-details.ts` |
| M5-T13 | S | `app/slots/m5-calendar.ts`, the M5 QA script and gallery |

**Wave 9**

| Task | Size | Owns |
| --- | --- | --- |
| M2-T21 | S | CLAUDE.md repo map and commands, `apps/desktop/README.md`, "Adopted in M2" in `docs/research/reference-repos.md` |

**Not code:**

- M2-T22: the 10-call exit check.
- M3-T16: build the test set.
- M3-T17: the bake-off and the vendor choice.
- M4: the exit check on 5 calls.
- M5: the 20-call streak.

These are in section 6.

**Critical path:** P2-F1 → M2-T2 → M2-T4 → M2-T5 → M2-T6 → M2-T14b → M2-T16 → M2-T17a →
M2-T23 and M2-T17b → M2-T20b → M2-T21 (waves 0 to 9). M3 is code complete after wave 6 (T20, the
silence gate), M4 after wave 6 and M5 after wave 8. **If the day runs short, keep this order:**

1. Waves 0 to 5. They include M2's exit-check core set (T1 to T15, T3b, T7b, T20a) and all of M3
   but T20 (the usage upload and the pacing included).
2. M3-T20 (the owner's cost ask) and M4 to wave 6.
3. M5 to wave 8.
4. M2-T16, T17b, T23 and T20b. The M2 plan already lets these land after the first exit-check
   calls; the Wi-Fi cut call waits for T16 (AssemblyAI takes no replay, so the window comes back
   from the backup).

### 3.1 Files more than one task edits, and in what order

Every other file has exactly one writer in Phase 2.

| File | Who edits it, in merge order | How collisions are avoided |
| --- | --- | --- |
| `docs/api-contract.md` | P2-F2 (skeleton, error rows) → wave 1: M3-T1 (token `provider` and presets), M3-T2, M4-T1, M4-T3, M5-T1 → wave 2: M3-T3, M4-T6, M5-T3, M5-T4 → wave 3: M4-T8, M4-T10, M4-T11, M3-T14, M3-T19a (STT usage) | Each task edits only its own section, which P2-F2 created. The token section has a different writer in each wave (M3-T1, then M3-T3, then M3-T14). Contract and code change in the same commit (house rule 8). M3-T2 also wrote the route-heading rule under `## Endpoints`, which `test_http_plumbing.py` reads. |
| `apps/api/tests/test_http_plumbing.py` (`test_openapi_documents_the_contract_routes`) | M1 (landed) → M3-T2 (wave 1: the route check reads the contract) | No later task edits it. The test compares the served OpenAPI routes with the contract's route headings (``### `GET /v1/...` ``, or `####` under the feature's own heading), so a task adds a route by writing that heading in its own contract section. A route without a heading, or a heading without a route, fails the test. A branch cut before M3-T2 merged that still adds its path to the old path list takes M3-T2's version of the file when it merges. |
| `apps/api/tests/test_stt_providers.py` | M3-T1 (1) → M3-T15 (5, deletes `soniox` from `AWAITING_A_DESKTOP_ADAPTER` in the commit that adds it to `registry.ts`) | M3-T14 (3) needs no edit: the set lets the API mint Soniox tokens before the desktop has the adapter. |
| `src/shared/ipc.ts` and `src/preload/index.ts` | P2-F1 only | Feature tasks own `shared/ipc/<feature>.ts`, `preload/bridges/<feature>.ts` and `preview/fakes/<feature>.ts`. `capture.ts` and its bridge: M2-T2 (wave 1), then M5-T5 (wave 4). The barrel keeps exporting `PCM_SAMPLE_RATE` and `PCM_ENCODING`. A task that adds a member to its feature API stubs it in every test double typed as that whole API, in the same commit, even in another task's file (M2-T2 added five to `AudioCaptureController.test.ts`, M2-T12's). |
| `src/shared/capture.ts` | M2-T2 (1, `offline` and M2's fields) → M5-T5 (4, `StartSource`, `title`) → M3-T20 (6, `SttMeter.gatedMs`, `estimatedSavedUsd`) | One writer per wave; every writer keeps the landed fields (`paused`, `retrying`, `streamMessages`, `meter`, `notice`) |
| `src/main/index.ts` | P2-F1 (slots) → M4-S2, M4-S1 (wave 1) → M2-T4, M3-T8 (2) → M4-S4b (3) → M2-T13, M4-T16 (4) → M5-T9c, M5-T11 (6) → M2-T23 (7) | Named slots (section 1). Inside a wave the slots differ, so the slot bodies merge cleanly; the import lines at the top are outside every slot and do conflict (M4-S1 and M4-S2 both edited the `electron` import): resolve as the union. Nobody edits outside their slot and its imports. The cost-guard wiring and the `RecordingLifecycle` stay inside `[slot M2-T4 runtime]`. |
| `src/main/lifecycle.ts` (landed `RecordingLifecycle`, with `lifecycle.test.ts`) | P2-F1 (0, quit hooks) → M2-T12 (3, a renderer crash or reload no longer stops) → M2-T18 (5, `suspend` moves to `PowerCoordinator`) → M5-T11 (6, a hide never stops; the public `quitting` getter `window.ts` reads) | One writer per wave; each changes one decision and keeps every other G4 stop and its test |
| `src/main/capture/stopReasons.ts` | M2-T12 (3, drops `page-reloaded`) → M2-T17b (7, adds `call-ended`) | - |
| `src/main/capture/createCaptureRuntime.ts` | M2-T4 (slots) → T10, T11 (3) → T6, T15 (4) → T14b, T18, T19, M3-T19b (5) → T16, T17a (6) → T17b (7) | Runtime slots made by M2-T4, used the same way as the `index.ts` slots |
| `src/main/capture/CaptureService.ts` | M3-T4a (wave 1, the fake literal and `keyterms` in `resolveStt`) → M2-T4 (2, the injected budget) → M4-T22 (3) → M5-T5 (4) → M3-T4b (5) → M3-T20 (6, the meter, the token's expiry) | One writer per wave. Every writer keeps the landed cost guards (G1 to G7) and their tests green. M2-T16 reaches the budget through its runtime slot and never edits this file. |
| `src/main/capture/CaptureSession.ts` | M3-T18 (0, the `hold()` doc and the flush comment only) → M2-T5 (3) → M2-T6, then M3-T6b (4, in that merge order) → M3-T4b (5) → M3-T20 (6) | One writer per wave, except wave 4, where M3-T6b (one call per event, the log line) rebases on M2-T6 |
| `src/main/capture/SttOpenBudget.ts` (landed, with its test) | M2-T4 (2, the minute-only acquire and the doc comment naming every allowed caller) | Only M2-T4 edits it. M2-T16 and M3-T20 (both wave 6) call the minute-only acquire; the bench builds its own instance. |
| `src/main/upload/TranscriptUploader.ts` | M2-T3b (2) → M4-T22 (3) → M5-T5 (4) | One writer per wave. M3-T19b's usage uploader is its own file. |
| `src/main/store/*` | M2-T3 (1, migration 4) → M2-T3b (2) → M4-S4b (3) → M5-T5 (4, migration 5) → M3-T19b (5, migration 6) | One writer per wave; migration 3 (`stt_usage`) is landed and nobody edits it |
| `src/main/api/ApiClient.ts` | P2-F1 (0) → M3-T4a (1) → M5-T5 (4) | Feature clients live in their own files |
| `src/main/stt/core/{SttProtocol,SttConnection,WebSocketSpeechToText}.ts`, `src/main/stt/conformance.test.ts`, `src/main/stt/testing/*` | M3-T18 (0, pacing) → M3-T4a (1, keyterm rejection) → M3-T5 (2, wire tap) → M2-T6 (4, ping liveness) → M3-T15 (5, opening messages) | One writer per wave. Each adds a field the core applies and a conformance case; no adapter opens, times, retries or closes a socket (house rule 9) |
| `src/main/stt/registry.ts` | M3-T15 (5, one line) | - |
| `bench/run/replay.ts`, `bench/report/report.ts` | M3-T11 (2) → M3-T20 (6, `--gate` and its report columns) | - |
| `src/main/stt/deepgram/DeepgramSpeechToText.ts` | M3-T18 (0, `audioPacing`) → M3-T4a (1) | - |
| `src/main/stt/assemblyai/*` | M3-T18 (0, `AudioFrameSizer` moves to `stt/core/`, `audioPacing`) → M3-T5 (2) | - |
| `src/main/costGuards.ts` | M3-T18 (0, the `sttReopenBufferMs` `why` only) → M3-T20 (6) | `costGuards.test.ts` checks every guard against the README table and `.env.example`, so the three change together |
| `src/main/ipc.ts`, `src/main/ipc-validation.ts` | P2-F1 (0, trust helpers) → M2-T2 (`ipc-validation.ts`, 1) → M2-T4 (`ipc.ts`, 2) → M5-T5 (4) | Other features register in their own modules |
| `src/renderer/src/state/useCapture.ts` | M2-T12 (3) → M5-T5 (4) → M3-T9 (5) | Each keeps the landed `followMain` call and the status re-read on focus |
| `src/renderer/src/format.ts` (with `format.test.ts`) | M2-T2 (1, the `offline` case of `describeStream`) → M2-T20a (5, stream wording) → M3-T20 (6, savings on the meter line, the gate spent, `paused` while gated) | `describeStream` has no default case, so whoever adds an `SttStreamState` adds its case in the same commit |
| `src/main/window.ts` | M2-T12 (3) → M5-T11 (6) | - |
| `src/renderer/src/styles.css`, `theme/tokens.css` | M4-S2 only. Later tasks never write colours; they use tokens. A task that needs a new token adds it at the end of all three blocks of `tokens.css` (light, system dark, forced dark; `tokens.test.ts` checks they agree) and never renames one. | S2 shipped the union the plans need: `--bg`, `--panel`, `--ink`, `--muted`, `--line`, `--accent`, `--danger`, `--warn`, `--ok`, `--danger-bg`, `--warn-bg`, `--ok-bg`, `--interim-ink`, `--hidden-ink`, `--cited-bg`, `--recording`, `--focus-ring`, `--sidebar-bg`, `--chip-bg`, `--conflict-bg`, plus `--on-accent` (text on a fill), `--accent-ink` and `--danger-ink`. `--accent` and `--danger` are fills; text in those hues reads the `-ink` tokens (in dark, one value cannot be both; `tokens.test.ts` fails a `color:` read from a fill). It keeps the landed `.notice` rule (the stop notice). |
| `src/renderer/src/app/slots.ts` | M4-S1 only | Each mount task owns its own `app/slots/<task>.ts` |
| `apps/desktop/preview/fakes/notes.ts` | M4-T13 (1) → M4-T20 (6, wraps the template-list and run answers in `fromApi`) | - |
| `app.py` | P2-F2 → M3-T1 (the `api_started` fields only) | Router includes and lifespan hooks are already in place |
| `config.py` | P2-F2 (mixins) → M3-T1 (1) → M3-T14 (3) | Notes and calendar settings are in their own mixin files |
| `stt_vendors.py` | M3-T1 (1, presets; the issuer looked up by the resolved vendor) → M3-T3 (2, keyterm surcharge) → M3-T14 (3, Soniox) | One writer per wave |
| `schemas/stt.py`, `tests/test_stt_token.py` | M3-T1 (1, `from_settings` from the preset; the three `stt_model="nova-2"` cases) → M3-T3 (2, `keyterms`; the keyterm cases) | One writer per wave |
| `domain.py` | P2-F2 (0) → M3-T14 (3, `soniox` in `SttProvider`) | - |
| `db/models.py` | P2-F2 (imports) → M5-T1 (the `Meeting` columns) | New tables live in per-domain modules |
| `.env.example` | P2-F2 (sections) → M3-T1, M4-T2, M5-T1 (1) → M3-T13 (Benchmark), M3-T14 (the Soniox key) (3) → M3-T20 (6, its cost-guard lines) | Each task writes in its own section; the landed cost-guard block keeps every guard |
| `apps/api/README.md` | M3-T1 (1, STT settings and presets; `STT_MODEL` retired), M3-T2 (1, one sentence of "Migrations": the stubs began empty) → M5-T3 (2, the calendar pointer) → M3-T14 (3, Soniox) | Each its own section |
| `apps/desktop/README.md` | M3-T18 (0) and M3-T4a (1), one line each in "Add a speech-to-text vendor" (declare `audioPacing`; map keyterms and `keytermsRejected`), and M3-T18's "Reopen buffer" row of "Cost guards" (held audio is paced, not sent at once) → M3-T15 (5, the Soniox vendor note, and step 7 of "Add a speech-to-text vendor": `STT_PRESETS`, section 10) → M3-T20 (6, the gate rows of "Cost guards") → M2-T21 (9, helper, permissions, audio folder, M2's sleep and crash changes) | Each its own section |
| `apps/desktop/package.json`, `pnpm-lock.yaml` | P2-F3 only | A task that truly needs a new package asks the controller, which makes a separate F3-style commit |
| root `Makefile` | P2-F3 → M2-T7 (the Darwin `check` lines) | - |
| `CLAUDE.md` | M4-T2 (rule 4, wave 1) → M2-T4 (rule 9's open-budget sentence, wave 2) → M3-T13 (commands, wave 3) → M3-T20 (rule 9's "no audio, no session" sentence gains the gate, wave 6) → M2-T21 (repo map, commands, wave 9). The controller appends failure-log lines. | Tasks put proposed failure-log lines in their hand-off note. The controller appends them once per wave. Architecture rule 9 (the STT core and the open budget) is landed; M2-T4 and M3-T20 reword it to cover the re-run, the bench and the gate, and no task loosens it: every open still acquires first, right before `openStream`. |
| `apps/desktop/src/renderer/src/App.tsx` | M4-S1 only | No milestone mounts in M1's window any more: the shell lands in waves 1 and 2, before any UI that would mount. S1 keeps the landed stop notice. |

## 4. Test databases per worktree

- Every task runs `make check TEST_DB=roger_test_<task>`. The name is the task id in lower case,
  with `-` turned into `_`: `roger_test_p2_f2`, `roger_test_m3_t2`, `roger_test_m4_t8`,
  `roger_test_m5_t3`, `roger_test_m2_t14b`. Desktop-only tasks too, because `make check` runs the
  API tests.
- P2-F2's conftest drops and recreates the test database on every run (as built). It refuses any
  name that does not start with `roger_test`. Never `make migrate` the dev database `roger` from
  a Phase 2 branch while revisions 0002-0005 are still empty stubs (CLAUDE.md failure log). One Postgres (`make dev-db`) serves every worktree.
- The controller's integration runs use `roger_test_integration`. The dev database `roger` is only
  for `make dev-api` and the exit checks.
- Never set `TEST_DATABASE_URL` in a shared `.env`. Worktrees have no `.env` (it is untracked), so
  the Make variable is the only source.
- **Other things that must not be shared:**
  - Each worktree runs `make setup` after branching (its own `.venv` and `node_modules`).
  - Electron e2e tasks fetch the binary once with `node node_modules/electron/install.js` (see the
    CLAUDE.md failure log).
  - QA scripts start the preview server on port 0 and read the port that was bound.
  - Scratchpad files carry the task id in their name.
  - The controller alone runs the integration suite and `make install-desktop`.

## 5. Merge order and the integration gate

- **Branches.** `phase-2` is the integration branch. A task branches `p2/<task-id>` from the tip
  of `phase-2` when it is dispatched. A worktree branched before its wave's predecessors merged
  is rebased before review.
- **Order inside a wave:** foundations and contract owners first (P2-F2, P2-F3, P2-F1; M4-S2
  before M4-S1). Then the slot and section editors in the order of the table in section 3.1. Then
  everything else, as tasks finish.
- **Per merge (the controller, in the integration worktree):**
  1. Review: an independent reviewer agent reads the diff against the task's plan entry and its
     owned-file list. A file outside the list is sent back.
  2. `git merge --no-ff p2/<task>`. Then `make setup` if the lockfile changed (P2-F3 only).
  3. Gate script, `set -e`, no pipes (see the global failure log on piped gates):
     `make check TEST_DB=roger_test_integration` and `pnpm --filter @roger/desktop build`. On the
     Mac, from M2-T7 on, `make check` also runs `roger-audio selftest` and `pnpm test:mac`.
  4. Each new commit carries this session's `Co-Authored-By` and `Claude-Session` trailers.
     Check with `git log --format=%B`.
  5. An API change without a `docs/api-contract.md` change in the same commit is sent back.
- **Per wave (on the Mac):**
  1. `make install-desktop`. From M2-T9 on, the install itself verifies both signatures and the
     helper.
  2. `open --stderr <log> /Applications/Roger.app`. The log shows `roger started`, and from M2-T10
     on, `systemCapture: tap`.
  3. Rahul reviews the wave's diff on `phase-2`.
- **Phase gate (`phase-2` → `main`):**
  1. Every task in waves 0 to 9 has merged.
  2. On the Mac: `make check` green (selftest and `test:mac` included), `make e2e-desktop`
     green, the opt-in `make test-native-route` run once.
  3. The QA galleries are published (M2-T19, M2-T20a, M2-T20b, M3-T9, M4-T20, M5-T13).
  4. Rahul merges. That merge is human-only.

## 6. What finishes today, and what needs real calls or keys

"Code complete" means every code task of the milestone has merged with a green gate. Done-when is
the roadmap line. A milestone closes only when it is met.

| Milestone | Done-when (roadmap) | Can finish today | Needs real calls, keys or days |
| --- | --- | --- | --- |
| M0 | One command runs tests and lint for both apps | Done (2026-10-05) | - |
| M1 | After a real 30-minute Meet call, Claude quotes a line from it through MCP | `m1-assemblyai` is on `phase-2` (a3be3ee); M2-T1's Mac check | AssemblyAI key and its training opt-out; the 30-minute call (one person, today if a call happens) |
| M2 | 10 real calls in a row with no lost or doubled text; cutting the audio mid-call warns within 10 s | Code complete (waves 0 to 9). Mac checks: T0 spike, T1 anchors, T11 input volume 0 and revoked mic, `make test-native-route` | 10 real calls (2 on speakers, AirPods mid-call, lid closed, `kill -9`, 2 from the offer), 3 timed cuts filmed on a phone, a 2-hour soak. About 2 to 4 working days. |
| M3 | The chosen vendor's error rate is written down; swapping vendor is one config change | Code complete after wave 6 (T20, the silence gate); the canary against the fake provider | AssemblyAI and Deepgram keys and opt-outs. About 10 consented internal calls recorded through M2's backup and clipped within 7 days, then about 90 minutes of hand-fixing. The bake-off runs (C, A, D, B only if worth it, then E and the gate run F), then a 10-minute real call with its cost per meeting hour, and two vendor flips. |
| M4 | Notes from 5 real calls each need under 2 minutes of fixing | Code complete after wave 6, with the eval on the fake model in `make check` | `OPENROUTER_API_KEY`. M2's call audio verified across a relaunch, M3's vendor chosen, 5 real calls with a stopwatch, `make eval-notes` on exported calls |
| M5 | 20 calls in a row are started from the notification | Code complete after wave 8, with `calendarFlow.test.ts` on the fake calendar | A Google Cloud project, OAuth client and `CALENDAR_TOKEN_KEY`. The six real-Mac checks, the three real-key checks, and 20 calendar calls (runs alongside Gate 2) |

The order of the real-call work across the following days:

1. The M1 call.
2. M2's calls. They also record the audio for M3's test set: ask for consent on every internal
   call.
3. M3's bake-off. It runs on clips and needs no live call.
4. M4's 5 calls, after the vendor is chosen.
5. M5's streak. It starts once M2-T1, T7, T9, T10 and T19 are in the installed app.

## 7. Owner decisions (one sign-off)

Each plan's decisions, with duplicates removed. "Deviation" means it bends a constraint (C5, C6)
or a done-when line on purpose. A plan's engineering calls are not repeated here.

| Id | Question | Recommendation | Alternative | From |
| --- | --- | --- | --- | --- |
| OD-1 | Land `m1-assemblyai` (owner decision 2026-10-06: AssemblyAI is the M1 vendor) before Phase 2 starts? | **Done 2026-10-06:** merged into `phase-2` (a3be3ee) with the STT core, the registries, the conformance suite and the cost guards. Rahul merges it into `main` when M1 closes. Every M2 and M3 task builds on it (section 9.2). | Close it unmerged and let M3 rebuild it from scratch | this plan |
| OD-2 | Who merges task branches? (House rule: "Agents never merge.") | The controller merges task branches into the `phase-2` integration branch after review and the gate. Rahul reviews each wave. `phase-2` → `main` is Rahul's alone. | Rahul merges every task branch himself (about 75 merges) | this plan |
| OD-3 | Where does call audio come from? | A Swift helper with a Core Audio process tap, with Electron's path kept as the fallback | Stay on Electron's `desktopCapturer` | M2 D1 |
| OD-4 | How is echo removed? | Text-level dedupe in main. Spike T0 decides whether `echoCancellation: 'all'` is also turned on. | Acoustic cancellation only; signal correlation | M2 D2 |
| OD-5 | When is call-audio silence loud? | On screen at 8 s. A notification at 60 s while the mic hears speech, or at 180 s regardless. | Notify at 8 s | M2 D3 |
| OD-6 | Mic dead threshold on Bluetooth (**deviation** from "within 10 s") | 30 s on Bluetooth, 8 s elsewhere. The exit-check cut runs on the built-in mic. | 8 s everywhere | M2 D4 |
| OD-7 | Audio backup format and retention | Per-stream WAV of at most 60 s, turned into 48 kbps AAC by `afconvert`. Kept 7 days (configurable). Gaps not yet re-run keep their audio up to 30 days. Paused below 2 GiB free. Never uploaded. | webm/opus; WAV only; FLAC | M2 D5 |
| OD-8 | New dependencies | `playwright-core` 1.63.0 (dev). It is the one driver for the Electron smoke test and all browser QA (M5-T13 drops puppeteer). TipTap ×5 pinned to 3.31.3. | A hand-written CDP client; raw ProseMirror | M2 D8, M4 new deps |
| OD-9 | `workspace_id` on local SQLite (**deviation** from C5) | A nullable column on M2's three new tables. `meetings`, `segments`, `app_state`, `notes.sqlite` and `calendar.sqlite` wait for M6's backfill. | No column anywhere until M6 | M2 D9, M4 known gaps |
| OD-10 | A third STT vendor? | Yes: Soniox (M3-T14, T15), built last and dropped if the day runs out; one protocol file, one issuer, a line in each registry and one conformance entry | Two vendors (AssemblyAI and Deepgram, plus U3.6 Pro if it is worth running) | M3 D1 |
| OD-11 | Keep a standing test set of colleagues' audio (**deviation** from C6) | Yes, as a signed exception: internal calls only, per-person consent, FileVault, mode 0700, `bench forget`. Linked from the roadmap's audio-policy decision. | Re-clip every 7 days; include client calls | M3 D2 |
| OD-12 | Never train vendors on calls | Deepgram: `mip_opt_out=true` on every request, even at a higher price. AssemblyAI: opted out in its dashboard before any real call, M1's included. | Stay in Deepgram's program for the discount | M3 D3 |
| OD-13 | How is the STT vendor chosen? | The rule fixed in M3 before any scoring: latency and failure gates, then pooled WER, then term recall, then cost | Decide after seeing the numbers | M3 D4 |
| OD-14 | How does the API reach LLMs? | A thin `NotesModel` adapter over `httpx` to OpenRouter. LiteLLM 1.82.7 and 1.82.8 were malicious PyPI releases on 2026-03-24 (LiteLLM's security post; Datadog Security Labs). | LiteLLM pinned to a clean release, after a re-lock | M4 D1 |
| OD-15 | Which model writes notes and answers chat? | **Owner, 2026-10-06:** `xiaomi/mimo-v2.6-pro`, reasoning off, zero-retention routing (Novita, DeepInfra) | `anthropic/claude-sonnet-5.5` if the eval shows MiMo's notes need more fixing | M4 D2 |
| OD-16 | May calls go to providers that keep data? | No: `zdr: true` and `data_collection: deny` on every request | `data_collection: deny` only | M4 D3 |
| OD-17 | What happens to an AI line the transcript does not back? | Drop it if it has no valid citation (listed as removed). Flag it if its numbers or words are not in the cited lines. | Flag all, drop none | M4 D4 |
| OD-18 | How are edits from two places reconciled? | Whole-doc versions with a visible conflict copy. A CRDT is revisited in M10. | Yjs now | M4 D5 |
| OD-19 | Who owns the app shell? | M4-S1 to M4-S4b, in waves 1 to 3. M5's SHELL-0 spec is folded into S1 and S2, and every plan uses these ids. | Two foundation tasks outside the milestones | M4 D6, M5 D4 |
| OD-20 | An AI line backed only by the user's notes | (a) A closing "From your notes" list with no chips | (b) A note chip in place, with stable block ids | M4 D7 |
| OD-21 | Where does the Google refresh token live? | In the API, encrypted with pgcrypto. The cost: `make dev-api` must run, and a stale calendar is loud after 1 h. | Desktop Keychain | M5 D1 |
| OD-22 | Google consent screen audience | **Owner, 2026-10-06:** External, open to any Google account (Testing first, In production after Google verification) | Internal under the linkt.ai org | M5 D2 |
| OD-23 | Notice wording | The default text, on by default, reviewed by Linkt's legal view before Gate 2. Consider naming the 7-day local audio backup (OD-7). | Wait for legal | M5 D3 |
| OD-24 | Who owns the prompt panel and call-detected offers? | M5's `PromptService.offer`. M2-T17b feeds it and builds no card or notification of its own. A click stores `call_detected`, or `notification` when one calendar event matches. | M2 owns it | M5 D5, M2 D6 |
| OD-25 | Crash relaunch | The monitor helper relaunches Roger once per meeting and resumes the same meeting, with a visible Stop | End the meeting at launch | M2 D7 |
| OD-26 | Call detection method | Poll Core Audio process objects every 1 s against an allowlist of call apps. Offer after 5 s (15 s for a browser). Never auto-start. | Window titles; a deny-list; auto-start | M2 D6 |
| OD-27 | Silence-gated streaming on by default? (the owner's cost ask of 2026-10-06) | Yes: a source's session closes after 30 s without speech and reopens on speech with a 1 s pre-roll and a token prefetched while it was closed (M3-T20). The gate has its own cap of 120 reopens per meeting (`sttSilenceReopensPerMeeting`), each also counted in the 4-a-minute window, never in the 30 opens per meeting that Start, stalls and failures use; past the cap the gate is off for that meeting and the status says so. The cost: AssemblyAI takes no audio faster than real time, so a source's words after a silence of 30 s show about 1 to 1.5 s later than usual until that source is quiet again. If bake-off run F shows a cost of more than 1.0 point of pooled WER, or adds more than 2.0 s of p95 word display latency to the words of reopened sessions, the default becomes off | Off by default, on per Mac in `config.json` | M3 D5 |

## 8. Owner and human inputs, by day

- **Today, before wave 0:** sign OD-2 and OD-8 (they gate the foundations). OD-1 is done:
  `m1-assemblyai` merged into `phase-2`.
- **Today, during waves 0 to 2:** sign the rest. Run T0, T1 and T11 on the Mac. Opt AssemblyAI out
  of training.
- **Today, after waves:** check the installed app at the end of each wave, including the meter
  line in the status and the `stt meter at stop` log line after a short Start and Stop.
- **Keys, any time:**
  - `ASSEMBLYAI_API_KEY` (M1, M2's calls, M3) and `DEEPGRAM_API_KEY` (M3's bake-off run A and the
    two-vendor draft only)
  - `OPENROUTER_API_KEY` (M4)
  - The Google Cloud project and Desktop OAuth client, plus `CALENDAR_TOKEN_KEY` (M5, about 10
    minutes; the steps are in the M5 plan)
  - The Deepgram opted-out price, read in its console (M3)
  - Delete `STT_MODEL` from `.env` after M3-T1 merges. The API refuses to start and names it.
- **Following days:** the calls in section 6.

## 9. Changes made to the milestone plans

### 9.1 First pass (with the plans, 2026-10-06)

Made in this change, so each agent reads one consistent story in its own plan. Items marked
"superseded" were changed again in 9.2.

- **All four plans:** "SHELL", "APP-SHELL" and "SHELL-0" now name M4-S1, S2, S4 and S4b. The
  fallback mounts in M1's window are dropped. Each mount task owns its own `app/slots/<task>.ts`.
  Wave and merge-order paragraphs point here.
- **M2:**
  - T2 owns the `capture` and `setup` IPC modules.
  - The echo event is named `transcript:segment-changed`
    (`{meetingId, segmentId, source, change: 'hidden' | 'trimmed' | 'unhidden', reason, echoOf, text}`),
    one event for hide, trim and unhide.
  - T3 owns the backup fixture (it was T15's).
  - T4 makes runtime slots and a status-contributor seam.
  - T6 depends on M3-T4a (`inlineReplay`) and M3-T5 (file order). Superseded: no `inlineReplay`
    (9.2).
  - T7 keeps only the Darwin `check` wiring of the tooling; P2-F3 has the rest. T7 creates stub
    `Probe.swift` and `Monitor.swift`.
  - T14 is split into T14a (pure, wave 0) and T14b.
  - T17b calls `PromptService.offer`, depends on M5-T9b and no longer on M5-T11. The
    `call_detected` gate is confirmed: M5-T1, T4 and T5 carry it.
  - T20b drops `CallCard`.
  - Local migration 3 is T3's and 4 is M5-T5's. Superseded: 4 and 5 (9.2).
- **M3:**
  - Builds on `m1-assemblyai`. T1 adds presets on top of the existing issuer, T5 extends the
    existing adapter, and T18 replaces `AudioFrameSizer`. "Today's vendor" now reads AssemblyAI
    Universal-Streaming. Superseded: T18 keeps `AudioFrameSizer` and paces in the core (9.2).
  - T2 uses `models_vocabulary.py` and the fixed `0002` in the right folder.
  - T4 is split into T4a and T4b, and T6 into T6a and T6b.
  - T7 registers through M4-T21's navigator and no longer owns `CitationNavigator.ts`. It handles
    `transcript:segment-changed`.
  - T8 uses per-feature IPC files and `vocabularyClient.ts`.
  - T9 mounts through `slots/m3-transcript.ts`.
  - T10 and T11 have their configs and scripts done by P2-F3. T11 depends on M2-T14a.
  - T12 uses M2-T3's fixture.
  - The cross-plan edit list is marked applied.
- **M4:**
  - S1 takes the `app:navigate` spec and S2 the `PreferencesStore` spec from M5's SHELL-0.
  - S4 is split into S4 (page, wave 2) and S4b (store reads and IPC, wave 3).
  - T1 uses `models_notes.py` and the fixed `0003`.
  - T2 uses `config_notes.py`.
  - The `app.py`, `errors.py`, `domain.py` and `dependencies.py` edits went to P2-F2.
  - T7's getters live in `llm_runs.py`.
  - T12's Makefile and `.gitignore` edits went to P2-F3.
  - T13 is reduced to types and IPC. Its packages went to P2-F3 and its ApiClient prep to P2-F1.
  - T14 uses `notesClient.ts`.
  - T16's `main/ipc.ts` export went to P2-F1.
  - T21 is written as T21a and T21b.
- **M5:**
  - SHELL-0 is folded into M4-S1 and S2, with paths `main/preferences/*` and
    `shared/ipc/prefs.ts`.
  - T1 uses `0004_calendar` with a fixed down-revision `0003`, `models_calendar.py` and
    `config_calendar.py`.
  - The errors and the lifespan hook went to P2-F2.
  - T3 owns `services/calendar/runtime.py` instead of editing `app.py` and `dependencies.py`.
  - T5 also follows M2-T3 and M4-T22.
  - The IPC modules moved to `shared/ipc/{calendar,prompt,loginItem}.ts`. T6's client goes to
    `calendarClient.ts`.
  - T11 must not override userData under e2e.
  - T12 has no mount in M1's window. T13 uses `slots/m5-calendar.ts` and playwright-core.
  - "The only 409 stays the segment one" is replaced.
  - The controller edits to M2 are marked applied.

### 9.2 After `m1-assemblyai` landed (2026-10-06)

`m1-assemblyai` merged into `phase-2` (a3be3ee) after 9.1, with the STT core, both registries,
the conformance suite and the cost guards (section 0). The plans were edited so no task re-builds
or fights that code. In short: a vendor is one protocol file, one issuer, a line in each registry
and one conformance entry; anything new about how a socket behaves is a field the core applies,
with a conformance case; every open passes `SttOpenBudget`.

- **Local SQLite numbers.** Migration 3 is the landed `stt_usage`. M2-T3 is now migration 4,
  M5-T5 migration 5, and the new M3-T19b migration 6 (section 2; M2 local schema, M5 file order,
  M5-T5).
- **New Alembic revision** `0005_stt_usage.py` (M3-T19a, down `0004`), stubbed by P2-F2 with
  `db/models_stt_usage.py`, `routers/stt_usage.py` and an "STT usage" contract section.
- **New tasks:**
  - **M3-T19a** (M, wave 3, api): STT usage in Postgres and cost per meeting hour: the idempotent
    `PUT /v1/stt-usage/meetings/{id}` and `GET /v1/stt-usage/summary`. Needs P2-F2.
  - **M3-T19b** (M, wave 5, desktop): `SttUsageUploader` from the local `stt_usage` rows, local
    migration 6 (`synced_at`, `gated_ms`), `sttUsageClient.ts`, a runtime slot. Needs T19a, M2-T4,
    M5-T5 (store order).
  - **M3-T20** (M, wave 6, desktop): silence-gated streaming: an energy gate per source
    (`rmsInt16`), a 30 s hang-over, a 2 s pre-roll, reopen through `SttOpenBudget` with a 60 s
    minimum and a reserve of 10 opens, paced by the core, offsets meeting-relative, three settings
    in `costGuards.ts`, savings in the meter. It shares the close-and-reopen path with the landed
    stall pause (stall: no chunks; silence: chunks of near-zero energy). Needs T4b, T6b, T11, T18,
    T19b, M2-T5, M2-T6, M2-T20a, M5-T5 (file order). New owner decision OD-27 (M3 D5): on by
    default unless bake-off run F shows a real cost. Superseded in 9.3: a 1 s pre-roll, a
    prefetched token, its own reopen allowance instead of the reserve, a pause cause per source,
    and run F judged on the lag the gate adds.
- **Rescoped M2 tasks:**
  - **M2-T6** is now "STT liveness, offline and gap records": no `ResilientSttStream`, no wrapper
    in `createSpeechToText.ts`, no replay. It adds ping liveness to `stt/core/SttConnection.ts`
    (with conformance cases), `networkStatus.ts`, and in `CaptureSession.ts` the `offline` and
    `asleep` suspend, gap rows, capture events and the watermark, all on the landed reopen. It no
    longer edits a vendor file or `createSpeechToText.ts`; it merges before M3-T6b in wave 4.
  - **M2-T2** adds only `offline` (the landed `retrying` is the reconnecting state) and keeps
    every landed status field.
  - **M2-T3** writes migration 4 and leaves `stt_usage` alone.
  - **M2-T4** keeps the cost guards as they are, adds session listeners, a resume start that
    carries the saved `stt_usage`, `meetings.stop_reason`, and slots for T6 and M3-T19b.
  - **M2-T5** keeps one timeline per vendor stream; runs replace the landed `BUFFER_GAP_MS` drop.
  - **M2-T12** and **M2-T18** change one landed G4 decision each in `lifecycle.ts`: a renderer
    crash or reload reloads and goes on (a failed reload still stops), and a sleep pauses the
    sessions instead of stopping (a sleep of `noSpeechStopMs` or more still stops).
  - **M2-T13** raises `ROGER_STT_OPENS_PER_MINUTE` in the e2e harness; **M2-T16** re-runs through
    the shared budget (in the per-minute window only, 9.3) and adds its usage to the meeting;
    **M2-T17b** adds a `call-ended` stop reason; **M2-T19**'s STT check opens no session;
    **M2-T20a** keeps the meter line and the stop notice; **M2-T23** carries the saved usage into
    a resumed meeting.
  - The Wi-Fi cut in M2's exit check now needs T16 (AssemblyAI takes no replay faster than real
    time; the window comes back from the backup). The exit check runs on `STT_PROVIDER=assemblyai`.
- **Rescoped M3 tasks:**
  - **M3-T1** (now S): presets as rows in `stt_vendors.py` (`assemblyai` stays Universal-Streaming
    English; `assemblyai-pro` is Universal-3.6 Pro; `deepgram`; `fake`; `soniox` with T14);
    `STT_MODEL` retired; the landed TTL refusal kept (no clamp); the issuer and price table not
    rewritten; `test_stt_token_assemblyai.py` dropped (the landed `test_stt_token.py` covers it).
  - **M3-T3** adds the keyterm surcharge to the price per stream-hour.
  - **M3-T4a**: keyterms and their rejection go through `SttProtocol` and the core
    (`SttConnectError.keytermsRejected`) with a conformance case; no adapter retry, no
    `inlineReplay`, no held `warning` event.
  - **M3-T4b**: `CaptureSession` reopens once without keyterms, through `SttOpenBudget`.
  - **M3-T5**: extends the landed AssemblyAI protocol (Pro model, keyterms, model warning,
    fixtures) and adds the core's wire tap; it keeps the landed framing, held turns, close codes
    and `Terminate` (no `ForceEndpoint`) and no longer touches `createSpeechToText.ts`.
  - **M3-T18** (now M): pacing in the core (`audioPacing`, `AudioPacer`, the paced queue in
    `SttConnection`), and `AudioFrameSizer` moved to `stt/core/`. This takes the cost work's open
    issue: the reopen flush of up to 3 s of held audio was not paced and could draw AssemblyAI's
    3007.
  - **M3-T11** opens through a bench `SttOpenBudget` and prices runs from each token's price
    (`bench/report/prices.ts` dropped). **M3-T14** adds Soniox to `stt_vendors.py`, `domain.py`
    and `config.py`. **M3-T15** is one protocol file, one registry line and one conformance entry
    (plus an opening-messages hook in the core if Soniox needs it).
  - Deepgram is no longer the default anywhere. The bake-off compares C `assemblyai`
    (universal-streaming-english), A `deepgram` (nova-3), D `soniox` (optional) and B
    `assemblyai-pro` (universal-3-6-pro) only if it is worth its price, then E (no keyterms) and F
    (the gate). M3-T4a no longer gates M2's exit calls, only Deepgram bench runs.
- **Foundations:** P2-F1 turns the landed quit cleanup into ordered quit hooks (M4-T16's notes
  flush runs there), keeps the PCM constants in the barrel and the landed status fields in the
  fakes, moves nothing under `stt/`, and keeps the cost-guard wiring in `[slot M2-T4 runtime]`.
  P2-F2 adds the `stt_usage` stubs and revision `0005`, keeps the `stt_vendors.py` import rule
  (`Settings` only under `TYPE_CHECKING`) and the landed STT section and cost-guard block of
  `.env.example`.
- **M4:** the quit flush is a quit hook in `RecordingLifecycle`; S1 keeps the stop notice; S2
  keeps the `.notice` rule.
- **M5:** T11's file is `main/app/windowLifecycle.ts`, and T11 makes `watchWindow` stop only on a
  real close; T5 writes migration 5 and keeps the budget on a requested start.
- **M1 plan:** the known gaps and the reopen-flush risk now name their owners (M2-T6, T15, T16;
  M3-T18, T19a, T19b, T20).
- **Section 3.1** gained rows for `shared/capture.ts`, `lifecycle.ts`, `stopReasons.ts`,
  `stt/core/*` and the conformance suite, `registry.ts`, `stt/assemblyai/*`, `costGuards.ts`,
  `format.ts`, `stt_vendors.py`, `domain.py` and both READMEs; `createSpeechToText.ts` left it (no
  Phase 2 task edits it now).

### 9.3 After a review of 9.2 (2026-10-06)

Checked against the landed code (`costGuards.ts`, `SttOpenBudget.ts`, `CaptureSession.ts`,
`format.ts`, `lifecycle.ts`, `stt_vendors.py`, `test_stt_token.py`).

- **M3-T20, the gate's opens.** With `sttOpensPerMeeting` 30, Start's 2 and a reserve of 10, the
  gate had 18 reopens for both sources: a stop-and-start meeting spent them in 10 to 40 minutes,
  then billed silence until Stop, and M2-T16's re-runs drew on the same count. Gate reopens now
  count in the per-minute window and in their own `sttSilenceReopensPerMeeting` (120), never in
  `sttOpensPerMeeting`; the reserve setting is gone (nothing left to reserve), and with it the
  cross-field check it would have needed. Past its cap the gate is off for that meeting: one log
  line and `SttMeterStatus.silenceGate` `spent`. OD-27 states the cap.
- **M3-T20, held audio.** A gate reopen holds the pre-roll plus `sttReopenBufferMs`, and the
  pre-roll never counts as dropped; the landed `hold()` would have cut the pre-roll and logged
  "audio dropped while reconnecting" on every reopen. `sttSilencePreRollSeconds` is checked
  against that bound.
- **M3-T20, lag.** T18 never catches up above 1x and AssemblyAI documents no tolerance (M3 vendor
  facts), so a reopen's backlog is lag for that whole session. The pre-roll is 1 s, a token is
  prefetched while a source is gated (no API call at the onset), run F's latency measure is the
  lag the gate adds to the words of reopened sessions (D5 and OD-27 turn the default off above
  2.0 s), and those words are reported apart in the bench and the real call.
- **M3-T20 and M2-T6, gaps.** A gated window is never a gap; a failure or budget gap on a gated
  source starts at the speech onset, so M2-T16 never re-runs billed silence.
- **M3-T20, two pauses.** A pause cause per source (`stall` or `silence`): a gated source reopens
  only on speech, also after `resumeStreams()` (back online) and the wake.
- **M3-T1** owns the three `stt_model="nova-2"` cases in `test_stt_token.py` and the issuer
  lookup by the resolved vendor in `stt_vendors.py` (`assemblyai-pro` was a `KeyError`).
- **M2-T2** owns the `offline` case of `describeStream` (`format.ts`) in wave 1, or the type check
  fails. **M3-T20** owns the `paused` wording of a gated source.
- **M2-T4** owns `SttOpenBudget.ts`: a minute-only acquire for M2-T16 and M3-T20, the budget built
  in `createCaptureRuntime.ts` and injected, and the doc comment and CLAUDE.md rule 9 reworded to
  name the re-run and the bench. A resumed meeting's open allowance starts afresh instead of
  being seeded from `sessions_opened`, which counts gate reopens and re-runs too and could refuse
  the resume's own Start.
- **M3-T18** owns the comments pacing makes false (`hold()`, the flush, the `sttReopenBufferMs`
  `why`, the README's "Reopen buffer" row) in wave 0.
- **M3-T19a** keeps `stop_reason` free text; **M3-T19b** treats a `422` as rejected.
- **M3-T20's `SttMeter` fields are optional**, so wave 5's tests and shots and M4-S3's fixtures do
  not break.
- **M5-T11** adds a public `quitting` getter to `lifecycle.ts`, or close-hides cancels Cmd+Q.
- **M2-T22** records per call whether the gate was on. **M4**'s model-id example no longer names
  the retired `STT_MODEL`.
- **Section 3.1** gained `SttOpenBudget.ts`, `schemas/stt.py` with `test_stt_token.py`, and the
  bench's `replay.ts` and `report.ts`; `CaptureSession.ts`, `costGuards.ts`, `format.ts`,
  `lifecycle.ts`, `CLAUDE.md` and the desktop README name their new writers.

## 10. Notes from built tasks (read this if your task id appears below)

Wave 0's pure modules landed on `phase-2` on 2026-10-06. Their builders left these hand-offs for
later tasks. Each bullet names the task that must act on it.

- **M4-T8** (joins M4-T4 and M4-T5): pass `NoteBlock.text` (M4-T4, `notes_markdown.py`) to the
  support check in `citations.py`, never `.markdown`, or an ordered item's "3." counts as a number
  the user wrote. The prompt shows `NoteBlock.markdown`. T5's `RefMap.note_blocks` is a plain
  `tuple[str, ...]` today; adapt at the join. Import `FROM_YOUR_NOTES_HEADING` from
  `notes_markdown.py`. A line that is bold from end to end with no refs (e.g. "**Here are your
  notes:**") now parses as a heading; decide what a heading outside the template does. If the
  fixture `tests/fixtures/ai_notes_doc.json` is regenerated, keep the citation attrs
  `{segmentIds, startMs, label, support}` and the italic "Not said on the call" line before the
  closing list (`test_fixture_doc_renders` asserts that prefix).
- **M4-T8, M4-T13, M4-T18:** the drop reason codes from `notes_protocol.py` are `no_refs` and
  `unknown_refs`. The `dropped` event and the desktop text use these exact codes.
- **M4-T11:** weak (flagged) citation chips render like `ok` chips in Markdown; a "check this" cue
  for MCP is a product call, not built.
- **M4 plan, number check:** `citations.py` also accepts a `b` suffix (billion) besides k, m and
  bn; "one", "first" and "second" on their own never flag a line.
- **M5-T2:** `video_links.py` and its tests must mirror `shared/meetingLinks.ts` (M5-T8) exactly:
  Meet code paths only (never `/new`), Zoom `/j/<digits>`, `/my/<name>` and `/w/<digits>`, Teams
  `/l/meetup-join/` and `/meet/`. Copy the four Zoom URL rows from `meetingLinks.test.ts`: two
  accepted `/w/` rows, and refused `https://zoom.us/w/` and `https://zoom.us/s/1234567890`.
- **M5-T9a:** `runs` (local `calendar.sqlite`) is one row per stretch Roger was awake, not one per
  app run: open a new `runs` row on `powerMonitor` resume before that tick writes anything. A
  `missed` row logged as `policy` or `api_stale` while the lid was shut is expected; the runs split
  at each wake. `app.openAtLogin` defaults to `off` in `calendarPrefs.ts` until real-Mac check 1
  passes (M5-T11); switch it to `auto` in the change that logs that check.
- **M5-T10:** `CalendarPromptCard.events` is a non-empty list; two calls starting less than 60 s
  apart share one card. Card types carry `phase` and `error` so T9b and T10 never edit
  `shared/calendar.ts`. `notice.text` refuses blank text and caps at 1000 characters.
- **M2-T14b:** when re-deciding an already trimmed line (a late call-audio line, or a re-run
  through `filterStored`), pass the line as the vendor first wrote it (`original_text` and its
  words), as the doc comment on `filterEcho` says. `ECHO_FILTER_VERSION` is 1.
- **M3-T6b:** the per-stream `stt latency` log line at Stop is yours (M3-T6a built only the meter).

From `m1-assemblyai` (merged a3be3ee, 2026-10-06), the open issues its cost work left:

- **M3-T18:** the reopen flush sends up to `sttReopenBufferMs` (3 s) of held audio at once right
  after `Begin`; AssemblyAI may close with 3007 for audio faster than real time (M1 risk table,
  "The reopen flush trips..."). Pace it in the core, not in `CaptureSession`, so the stall reopen,
  the failure reopen, M2-T6's offline reopen, M2-T16's re-run and M3-T20's pre-roll are all
  covered. Rewrite the comments that say it is sent at once (`CaptureSession.hold()`, the
  `sttReopenBufferMs` `why`, the README's "Reopen buffer" row) in the same change.
- **M2-T6, M2-T16:** audio between a failure and its reopen is lost beyond the 3 s held, and
  nothing records it (M1 known gaps). There is no replay: record the gap, re-run it from the
  backup.
- **M3-T19a, M3-T19b:** nothing uploads `stt_usage` yet; the API already returns
  `stream.price_per_hour_usd`, and an older API may omit it (the desktop reads that as unknown).
- **M3-T20:** M1 named silence-gated streaming as the next guard. `CaptureService.pushAudio`
  carries a comment placing "M2's silence warning" there; the warning is M2-T11's fan-out sink and
  the gate lives in `CaptureSession`. M2-T4 updates that comment.
- **M2-T12, M2-T18, M5-T11:** `lifecycle.ts` stops the recording on a renderer crash, a reload,
  sleep and a window close. Each of these tasks changes exactly one of those decisions, with a
  test, and keeps the rest.
- **M2-T13:** the fake provider passes `SttOpenBudget` too; a third Start inside a minute is
  refused unless the harness raises `ROGER_STT_OPENS_PER_MINUTE`.
- **M2-T20a, M4-S1, M4-S2:** the meter line and each source's connected time live in M1's
  `StatusPanel` (`format.ts` helpers); the stop notice lives in `App.tsx` with a `.notice` rule.
  Replacing those files must keep both.
- **M2-T4, M2-T23:** `SttOpenBudget` lives on `CaptureService` and outlives meetings (the vendor
  counts per account); `stt_usage` is upserted per meeting. A resumed meeting must add to its saved
  row, not overwrite it. M2-T4 builds the budget in `createCaptureRuntime.ts` and injects it, so
  M2-T16 shares it (section 9.3).

From wave 1 (14 tasks merged 2026-10-06; their boxes in the milestone plans are ticked, with wave
0's). The plan text they made false is fixed in place; these are the hand-offs:

- **M2-T4, M2-T14b:** register `capture:get-report`, `capture:rerun-gaps` and `audio:delete-meeting`
  with `parseMeetingRequest`, and `transcript:unhide-segment` with `parseSegmentRequest`
  (`main/ipc-validation.ts`); until then they reject with "No handler registered". Pass
  `chunk.capturedAtMs` to the fan-out (`null` means the arrival time). The status-contributor seam
  sets the optional M2 fields of `CaptureStatus` and `SourceStatus` (a missing one reads as empty).
  Unhide refuses a line that is not `hidden`, as the preview fake does.
- **M2-T10, M2-T11, M2-T14b, M2-T15, M2-T17b:** import the thresholds from `shared/capture.ts`,
  never redefine them. `config.capture`: `systemAudioCapture` (T10), `audioBackup` (already false
  when retention is 0) and `audioRetentionDays` (0 to 30) (T15), `echoFilter` (T14b),
  `callDetection` (T17b). Meeting and segment ids are lowercase UUIDv4 only (`isUuidV4`).
- **M2-T12:** build `capturedAtMs` per chunk from `Date.now()`, never `performance.timeOrigin` (the
  doc on `AudioChunkMessage.capturedAtMs` says why). When you drop the `did-start-loading` stop in
  `lifecycle.ts`, point a comment there at `renderer/src/app/router.ts` (the shell avoids writing
  `location.hash` only because of that stop) and say so in your hand-off, so the controller drops
  the CLAUDE.md line on it. Keep the five stubs M2-T2 added to `AudioCaptureController.test.ts`.
  `window.ts` still opens 520x760, so the shell's narrow top-bar layout is the default (also
  M5-T11's file).
- **M2-T19:** register `setup:*` in your own registrar; validate `setup:open-settings-pane` with
  `parseSettingsPaneRequest`. The setup route opens from the app menu (M4-S1); first run and a
  permission-refused Start are yours: `navigation.navigate('setup')` on the const of `[slot M4-S1]`,
  declared after `[slot M2-T4 runtime]` in `main/index.ts`, so reach it lazily.
- **M2-T19, M2-T20a, M2-T20b (shots):** seed with `hub.emit(IpcChannel.CaptureGetReport, report)`
  and `hub.emit(IpcChannel.SetupGetStatus, status)`; the setup fake starts on a ready Mac with the
  notification test not yet run.
- **M2-T20b:** Unhide on hidden lines only. Progress is `CaptureStatus.rerun`; `rerunGaps` and
  `deleteMeetingAudio` answer the updated report. No call lists the meetings whose audio is kept for
  a re-run (the Home card): that is a contract change for `shared/ipc/capture.ts`'s next writer,
  M5-T5 (wave 4); raise it before wave 4.
- **M2-T21:** document the five new `config.json` keys in `apps/desktop/README.md`.
- **M3-T3:** a preset is `SttPreset(vendor, model)`; `Settings.stt_stream_price_per_hour_usd` is the
  base price, and the keyterm surcharge per model sits beside `SttVendor.price_per_hour_usd`. Read
  the list with `await services.vocabulary.list_terms(session, principal)` (at most 100, sorted
  ignoring case) and send `stream.keyterms` (`[]` when empty).
- **M3-T4b:** catch `err instanceof SttConnectError && err.keytermsRejected` and reopen that source
  once with `keyterms: []` through `SttOpenBudget`; the empty-list open is never `keytermsRejected`,
  so it cannot loop.
- **M3-T5:** add `keytermsRejected: (r) => r.kind === 'closed-before-ready' && r.code !== 1008 &&
  r.code !== 3009` and AssemblyAI's conformance `keyterms` entry (`refusal: { closeBeforeReady }`)
  in one commit; the suite fails if only one lands. A 1006 drop never reaches the predicate.
- **M3-T8:** `GET /v1/vocabulary` answers `{terms}`; `PUT {terms}` answers the list as stored; a
  broken limit is a `422` naming `body.terms` or `body.terms[i]`. `shared/vocabulary.ts` must equal
  `KEYTERM_LIMITS` (`main/stt/keyterms.ts`) and `schemas/vocabulary.py`: 100 terms as sent, 1 to 50
  code points after trimming, 800 in all, no Cc characters, case repeats dropped keeping the first.
  Every channel name starts with `vocabulary:` (`preview/control.test.ts` checks it: the offline
  preview fails those requests).
- **M3-T14:** `soniox` goes in `SttPresetId` and `STT_PRESETS`, its `SttVendor` with the `stt-rt-v5`
  price, `soniox_api_key` and its case in `Settings.stt_vendor_key`. The registry test stays green
  through `AWAITING_A_DESKTOP_ADAPTER`; `vendor_keys()` picks up the key unedited.
- **M3-T15:** delete `soniox` from `AWAITING_A_DESKTOP_ADAPTER`
  (`apps/api/tests/test_stt_providers.py`) in the commit that adds it to `registry.ts`. In
  `apps/desktop/README.md` "Add a speech-to-text vendor", step 7 still lists the removed default
  model and model-name prefix; replace it with: "7. One entry in `STT_VENDORS`
  (`apps/api/src/roger_api/stt_vendors.py`): issuer, the vendor's token TTL limit, and the list
  price per stream-hour by model, with the pricing URL and the date read. Say whether the vendor
  bills open time or audio sent. Then at least one `STT_PRESETS` row (a preset id, the vendor, and
  the model spelt as the vendor spells it), its id added to `SttPresetId`: `STT_PROVIDER` names a
  preset, never a vendor, and a test fails on a vendor no preset names." Step 8 says "the preset
  tables in", and the section's "Both apps change together, in one commit" notes the Soniox split.
- **M4-S4:** while B starts, meeting A's placeholder page shows "Roger can show only the meeting it
  recorded last for now..." until the shell navigates to B; your page reads stored meetings, so it
  goes with the placeholder (comment in `meeting/MeetingPage.tsx`). Props: `MeetingPage { meetingId
  }`, `RecentMeetings` none. Read route, `navigate`, `capture`, `captureMeeting` and `stopRecording`
  from `useShell()`, live state from `meetingPhase(meeting, status)` (`app/captureMeeting.ts`). Slot
  names are S1's. The meetings fake can answer `meetings:list` and `meetings:get` from what the
  scenarios play on the hub. `TranscriptView` still says "Press Start" when empty (you or M3-T9).
- **M4-T6:** the `PUT` 422 limits match `noteDocProblem` (`shared/notes.ts`) or are more lenient:
  512 KiB of UTF-8 compact JSON (`json.dumps(separators=(",", ":"), ensure_ascii=False)`), depth 32
  as the M4 contract row now counts it (a stack of `(value, level)`; a dict pushes a child at
  `level` when the key is `content` and the child a list, else `level + 1`; a list pushes each child
  at `level + 1`), forbidden keys anywhere.
- **M4-T7:** the stale sweep fails dead `running` rows before any claim inserts, with heartbeats on
  the database's `now()`. Enter `open_notes_model(settings)` inside `open_llm_runtime` and keep the
  model on `LlmRuntime`; the background task signals "opened" before the handler returns the SSE.
- **M4-T8:** `async with model.stream(req)` raises `LlmProviderError` on entry when the vendor
  refuses: answer the 502 envelope then, before the SSE 200. Mid-stream it is an
  `llm_provider_error` event; `ModelCutOffError` is `cut_off` with `.usage`; the fake's `usage=None`
  stores null cost, never 0. `meeting_notes.last_revision_id` is NOT NULL (store the run id). A
  second running run raises `IntegrityError` naming `ONE_RUNNING_NOTES_RUN_INDEX` (answer 409).
  `find_note_template` returns `None` for an unknown id (answer 422).
- **M4-T10, M4-T12:** import `ChatRole` and `ChatMessageStatus` from `db/models_notes.py`;
  `TextPart(cache=True)` sends `cache_control`. T12 compares models with `OpenRouterNotesModel` on
  `settings.model_copy(update=...)`.
- **M4-T14:** map the API's snake_case to `shared/notes.ts` types in `main/api/notesClient.ts`;
  `LocalNote.revisionId` is null for a doc from the server and keeps the local save's id after sync.
- **M4-T15, M4-T16:** send stream events as `NotesStreamMessage {meetingId, runId, event}` on
  `notes:event` and `ChatStreamMessage {meetingId, messageId, event}` on `chat:event`; a pre-stream
  API refusal is an `error` event with the envelope code. T16 registers every notes and chat channel
  through `main/ipc/trust.ts`, validates with `noteDocProblem`, `isNoteKind` and `isChatText`, emits
  `notes:changed` on every change (own saves too), and expects one `notes:flush-ack` per window per
  request.
- **M4-T16, M4-T23:** read `notes.autoGenerate` and `notes.whenUnsure` (`ask` or `general`) from the
  `preferences` const of `[slot M4-S2]` (T23 through an injected getter). Template ids are
  `general`, `standup`, `client_call` and `one_on_one`. Retry after a failed run takes a new run id.
- **M4-T17:** name the node with `CITATION_NODE_TYPE`; ack a flush once, after every open editor
  saved. Lists nested deeper than 13 levels with a link in them (14 without) exceed
  `MAX_NOTE_DOC_DEPTH`, and `saveNote` then rejects with no sync state to show it: cap list sinking
  on Tab, or show the refused save.
- **M4-T18:** import `FROM_YOUR_NOTES_HEADING` and `NOT_SAID_ON_THE_CALL` from `shared/notes.ts`.
  The API lists templates by name ignoring case (1:1, Client call, General, Standup); order the
  picker here if General should lead.
- **M4-T20:** in M4-T13's `preview/fakes/notes.ts`, wrap the template list as `hub.request(channel,
  fromApi('GET /v1/note-templates', ...))` and the run read with `fromApi('GET
  /v1/meetings/{id}/runs/{run_id}', ...)` (`preview/control.ts`); until then the api-offline preview
  shows a filled template picker. `segmentIdForLine(LIVE_CALL.meetingId, 40)` gives line 40's id for
  the reveal check; call `stopScenario()` before a shot that must hold still.
- **Every QA script (M2-T19, M2-T20a, M2-T20b, M3-T9, M4-T20, M5-T13):** scripts under `e2e/` run in
  `make e2e-desktop` too. Scenarios start after the app subscribes (the hub, like main, drops events
  nobody listens to). Force a theme with `window.roger.setPreference('theme', 'dark')`.
- **M5-T3:** models are `CalendarConnection` and `MeetingAttendee` (`db/models_calendar.py`); write
  the token with `func.pgp_sym_encrypt(token, key)`, read it with `func.pgp_sym_decrypt`;
  `on_conflict_do_update` on `uq_calendar_connections_workspace_id_user_id` replaces a NULL-user
  row. Build `GoogleCalendarProvider(client, client_id=..., client_secret=...)` or
  `FakeCalendarProvider(started_at=..., events_file=...)`; on `CalendarAccessTokenRejectedError`
  refresh once and retry once. `CalendarProviderName` exists twice (`config_calendar.py`,
  `services/calendar/provider.py`): import one. The contract's 424 also covers `invalid_grant` at
  the code exchange; `video_link_source: conference` means nothing was typed.
- **M5-T4:** `meetings.calendar_provider` and `meeting_attendees.response_status` have no check
  constraint: the pydantic schemas validate them.
- **M5-T6:** connect and disconnect call `CalendarSync.connected(accountEmail)` and
  `disconnected()`, never the cache's `recordConnected` or `recordDisconnected`. For IPC read
  `sync.getState()` and `cache.listEvents()`; subscribe with `sync.onStateChange` and
  `sync.onEventsChange`.
- **M5-T9a:** prepare the `prompts` and `runs` statements on `cache.database`.
  `prompts.account_email` is NOT NULL: a call-detected row with no calendar connected needs a
  deliberate value (`''`). Use `cache.firstSeenAt`, `cache.listConnections` and
  `cache.activeConnection` for `missedReason`, and `sync.ensureFresh(2 * 60_000)` under your own 5 s
  bound. Only main's `register` call is yours: the `PreferenceValues` types and the preview fake's
  calendar keys are done (M4-S2).
- **M5-T9b, M5-T9c:** open a meeting with `navigation.navigate('meeting/<lowercase uuid>')` on the
  const of `[slot M4-S1]`.
- **M5-T9c:** read `MAX(runs.last_tick_at)` before this run writes its row, pass it as `sync.start({
  previousRunLastTickAt })`, and subscribe `sync.onCatchUp` before `start()`. Wire `powerMonitor`
  `resume` to `sync.onWake()` and main-window `focus` to `sync.onWindowFocus()`. Open `new
  SqliteCalendarCache(join(userData, 'calendar.sqlite'))`; the quit hook calls `sync.stop()` before
  `cache.close()`.
- **Controller (files with no later writer):** `src/shared/ipc.ts` (P2-F1, frozen) still says "Today
  it would still compile, because the stubs add nothing", false now that capture, notes and chat
  have members; `styles.css` (M4-S2) keeps M1's unused `.app`, `.header` and `.controls` rules. Both
  need a comment-or-CSS-only commit.
- **Owner:** delete `STT_MODEL` from the API's `.env` if it holds a value (the API now refuses to
  start and names it). No task builds a theme control in Settings, and main does not set
  `nativeTheme.themeSource`, so a forced theme flashes the system one at load. On the first real
  OpenRouter call, check that reasoning effort `none` holds on the zero-retention route
  (`reasoning_tokens` in `notes_model_stream_ended`) and what status OpenRouter gives when no
  zero-retention endpoint is left (`notes_model_refused`).
