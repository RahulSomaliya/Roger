# Phase 2 build order (M2 to M5)

**Status:** draft for the owner's sign-off · **Owner:** Rahul · **Written:** 2026-10-06

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

1. **Land `m1-assemblyai` on `main`.** It holds a recorded owner decision of 2026-10-06:
   AssemblyAI Universal-Streaming replaces Deepgram as the M1 vendor. Its 6 commits add the API
   token issuer, the desktop adapter, its message parser, `AudioFrameSizer`, and shared
   `stt/websocket.ts` and `stt/json.ts` helpers. The worktree `scratchpad/wt-aai` still has 2
   uncommitted files (`AssemblyAiSpeechToText.ts` and its test). The session that owns it commits
   them, `make check` passes, Rahul merges, then `phase-2` is rebased on `main`. No phase-2 agent
   touches that worktree. The M3 tasks it overlaps were rescoped as deltas on top of it (M3-T1,
   M3-T5, M3-T18, see section 9).
2. **M2-T1's Mac check** (wave 0). On the installed app (`make install-desktop`): Start, grant,
   quit, relaunch, Start again. There must be no new prompt and call audio must be present. This
   is the field report from today ("can't detect system audio", "asks for the mic every
   restart"). The `tccd` log shows those were ad-hoc-signed builds, from before commit 30e137c
   (stable signing identity). T1 proves the fix, or finds the next cause.
3. **The M1 real call.** First, opt AssemblyAI out of training in its dashboard (owner, free).
   Then hold a 30-minute Meet call on the installed app with `STT_PROVIDER=assemblyai` on the API,
   and ask Claude through MCP to quote a line. Record it in the M1 exit check log.

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

### P2-F1. Desktop seams (S/M, no dependencies)

- `shared/ipc.ts` becomes a barrel. `IpcChannel` spreads per-feature channel maps, and `RogerApi`
  is the intersection of per-feature API types. Each feature has one module: `shared/ipc/capture.ts`
  (today's content moved here), `setup.ts`, `app.ts`, `prefs.ts`, `meetings.ts`, `vocabulary.ts`,
  `notes.ts`, `chat.ts`, `calendar.ts`, `loginItem.ts`, and `prompt.ts` (the prompt panel's own
  API; it is not part of `RogerApi`). After F1 nobody edits `shared/ipc.ts`.
  `shared/ipc.test.ts` asserts that channel names and keys are unique across features, because a
  duplicate key in a spread overwrites another channel with no error.
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
  behaviour. Feature clients live in their own files: `api/vocabularyClient.ts` (M3-T8),
  `api/notesClient.ts` (M4-T14), `api/streamRequest.ts` (M4-T15) and `api/calendarClient.ts`
  (M5-T6). This replaces M4-T13's ApiClient prep. DELETE is included because M5-T6 needs it.
  After F1, only M3-T4a (the token type) and M5-T5 (the create payload) edit `ApiClient.ts`.
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
  7. `[slot M2-T4 runtime]` today's API client, uploader, capture service and capture IPC.
  8. `[slot M4-S1]` navigation and the app menu.
  9. `[slot M4-S4b]` meetings IPC.
  10. `[slot M3-T8]` vocabulary IPC.
  11. `[slot M4-T16 notes]` notes and chat IPC, the generator and the sync.
  12. `[slot M5-T9c]` the calendar runtime and the start-request enricher.
  13. Window creation (today's lines).
  14. `[slot M5-T11 lifecycle]` the tray, the login item, `activate`, and today's
      `window-all-closed` handler, which moves into this slot.
  15. Inside `before-quit`: `[slot M4-T16 quit]` (flush notes) before `[slot M2-T4 quit]` (today's
      stop, uploader stop and store close).

  M2's own features (T10, T11, T14b, T15, T16, T17a, T17b, T18, T19) register through the slots
  that M2-T4 makes in `capture/createCaptureRuntime.ts`, not in `index.ts`.

### P2-F2. API seams (M, no dependencies)

- **Routers.** Stub `routers/vocabulary.py`, `note_templates.py`, `notes.py`, `notes_runs.py`,
  `chat.py` and `calendar.py`, each with an empty `router = APIRouter()`. All of them are included
  in `app.py` once. After F2, only M3-T1 edits `app.py` (the `api_started` fields).
- **Lifespan hooks.** `app.py` enters `open_llm_runtime(settings)` (stub in `services/llm_runs.py`,
  owned by M4-T7) and `open_calendar_runtime(settings)` (stub in `services/calendar/runtime.py`,
  owned by M5-T3), and stores both on `app.state`. **Rule:** a feature's FastAPI getters and `Dep`
  aliases live in its own service module, never in `dependencies.py`. Nobody edits
  `dependencies.py` in Phase 2.
- **Models.** Stub modules `db/models_vocabulary.py` (M3-T2), `db/models_notes.py` (M4-T1) and
  `db/models_calendar.py` (M5-T1), imported at the end of `db/models.py` so that Alembic and the
  test truncation see them. Only M5-T1 edits `db/models.py` afterwards (the new `Meeting` columns).
- **The Alembic chain** (section 2): three no-op revisions with fixed ids. `test_migrations.py`
  gains `test_alembic_has_one_head` and `test_revision_chain_is_fixed`.
- **Settings.** `config.py` composes `Settings` from two pydantic mixins with no `model_config`:
  `NotesSettings` in `config_notes.py` (M4-T2) and `CalendarSettings` in `config_calendar.py`
  (M5-T1). M3-T1 keeps owning the STT fields in `config.py`.
- **Errors.** `errors.py` gains every Phase 2 error class:
  - `LlmProviderError` (502 `llm_provider_error`)
  - `EmptyMeetingError` (422 `empty_meeting`)
  - `MeetingTooLongError` (422 `meeting_too_long`)
  - `CalendarProviderError` (502 `calendar_provider_error`)
  - `CalendarReconnectRequiredError` (424 `calendar_reconnect_required`)

  Each has an envelope test.
- **Domain types.** `domain.py` gains `NoteKind`, `RunKind`, `RunStatus` and `StartSource` (all
  five values, `call_detected` included).
- **Contract skeleton.** In `docs/api-contract.md`: the title loses "(M1)". The error table gains
  the five codes above. The 409 row is generalised and "This is the only `409`" is deleted. Each
  route's 409s are written in that route's section by its owner. Empty sections are added, each
  with its owner: Vocabulary (M3-T2), Note templates (M4-T3), Notes (M4-T6), Notes runs and
  streaming (M4-T8), Chat (M4-T10) and Calendar (M5-T3). The Database section gets one line per
  table group: M3-T2, M4-T1 and M5-T1.
- **`.env.example`.** Empty sections, each filled by its owner: Notes and AI (M4-T2), Calendar
  (M5-T1) and, in the desktop part, Benchmark (M3-T13).
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
  - Install with pnpm only. This Mac's pnpm has `minimum-release-age=10080` (7 days), so TipTap
    3.31.4 (published 2026-09-30) is refused until 2026-10-07. `~/.npmrc` pins npm to 2026-05-06,
    so never use `npm install`.
  - Re-check `npm view <pkg> time` and the weekly downloads for each package at install time, and
    write the numbers in the commit message.
- **Vitest configs.** `vitest.config.ts` includes `src/**`, `bench/**` and `preview/**` tests, and
  excludes `**/*.mac.test.ts` and `e2e/**`. New `vitest.mac.config.ts` and `vitest.e2e.config.ts`
  (with `passWithNoTests`).
- **Type check and lint.** `tsconfig.node.json` includes `bench/**`, `e2e/**`, `vitest.*.ts` and
  `vite.preview.config.ts`. `tsconfig.web.json` includes `preview/**`. `eslint.config.mjs` gets
  node globals for `bench/**` and `e2e/**` and browser globals for `preview/**`. No new tsconfig
  file and no change to the type-check script. This replaces M3-T10's `tsconfig.bench.json`,
  eslint and type-check edits.
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

This replaces M3's `apps/api/migrations/versions/0002_...` (wrong folder), M4's unnamed revision,
M5's `0005_calendar`, and every "down_revision is whatever head phase-2 has at merge" note.

**Local SQLite.**

- `roger.sqlite` (`SqliteTranscriptStore.MIGRATIONS`): migration 3 is M2-T3's and migration 4 is
  M5-T5's (`meetings.start_source`, `meetings.calendar_event_json`). M5-T5 starts after M2-T3.
- `notes.sqlite` (M4-T14) and `calendar.sqlite` (M5-T7) have their own `user_version` and take no
  number from this list.

## 3. Waves

A wave's tasks run in parallel. **Wave N starts when every task of wave N−1 has merged into
`phase-2`.** Inside a wave, no two tasks edit the same file, except through the slot and
section mechanisms in section 3.1, or where a merge order is stated. Size: S is under an hour of
agent time, M is one to two hours. "(Mac)" means a person runs a check on the Mac. "Optional" means
the task depends on an owner decision.

**Wave 0. Foundations, the M1 close, pure modules**

| Task | Size | Owns | Needs |
| --- | --- | --- | --- |
| P2-F1 | S/M | see section 1 | `m1-assemblyai` on main |
| P2-F2 | M | see section 1 | `m1-assemblyai` on main (it edits `config.py` and `app.py` too) |
| P2-F3 | S | see section 1 | OD-8 |
| M2-T0 | S | throwaway branch, never merged; the result goes into M2 D2 | human (Mac) |
| M2-T1 | S | `main/signing.ts`, `main/settingsPanes.ts` (with tests), the M1 exit log entry | (Mac) |
| M2-T14a | S | `main/capture/echo/EchoFilter.ts` (with test): pure, no Electron imports | - |
| M3-T6a | S | `main/stt/LatencyMeter.ts` (with test) | - |
| M3-T18 | S | `main/stt/AudioFramer.ts` (with test). It replaces `stt/assemblyai/AudioFrameSizer.ts` (deleted in M3-T5) | - |
| M4-T4 | S | `services/notes_markdown.py`, `tests/fixtures/ai_notes_doc.json`, `tests/test_notes_markdown.py` | - |
| M4-T5 | M | `services/notes_prompt.py`, `notes_protocol.py`, `citations.py` (with tests) | - |
| M4-T21a | S | `renderer/src/transcript/transcriptNavigator.ts` (the contract commit, with test) | - |
| M5-T8 | S | `shared/calendar.ts`, `shared/calendarPrefs.ts`, `main/calendar/ports.ts`, `main/calendar/reminderPolicy.ts`, `shared/meetingLinks.ts` (with tests) | - |

**Wave 1**

| Task | Size | Owns |
| --- | --- | --- |
| M2-T2 | M | `shared/capture.ts`, `shared/ipc/capture.ts`, `shared/ipc/setup.ts`, the `capture` and `setup` bridges and fakes, `main/config.ts`, `main/ipc-validation.ts` (with tests) |
| M2-T3 | M | `main/store/*` except the sync statements; `test/fixtures/backup/` (a small `roger.sqlite` plus WAV and m4a chunks with a gap, and the script that makes them) |
| M2-T7 | M | `native/roger-audio/{main,Protocol,Tap,RingBuffer,Lifecycle,SelfTest}.swift`, stub `Probe.swift` and `Monitor.swift` (called by `main.swift`), `scripts/build-native.sh`, the Darwin lines of `make check` |
| M3-T1 | M | `config.py` (the STT fields and presets), `schemas/stt.py`, `services/stt_tokens.py`, `app.py` (`api_started` fields), `tests/test_stt_providers.py`, `tests/test_stt_token_assemblyai.py`, `tests/test_config.py` (STT cases), `.env.example` (STT section), the contract's token `provider` line |
| M3-T2 | M | `db/models_vocabulary.py`, `0002_vocabulary_terms.py`, `services/vocabulary.py`, `schemas/vocabulary.py`, `routers/vocabulary.py`, `tests/test_vocabulary.py`, the contract's Vocabulary section and its Database line |
| M3-T4a | M | `main/stt/SpeechToText.ts` (`keyterms`, `inlineReplay`, `warning`), `main/stt/keyterms.ts`, `main/stt/deepgram/DeepgramSpeechToText.ts`, `main/stt/fake/FakeSpeechToText.ts`, `main/api/ApiClient.ts` (token type), the one fake-settings literal in `CaptureService.ts`, their tests |
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
| M2-T4 | M | `capture/CaptureService.ts` (adds a status-contributor seam, so warnings, echo and backup add status without editing it), `capture/AudioFanout.ts`, `capture/createCaptureRuntime.ts` (with slots for T10, T11, T14b, T15, T16, T17a, T17b, T18 and T19), `main/ipc.ts`, the `[slot M2-T4 …]` blocks |
| M2-T7b | S | `native/roger-audio/Probe.swift`, the route-switch case in `SelfTest.swift` |
| M2-T8 | M | `native/roger-audio/{Monitor,Route,ParentWatch}.swift`, `main/native/monitorRelaunch.mac.test.ts` |
| M2-T9 | S | `electron-builder.yml`, `scripts/install-mac.sh`, `main/native/helperPath.ts` (with test) |
| M3-T3 | S | `routers/stt.py`, the `keyterms` field in `schemas/stt.py`, the keyterm tests in `tests/test_stt_token.py`, the contract's token section |
| M3-T5 | M | `main/stt/assemblyai/*` (extends the M1 adapter; deletes `AudioFrameSizer`), `stt/streamSettings.ts` (comment and one test case), `stt/createSpeechToText.ts` (with test) |
| M3-T7 | M | `renderer/src/transcript/{liveTranscript.ts,LiveTranscript.tsx,useLiveTranscript.ts,transcript.css}` (with tests) |
| M3-T8 | M | `shared/vocabulary.ts`, `shared/ipc/vocabulary.ts` with its bridge and fake, `main/vocabulary/vocabularyIpc.ts` (validation included), `main/api/vocabularyClient.ts`, `renderer/src/settings/*`, `[slot M3-T8]`, their tests |
| M3-T11 | M | `bench/{cli.ts,vite.config.ts,canary.ts}`, `bench/run/*`, `bench/report/*` (with tests) |
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
| M2-T12 | M | `renderer/src/audio/*`, `renderer/src/state/useCapture.ts`, `main/window.ts` |
| M3-T13 | S | CLAUDE.md commands and benchmark lines, `docs/research/stt-benchmark.md`, `.env.example` (Benchmark section) |
| M3-T14 | S | Optional (OD-10). `services/stt_tokens.py` (one class), `config.py` (one preset), `tests/test_stt_token_soniox.py`, the contract's provider line |
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
| M2-T6 | M | `stt/ResilientSttStream.ts`, `stt/networkStatus.ts`, `stt/createSpeechToText.ts` (with test; wraps every adapter), `stt/deepgram/DeepgramSpeechToText.ts` (ping), and the same liveness check in the AssemblyAI adapter |
| M2-T13 | M | `e2e/{harness.ts,capture.e2e.ts}`, `main/e2eMode.ts` (with test), `[slot M2-T13]` |
| M2-T15 | M | `main/backup/*` (with tests, `AudioCompressor.mac.test.ts` included), the T15 runtime slot |
| M3-T6b | S | `capture/CaptureSession.ts` (one meter call per event and the `stt latency` line), its test |
| M4-T9 | M | `services/notes_long.py`, the budget switch in `notes_generation.py` |
| M4-T12 | M | the `roger_api/evals/` package, `apps/api/evals/notes/cases/synthetic_standup.json`, `tests/test_notes_eval.py` |
| M4-T16 | M | `main/notes/{notes-ipc,notes-ipc-validation,notesQuitGuard}.ts` (with tests), `[slot M4-T16 …]` (three slots) |
| M5-T5 | M | `shared/capture.ts` (`StartSource`, `StartCaptureRequest`, `title`), `shared/ipc/capture.ts` with its bridge and fake, `main/ipc.ts`, `main/ipc-validation.ts`, `capture/CaptureService.ts` (`start(request)`, the enricher port, `requestStart` and `takePendingStart`), `roger.sqlite` migration 4 and `findMeetingIdsByEventIds`, `upload/TranscriptUploader.ts` (the create payload), `ApiClient.createMeeting`, `renderer/src/state/useCapture.ts` |

**Wave 5**

| Task | Size | Owns |
| --- | --- | --- |
| M2-T14b | M | `capture/echo/*` except `EchoFilter.ts` (with tests), the T14b runtime slot (including T3b's `beforeFirstTick`) |
| M2-T18 | S | `power/PowerCoordinator.ts` (with test), the T18 runtime slot |
| M2-T19 | M | `main/setup/*`, `renderer/src/components/setup/*`, `e2e/setup.shots.e2e.ts`, `app/slots/m2-setup.ts`, the T19 runtime slot |
| M2-T20a | S | `renderer/src/components/capture/{WarningBanner,StreamStatus,LevelMeter,Notices}.tsx`, `e2e/capture-status.shots.e2e.ts`, `app/slots/m2-capture-status.ts` |
| M3-T4b | S | `capture/CaptureSession.ts` (`case 'warning'`), `capture/CaptureService.ts` (the `keyterms_rejected` capture warning), their tests |
| M3-T9 | S | `app/slots/m3-transcript.ts` (`LiveTranscript` and `VocabularySettings`), `renderer/src/state/useCapture.ts` (drops the segment and interim state), deletes `components/TranscriptView.tsx` |
| M3-T15 | M | Optional (OD-10). `main/stt/soniox/*`, one case in `stt/createSpeechToText.ts` |
| M4-T18 | M | `renderer/src/notes/{AiNotesPanel,TemplatePicker,NotesSettings}.tsx`, `aiNotesStream.ts`, `aiNotesActions.ts` (with tests) |
| M4-T19 | M | `renderer/src/chat/*` (with tests) |
| M5-T6 | M | `main/calendar/{oauthLoopback,CalendarAccount,calendarIpc}.ts`, `main/api/calendarClient.ts`, `shared/ipc/calendar.ts` with its bridge and fake (with tests) |
| M5-T9b | M | `main/prompt/{PromptService,promptIpc}.ts`, `main/calendar/consentNotice.ts`, `shared/ipc/prompt.ts` (with tests) |

**Wave 6**

| Task | Size | Owns |
| --- | --- | --- |
| M2-T16 | M | `main/rerun/*` (with tests), the T16 runtime slot |
| M2-T17a | S | `detect/{MeetingAppMonitor,callApps}.ts` (with test), the T17a runtime slot |
| M4-T20 | S | `app/slots/m4-notes.ts`, the M4 QA script and gallery |
| M5-T9c | M | `main/calendar/createCalendarRuntime.ts`, the enricher, `calendarFlow.test.ts`, `[slot M5-T9c]` |
| M5-T10 | M | `main/prompt/{PromptWindow,promptBounds}.ts`, `preload/prompt.ts`, `renderer/prompt.html`, `renderer/src/prompt/*`, `electron.vite.config.ts`, `main/page-policy.ts` |
| M5-T11 | M | `main/app/*`, `shared/ipc/loginItem.ts` with its bridge and fake, `build/tray*.png`, `main/window.ts`, `[slot M5-T11 …]` (two slots) |

**Wave 7**

| Task | Size | Owns |
| --- | --- | --- |
| M2-T17b | M | `detect/{CallDetector,CallOffer}.ts` (with test), the T17b runtime slot |
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
M2-T23 and M2-T17b → M2-T20b → M2-T21 (waves 0 to 9). M3 is code complete after wave 5, M4 after
wave 6 and M5 after wave 8. **If the day runs short, keep this order:**

1. Waves 0 to 5. They include M2's exit-check core set (T1 to T15, T3b, T7b, T20a) and all of M3.
2. M4 to wave 6.
3. M5 to wave 8.
4. M2-T16, T17b, T23 and T20b. The M2 plan already lets these land after the first exit-check
   calls.

### 3.1 Files more than one task edits, and in what order

Every other file has exactly one writer in Phase 2.

| File | Who edits it, in merge order | How collisions are avoided |
| --- | --- | --- |
| `docs/api-contract.md` | P2-F2 (skeleton, error rows) → wave 1: M3-T1 (token `provider`), M3-T2, M4-T1, M4-T3, M5-T1 → wave 2: M3-T3, M4-T6, M5-T3, M5-T4 → wave 3: M4-T8, M4-T10, M4-T11, M3-T14 | Each task edits only its own section, which P2-F2 created. The token section has a different writer in each wave (M3-T1, then M3-T3, then M3-T14). Contract and code change in the same commit (house rule 8). |
| `src/shared/ipc.ts` and `src/preload/index.ts` | P2-F1 only | Feature tasks own `shared/ipc/<feature>.ts`, `preload/bridges/<feature>.ts` and `preview/fakes/<feature>.ts`. `capture.ts` and its bridge: M2-T2 (wave 1), then M5-T5 (wave 4). |
| `src/main/index.ts` | P2-F1 (slots) → M4-S2, M4-S1 (wave 1) → M2-T4, M3-T8 (2) → M4-S4b (3) → M2-T13, M4-T16 (4) → M5-T9c, M5-T11 (6) → M2-T23 (7) | Named slots (section 1). Inside a wave the slots differ, so the merges are clean. Nobody edits outside their slot. |
| `src/main/capture/createCaptureRuntime.ts` | M2-T4 (slots) → T10, T11 (3) → T15 (4) → T14b, T18, T19 (5) → T16, T17a (6) → T17b (7) | Runtime slots made by M2-T4, used the same way as the `index.ts` slots |
| `src/main/capture/CaptureService.ts` | M3-T4a (wave 1, one literal) → M2-T4 (2) → M4-T22 (3) → M5-T5 (4) → M3-T4b (5) | One writer per wave |
| `src/main/capture/CaptureSession.ts` | M2-T5 (3) → M3-T6b (4) → M3-T4b (5) | One writer per wave |
| `src/main/upload/TranscriptUploader.ts` | M2-T3b (2) → M4-T22 (3) → M5-T5 (4) | One writer per wave |
| `src/main/store/*` | M2-T3 (1) → M2-T3b (2) → M4-S4b (3) → M5-T5 (4) | One writer per wave |
| `src/main/api/ApiClient.ts` | P2-F1 (0) → M3-T4a (1) → M5-T5 (4) | Feature clients live in their own files |
| `src/main/stt/createSpeechToText.ts` | M3-T5 (2) → M2-T6 (4) → M3-T15 (5) | One writer per wave |
| `src/main/stt/deepgram/DeepgramSpeechToText.ts` | M3-T4a (1) → M2-T6 (4) | - |
| `src/main/ipc.ts`, `src/main/ipc-validation.ts` | P2-F1 (0, trust helpers) → M2-T2 (`ipc-validation.ts`, 1) → M2-T4 (`ipc.ts`, 2) → M5-T5 (4) | Other features register in their own modules |
| `src/renderer/src/state/useCapture.ts` | M2-T12 (3) → M5-T5 (4) → M3-T9 (5) | - |
| `src/main/window.ts` | M2-T12 (3) → M5-T11 (6) | - |
| `src/renderer/src/styles.css`, `theme/tokens.css` | M4-S2 only. Later tasks never write colours; they use tokens. A task that needs a new token adds it at the end of `tokens.css`, in both themes, and never renames one. | S2 ships the union the plans need: `--bg`, `--panel`, `--ink`, `--muted`, `--line`, `--accent`, `--danger`, `--warn`, `--ok`, `--danger-bg`, `--warn-bg`, `--ok-bg`, `--interim-ink`, `--hidden-ink`, `--cited-bg`, `--recording`, `--focus-ring`, `--sidebar-bg`, `--chip-bg`, `--conflict-bg` |
| `src/renderer/src/app/slots.ts` | M4-S1 only | Each mount task owns its own `app/slots/<task>.ts` |
| `app.py` | P2-F2 → M3-T1 (the `api_started` fields only) | Router includes and lifespan hooks are already in place |
| `config.py` | P2-F2 (mixins) → M3-T1 (1) → M3-T14 (3) | Notes and calendar settings are in their own mixin files |
| `db/models.py` | P2-F2 (imports) → M5-T1 (the `Meeting` columns) | New tables live in per-domain modules |
| `.env.example` | P2-F2 (sections) → M3-T1, M4-T2, M5-T1 (1) → M3-T13 (3) | Each task writes in its own section |
| `apps/desktop/package.json`, `pnpm-lock.yaml` | P2-F3 only | A task that truly needs a new package asks the controller, which makes a separate F3-style commit |
| root `Makefile` | P2-F3 → M2-T7 (the Darwin `check` lines) | - |
| `CLAUDE.md` | M4-T2 (rule 4, wave 1) → M3-T13 (commands, wave 3) → M2-T21 (repo map, commands, wave 9). The controller appends failure-log lines. | Tasks put proposed failure-log lines in their hand-off note. The controller appends them once per wave. |
| `apps/desktop/src/renderer/src/App.tsx` | M4-S1 only | No milestone mounts in M1's window any more: the shell lands in waves 1 and 2, before any UI that would mount |

## 4. Test databases per worktree

- Every task runs `make check TEST_DB=roger_test_<task>`. The name is the task id in lower case,
  with `-` turned into `_`: `roger_test_p2_f2`, `roger_test_m3_t2`, `roger_test_m4_t8`,
  `roger_test_m5_t3`, `roger_test_m2_t14b`. Desktop-only tasks too, because `make check` runs the
  API tests.
- P2-F2's conftest creates the database when it is missing. It refuses any name that does not
  start with `roger_test`. One Postgres (`make dev-db`) serves every worktree.
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
| M1 | After a real 30-minute Meet call, Claude quotes a line from it through MCP | Land `m1-assemblyai`; M2-T1's Mac check | AssemblyAI key and its training opt-out; the 30-minute call (one person, today if a call happens) |
| M2 | 10 real calls in a row with no lost or doubled text; cutting the audio mid-call warns within 10 s | Code complete (waves 0 to 9). Mac checks: T0 spike, T1 anchors, T11 input volume 0 and revoked mic, `make test-native-route` | 10 real calls (2 on speakers, AirPods mid-call, lid closed, `kill -9`, 2 from the offer), 3 timed cuts filmed on a phone, a 2-hour soak. About 2 to 4 working days. |
| M3 | The chosen vendor's error rate is written down; swapping vendor is one config change | Code complete after wave 5; the canary against the fake provider | AssemblyAI and Deepgram keys and opt-outs. About 10 consented internal calls recorded through M2's backup and clipped within 7 days, then about 90 minutes of hand-fixing. The bake-off runs, then a 10-minute real call and two vendor flips. |
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
| OD-1 | Land `m1-assemblyai` (owner decision 2026-10-06: AssemblyAI is the M1 vendor) before Phase 2 starts? | Yes. Its session commits the last 2 files, `make check` passes, Rahul merges to `main`, and `phase-2` is rebased. M3-T1, T5 and T18 build on it. | Close it unmerged and let M3 rebuild it from scratch | this plan |
| OD-2 | Who merges task branches? (House rule: "Agents never merge.") | The controller merges task branches into the `phase-2` integration branch after review and the gate. Rahul reviews each wave. `phase-2` → `main` is Rahul's alone. | Rahul merges every task branch himself (about 75 merges) | this plan |
| OD-3 | Where does call audio come from? | A Swift helper with a Core Audio process tap, with Electron's path kept as the fallback | Stay on Electron's `desktopCapturer` | M2 D1 |
| OD-4 | How is echo removed? | Text-level dedupe in main. Spike T0 decides whether `echoCancellation: 'all'` is also turned on. | Acoustic cancellation only; signal correlation | M2 D2 |
| OD-5 | When is call-audio silence loud? | On screen at 8 s. A notification at 60 s while the mic hears speech, or at 180 s regardless. | Notify at 8 s | M2 D3 |
| OD-6 | Mic dead threshold on Bluetooth (**deviation** from "within 10 s") | 30 s on Bluetooth, 8 s elsewhere. The exit-check cut runs on the built-in mic. | 8 s everywhere | M2 D4 |
| OD-7 | Audio backup format and retention | Per-stream WAV of at most 60 s, turned into 48 kbps AAC by `afconvert`. Kept 7 days (configurable). Gaps not yet re-run keep their audio up to 30 days. Paused below 2 GiB free. Never uploaded. | webm/opus; WAV only; FLAC | M2 D5 |
| OD-8 | New dependencies | `playwright-core` 1.63.0 (dev). It is the one driver for the Electron smoke test and all browser QA (M5-T13 drops puppeteer). TipTap ×5 pinned to 3.31.3. | A hand-written CDP client; raw ProseMirror | M2 D8, M4 new deps |
| OD-9 | `workspace_id` on local SQLite (**deviation** from C5) | A nullable column on M2's three new tables. `meetings`, `segments`, `app_state`, `notes.sqlite` and `calendar.sqlite` wait for M6's backfill. | No column anywhere until M6 | M2 D9, M4 known gaps |
| OD-10 | A third STT vendor? | Yes: Soniox (M3-T14, T15), built last and dropped if the day runs out | Two vendors, three configurations | M3 D1 |
| OD-11 | Keep a standing test set of colleagues' audio (**deviation** from C6) | Yes, as a signed exception: internal calls only, per-person consent, FileVault, mode 0700, `bench forget`. Linked from the roadmap's audio-policy decision. | Re-clip every 7 days; include client calls | M3 D2 |
| OD-12 | Never train vendors on calls | Deepgram: `mip_opt_out=true` on every request, even at a higher price. AssemblyAI: opted out in its dashboard before any real call, M1's included. | Stay in Deepgram's program for the discount | M3 D3 |
| OD-13 | How is the STT vendor chosen? | The rule fixed in M3 before any scoring: latency and failure gates, then pooled WER, then term recall, then cost | Decide after seeing the numbers | M3 D4 |
| OD-14 | How does the API reach LLMs? | A thin `NotesModel` adapter over `httpx` to OpenRouter. LiteLLM 1.82.7 and 1.82.8 were malicious PyPI releases on 2026-03-24 (LiteLLM's security post; Datadog Security Labs). | LiteLLM pinned to a clean release, after a re-lock | M4 D1 |
| OD-15 | Which model writes notes and answers chat? | `anthropic/claude-sonnet-5.5`, reasoning off | Opus 5.5 for notes; reasoning on | M4 D2 |
| OD-16 | May calls go to providers that keep data? | No: `zdr: true` and `data_collection: deny` on every request | `data_collection: deny` only | M4 D3 |
| OD-17 | What happens to an AI line the transcript does not back? | Drop it if it has no valid citation (listed as removed). Flag it if its numbers or words are not in the cited lines. | Flag all, drop none | M4 D4 |
| OD-18 | How are edits from two places reconciled? | Whole-doc versions with a visible conflict copy. A CRDT is revisited in M10. | Yjs now | M4 D5 |
| OD-19 | Who owns the app shell? | M4-S1 to M4-S4b, in waves 1 to 3. M5's SHELL-0 spec is folded into S1 and S2, and every plan uses these ids. | Two foundation tasks outside the milestones | M4 D6, M5 D4 |
| OD-20 | An AI line backed only by the user's notes | (a) A closing "From your notes" list with no chips | (b) A note chip in place, with stable block ids | M4 D7 |
| OD-21 | Where does the Google refresh token live? | In the API, encrypted with pgcrypto. The cost: `make dev-api` must run, and a stale calendar is loud after 1 h. | Desktop Keychain | M5 D1 |
| OD-22 | Google consent screen audience | Internal, under the linkt.ai org | External + Testing, with a reconnect every 7 days | M5 D2 |
| OD-23 | Notice wording | The default text, on by default, reviewed by Linkt's legal view before Gate 2. Consider naming the 7-day local audio backup (OD-7). | Wait for legal | M5 D3 |
| OD-24 | Who owns the prompt panel and call-detected offers? | M5's `PromptService.offer`. M2-T17b feeds it and builds no card or notification of its own. A click stores `call_detected`, or `notification` when one calendar event matches. | M2 owns it | M5 D5, M2 D6 |
| OD-25 | Crash relaunch | The monitor helper relaunches Roger once per meeting and resumes the same meeting, with a visible Stop | End the meeting at launch | M2 D7 |
| OD-26 | Call detection method | Poll Core Audio process objects every 1 s against an allowlist of call apps. Offer after 5 s (15 s for a browser). Never auto-start. | Window titles; a deny-list; auto-start | M2 D6 |

## 8. Owner and human inputs, by day

- **Today, before wave 0:** sign OD-1, OD-2 and OD-8 (they gate the foundations); finish
  `m1-assemblyai`.
- **Today, during waves 0 to 2:** sign the rest. Run T0, T1 and T11 on the Mac. Opt AssemblyAI out
  of training.
- **Today, after waves:** check the installed app at the end of each wave.
- **Keys, any time:**
  - `ASSEMBLYAI_API_KEY` and `DEEPGRAM_API_KEY` (M1, M3)
  - `OPENROUTER_API_KEY` (M4)
  - The Google Cloud project and Desktop OAuth client, plus `CALENDAR_TOKEN_KEY` (M5, about 10
    minutes; the steps are in the M5 plan)
  - The Deepgram opted-out price, read in its console (M3)
  - Delete `STT_MODEL` from `.env` after M3-T1 merges. The API refuses to start and names it.
- **Following days:** the calls in section 6.

## 9. Changes made to the milestone plans

Made in this change, so each agent reads one consistent story in its own plan:

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
  - T6 depends on M3-T4a (`inlineReplay`) and M3-T5 (file order).
  - T7 keeps only the Darwin `check` wiring of the tooling; P2-F3 has the rest. T7 creates stub
    `Probe.swift` and `Monitor.swift`.
  - T14 is split into T14a (pure, wave 0) and T14b.
  - T17b calls `PromptService.offer`, depends on M5-T9b and no longer on M5-T11. The
    `call_detected` gate is confirmed: M5-T1, T4 and T5 carry it.
  - T20b drops `CallCard`.
  - Local migration 3 is T3's and 4 is M5-T5's.
- **M3:**
  - Builds on `m1-assemblyai`. T1 adds presets on top of the existing issuer, T5 extends the
    existing adapter, and T18 replaces `AudioFrameSizer`. "Today's vendor" now reads AssemblyAI
    Universal-Streaming.
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
