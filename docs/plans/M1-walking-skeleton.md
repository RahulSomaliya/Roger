# M1. Walking skeleton

**Phase:** 1 · **Status:** in review · **Owner:** Rahul · **Plan written:** 2026-10-05 · **Closed:** -

## Goal

A real call goes in and its full transcript comes out through MCP. Every risky part of the system
is exercised once, end to end, with no polish: two audio streams captured in Electron, streamed to
speech-to-text, saved on the Mac, uploaded to Postgres through the API, read back by Claude.

## Done when

- [ ] After a real 30-minute Google Meet call, Claude quotes a line from it through MCP.
  Run: `make dev-db && make migrate && make dev-api`, `make dev-desktop`, press Start, hold the
  call, press Stop, then in Claude Code (with the MCP server added, see README) ask
  "Quote the first thing the other person said in my last meeting." Record the result below.

## In scope

- Electron app with one Start and Stop button, a status line and the live transcript.
- Mic and system audio captured as two separate streams (mic = Me, system = Them).
- Speech-to-text behind a `SpeechToText` interface: an AssemblyAI streaming adapter (the vendor
  since 2026-10-06), a Deepgram streaming adapter (the second adapter) and a fake adapter for
  development and tests. Vendor key stays on the API; the desktop gets a short-lived token.
- Transcript lines saved to local SQLite the moment they are final, then uploaded in batches with
  retry. Postgres is the source of truth.
- API: meetings, segments, transcript read, STT token, health. Alembic migrations.
- MCP server in the API: one tool, `get_transcript`.
- Cost guards on the live speech-to-text connection (owner ask, 2026-10-06): no session stays open
  that nobody needs, every open is limited, and what it cost is visible.
- Tests and lint on both sides, green under `make check`.

## Out of scope

- Permission setup screen, no-audio warning, reconnect replay, echo removal, audio backup (M2).
- Interim text in the UI beyond a single "listening" line per stream; jargon list; vendor bake-off (M3).
- Notes, templates, calendar, login, OAuth for MCP (M4+).

## Design

| Decision | Choice | Alternative | Why |
| --- | --- | --- | --- |
| System audio capture | Electron's built-in `desktopCapturer` path (Chromium Core Audio tap on macOS 14.2+, needs `NSAudioCaptureUsageDescription`) | Swift helper using `AudioHardwareCreateProcessTap` (openwhispr, anarlog, meetily all do this) | Zero native code to start. The capture layer is behind a `SystemAudioSource` seam so the helper can replace it if prompts or reliability are wrong. M1 must record which prompts macOS shows. |
| Where audio is turned into PCM | Renderer, one `AudioContext({sampleRate: 16000})` per stream feeding an `AudioWorklet` that emits Int16 chunks of 1600 samples (100 ms). The worklet module is compiled by its own tsconfig and only ever loaded through `addModule`; page code shares a side-effect-free contract module with it. | `MediaRecorder` with WebM | Vendors want raw linear16 at 16 kHz; letting Chromium resample avoids a hand-written resampler. Pattern from openwhispr. |
| Where STT and persistence live | Main process | Renderer | Main owns secrets, sockets and files. Renderer stays display-only (house rule 5). |
| STT event shape | Our own `SttEvent` union (`interim`, `final`, `error`, `closed`), vendor messages parsed inside the adapter | Pass vendor JSON through | One normalised shape keeps the session, store and UI vendor-free (anarlog's `StreamResponse`). |
| STT vendor for M1 | AssemblyAI Universal-Streaming English (v3 websocket, `pcm_s16le` at 16 kHz in 50 to 1000 ms messages, `format_turns` with one saved line per turn, temporary token as the `token` query parameter, `Terminate` then wait for `Termination` on stop). Owner decision, 2026-10-06; Deepgram nova-3 until then. | Deepgram nova-3 (kept as the second adapter: `interim_results`, `KeepAlive` every 5 s, `Finalize` then `CloseStream` on stop), OpenAI Realtime | The owner's reasons: AssemblyAI lists Granola as a customer, live text is about $0.15 an hour per stream (billed for the time the stream is open), and the free hours are generous. Documented temporary tokens and a simple binary websocket. Bake-off is M3. |
| Token flow | `POST /v1/stt/token` returns provider + 30 s token + stream settings | Key in the desktop `.env` | House rule 3. Also makes "swap vendor" an API config change. |
| STT connection lifecycle | One core for every websocket vendor (`SttConnection`); an adapter only describes its protocol (`SttProtocol`); a registry of vendors on each side; a conformance suite every vendor must pass, failing on any socket left open | A socket lifecycle per adapter | Owner ask, 2026-10-06: changing provider must be easy and opening and closing careful. Vendors bill open time, so a lifecycle per adapter leaks per adapter. |
| STT cost guards | A failed or ended source closes its session at once; a source silent for 30 s closes it and reopens with audio, a fresh token and a 3 s held buffer; vendor failures reopen after a doubling backoff; every open (Start's included, both sources) passes one limiter, 4 a minute and 30 a meeting; a recording stops after 15 minutes with no final line, at 4 hours, and on quit (5 s bound), sleep, window close, crash or reload; AssemblyAI streams set `inactivity_timeout` 120 s and the API asks for the 3-hour cap explicitly; Deepgram's KeepAlive runs only while audio flows. Numbers in `apps/desktop/src/main/costGuards.ts`, overridable, validated. Usage metered per source and meeting: status line, logs, SQLite `stt_usage`. | Silence-gated streaming (a session open only while someone speaks, with a pre-roll buffer) | Owner ask, 2026-10-06: be super conservative with cost. AssemblyAI bills every open second, $0.15 an hour per stream, two a meeting; a forgotten recording overnight was about $4.20. Gating on speech needs voice detection and a pre-roll to keep first words: M3-T20. |
| Local safety copy | `node:sqlite` (built into Electron 44's Node), WAL, append-only `segments` rows with `synced_at` | `better-sqlite3` | No native rebuild, no ABI mismatch between vitest and Electron. |
| Upload | `TranscriptUploader` polls unsynced rows every 2 s, batches up to 200, exponential backoff on failure, marks `synced_at` | Upload each segment as it arrives | Fewer requests, same guarantee: nothing is lost locally. |
| Ids | Desktop generates UUIDv4 for meetings and segments; the API inserts and ignores ids it already has | Server ids | Retries and replays are safe (house rule 7). |
| MCP auth | Bearer middleware with the shared secret on `/mcp` | SDK `TokenVerifier` + OAuth | OAuth is M7. A plain header works with `claude mcp add --header` today. |
| MCP mounting | `mcp.streamable_http_app(stateless_http=True)` behind the bearer middleware, added as an exact `Route("/mcp")` after the REST routes; session manager entered in the FastAPI lifespan | A mount at `/`; a separate process | One deploy, one auth story. An exact route serves `/mcp` with no slash redirect and leaves every other path to FastAPI, so unknown paths keep the 404 envelope. |

### Data flow

```
renderer                      main                                   api
getUserMedia(mic) ─┐          CaptureSession
getDisplayMedia ───┤ worklet  ├─ SttStream(mic)  ──┐  final ──▶ SqliteStore ──▶ Uploader ──▶ POST /v1/meetings/{id}/segments
                   └──IPC────▶├─ SttStream(system)─┘  interim ─▶ renderer (live line)
                              └─ ApiClient: POST /v1/meetings, /stt/token, /end
```

## Work items

- [x] `apps/api`: project, settings, logging, db session, models, migrations, auth dependency.
- [x] `apps/api`: meetings, segments, transcript, stt token, health routes with tests.
- [x] `apps/api`: MCP server with `get_transcript`, bearer middleware, tests through the MCP client.
- [x] `apps/desktop`: electron-vite project, strict TS, eslint, prettier, vitest.
- [x] `apps/desktop`: shared IPC contract and transcript types.
- [x] `apps/desktop`: renderer capture (mic + system) with worklet and chunk IPC; Start/Stop UI.
- [x] `apps/desktop`: `SpeechToText` interface, Deepgram adapter (ws), fake adapter, message parsing tests.
- [x] AssemblyAI as the vendor (2026-10-06): API token issuer, desktop adapter and parser, contract.
- [x] `apps/desktop`: `CaptureSession` state machine, SQLite store, uploader, API client with tests.
- [x] `apps/desktop`: electron-builder config with `NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription`.
- [x] Shared STT lifecycle, vendor registries, conformance suite, price per stream-hour (2026-10-06).
- [x] STT cost guards and metering (2026-10-06): see the design row and `apps/desktop/README.md`.
- [ ] Exit check on a real call (needs a Mac).

## Tests

| What | Test |
| --- | --- |
| API auth on every non-public route, meetings, idempotent segments, transcript ordering, end, health | `apps/api/tests/test_auth.py`, `test_meetings.py`, `test_health.py` |
| STT token issuing (fake, AssemblyAI and Deepgram via mocked HTTP); provider settings | `apps/api/tests/test_stt_token.py`, `test_config.py` |
| MCP tool through the SDK client, both handshakes; the text read never selects word timings | `apps/api/tests/test_mcp.py` |
| PCM conversion and chunking | `apps/desktop/src/shared/pcm.test.ts`, `src/renderer/src/audio/PcmChunker.test.ts` |
| Deepgram message parsing to `SttEvent` | `apps/desktop/src/main/stt/deepgram/messages.test.ts` |
| Deepgram adapter against a local fake websocket server | `apps/desktop/src/main/stt/deepgram/DeepgramSpeechToText.test.ts` |
| AssemblyAI message parsing to `SttEvent`; audio message sizing (50 to 1000 ms) | `apps/desktop/src/main/stt/assemblyai/messages.test.ts`, `AudioFrameSizer.test.ts` |
| AssemblyAI adapter against a local fake websocket server (token auth, one line per turn, Terminate, failures) | `apps/desktop/src/main/stt/assemblyai/AssemblyAiSpeechToText.test.ts` |
| Capture state machine, partial-open cleanup, mid-call stream failure, finals during close | `apps/desktop/src/main/capture/CaptureService.test.ts`, `CaptureSession.test.ts` |
| Shared STT lifecycle (timeouts, forced close, keep-alive only while audio flows, metering) and every vendor's conformance, with a leaked-socket check after each test | `apps/desktop/src/main/stt/core/SttConnection.test.ts`, `WebSocketSpeechToText.test.ts`, `src/main/stt/conformance.test.ts`, `createSpeechToText.test.ts` |
| Cost guards: settings and their validation; the open limiter on a fake clock; a failed source closing its own session in the same tick; stall close and reopen with a fresh token, held audio and meeting-relative offsets; reopen backoff and the per-minute and per-meeting limits; no-speech and 4-hour auto-stop; metering in the status, logs and store | `apps/desktop/src/main/costGuards.test.ts`, `src/main/capture/SttOpenBudget.test.ts`, `CaptureService.test.ts`, `CaptureSession.test.ts`, `stopReasons.test.ts` |
| Stop on quit (bounded wait), sleep, window close, renderer crash and reload | `apps/desktop/src/main/lifecycle.test.ts` |
| SQLite store append, unsynced query, mark synced, rejected lines, crash recovery, restart, per-meeting STT usage and its migration | `apps/desktop/src/main/store/SqliteTranscriptStore.test.ts` |
| Uploader batching, retry, ordering, 422 quarantine, lost-meeting resync | `apps/desktop/src/main/upload/TranscriptUploader.test.ts` |
| Renderer payload validation (odd-length and oversized chunks) | `apps/desktop/src/main/ipc-validation.test.ts` |
| Renderer capture follows main: a source still starting stops when main goes idle, a start never runs on top of a capture (fake devices) | `apps/desktop/src/renderer/src/audio/AudioCaptureController.test.ts` |
| API client request shapes and error mapping | `apps/desktop/src/main/api/ApiClient.test.ts` |

## Risks

| Risk | Signal | Response |
| --- | --- | --- |
| Electron's system audio path shows a Screen Recording prompt or delivers a dead track | Track `readyState` is `ended` at start, or zero chunks from the system stream in 5 s | The UI shows "no system audio". Plan B is a Swift helper behind the same `SystemAudioSource` seam (M2). |
| The STT token (30 s) expires before the sockets open on slow networks | 401 on connect (Deepgram), close 1008 before `Begin` (AssemblyAI) | Fetch the token right before connecting; the API TTL is a setting. |
| AssemblyAI ends every session after 3 hours (the API asks for that cap explicitly) | Error 3008 and close mid-call | Roger reopens a fresh session after 2 s, through the open limiter; the few seconds in between are not transcribed (no audio backup until M2). A recording stops at 4 hours anyway. |
| AssemblyAI lets a free account start only 5 sessions a minute ([rate limits](https://www.assemblyai.com/docs/streaming/rate-limits), 2026-10-06), and every Start opens two | The vendor refuses after the handshake with "Too many concurrent sessions" (close 1008 or 3009; the vendor's pages disagree) | Roger's own limiter allows 4 opens a minute across meetings and both sources, so a third quick Start is refused before any socket, saying when to try; reopens spend the same budget. |
| AssemblyAI bills the time a session is open, not the audio sent | A dead or silent system stream costs as much as a live one: about $0.30 per call hour for both | The cost guards: a failed source closes at once, a silent one after 30 s, no final line for 15 minutes stops the recording, 4 hours stops any; the status line shows the running cost. |
| The reopen flush trips AssemblyAI's faster-than-real-time rule | A reopened stream closes with 3007 right after it opens | The held audio is capped at 3 s; lower `sttReopenBufferSeconds`; M3-T18 paces every send in the shared STT core. |
| The Mac sleeps in the middle of a stop | The socket stays half-open on the vendor's side | `inactivity_timeout` (120 s) closes it there; the finish timer terminates Roger's side on wake. |
| API down mid-call | Uploader backoff visible in status line ("12 lines waiting") | Rows stay local with `synced_at NULL`; uploader resumes. Meeting `end` is retried too. |
| Vendor message format drifts | Parsing tests fail; unknown message types are logged, not fatal | Adapter isolates the shape. |

## Known gaps carried forward

The M1 wrap-up left these alone on purpose. Each has an owner.

| Gap | What happens today | Owner |
| --- | --- | --- |
| Audio while a speech-to-text session reconnects (a network blip, AssemblyAI's 3-hour cap) | The session reopens after its backoff, but only the last 3 s of audio are held, so speech during the wait is not transcribed. Lines already final stay saved. | M2 (M2-T6 gap rows, T15 audio backup, T16 gap re-run) |
| Silence-gated streaming with a pre-roll buffer | A session stays open, billed, through silence while chunks flow (only a source that sends nothing closes, after 30 s; the 15-minute no-speech stop bounds the rest). Opening only while someone speaks needs voice detection and a pre-roll so first words are kept. | M3 (M3-T20) |
| Speech-to-text usage upload | Each meeting's usage stays in the Mac's `stt_usage` table and the logs. | M3 (M3-T19a, T19b) |
| Warning when a live stream carries only silence | A stream that hears nothing still looks live. | M2 |
| MCP transcript slicing | `get_transcript` returns the whole call in one block, so a long enough call can exceed an MCP client's output cap. | M7 |
| Automated tests for the renderer capture code | `getUserMedia`, `getDisplayMedia` and the worklet wiring are only checked by a real call. The controller's start and stop rules run against fake devices. | M2 |
| Lockfile packages published less than 7 days before 2026-10-05 | electron 44.5.1, mcp 2.3.0, vitest 5.0.3, eslint 10.12.0 and others are inside the usual quarantine window. | Re-check at the next dependency bump |

## Exit check log

**2026-10-05, automated checks (Linux, Postgres 16):** `make check` green.

| App | Lint and format | Typecheck | Tests |
| --- | --- | --- | --- |
| api | ruff: all checks passed, 51 files formatted | mypy strict: no issues in 50 files | 142 passed |
| desktop | eslint clean, prettier clean | tsc clean for node, web and worklet configs | 59 passed |

Also done: `electron-vite build` succeeds and the page bundle contains no worklet code (the
worklet ships as its own asset); the API ran live with health, meetings, segments, transcript,
STT token and MCP (initialize, tools/list, tools/call) exercised over HTTP; an independent code
review of the desktop app found one blocker (worklet code pulled into the page bundle) and five
should-fixes, all fixed with regression tests.

**2026-10-05/06, first real Mac (macOS 26.6.2, Apple Silicon, Postgres 16 in Docker):**

- `make check` green on the Mac. After the wrap-up fixes: api 135 passed, desktop 93 passed, and
  `make setup` works with no flags under a global uv `exclude-newer` and pnpm
  `auto-install-peers=false` (see the CLAUDE.md failure log).
- The packaged `Roger.app` (`make install-desktop`), with `STT_PROVIDER=fake`, captured both
  streams: one test meeting stored 10 lines in Postgres, 4 from the mic and 6 from system audio
  played from YouTube. So the system audio track does survive stopping the desktop video track.
- Claude Code, connected to `/mcp` with the bearer header, read that meeting through
  `get_transcript` and quoted its first "Them" line with the right timestamp.
- macOS checks three privacy services for Roger, as the `tccd` log shows: Microphone,
  ScreenCapture and AudioCapture. Call audio needs Screen & System Audio Recording turned on for
  Roger, applied after a relaunch.
- Trap found and fixed: an ad-hoc signed rebuild lost call audio ("No screen source is available
  for system audio") because macOS pins grants to the code hash. `install:mac` now signs with a
  stable per-Mac identity.
- In dev mode the terminal is the app macOS checks, and no common terminal carries
  `NSAudioCaptureUsageDescription`, so call audio must be tested from the installed app.

**2026-10-06, field report: grants lost after a restart (M2-T1, read from the `tccd` log):**

- Symptoms: after a restart the installed app said it could not detect system audio, and it
  asked for the mic again although System Settings showed Roger allowed.
- The log names the cause: 11 lines of `Failed to match existing code requirement for subject
  ai.linkt.roger and service ...`, one at 11:46 and the rest from 14:12 to 14:15, for
  `kTCCServiceMicrophone` (then a new mic prompt), `kTCCServiceScreenCapture` and
  `kTCCServiceAudioCapture`. Those builds were ad-hoc signed (`cdhash H"..."`), so each rebuild
  changed the requirement the grants were pinned to. With ScreenCapture refused,
  `desktopCapturer.getSources` returns nothing, hence "No screen source is available for system
  audio".
- 14:22:55: TCC deleted Roger's three records (`install-mac.sh` resets them when the signing
  identity changes). The app installed at 14:24 is signed `identifier "ai.linkt.roger" and
  certificate leaf = H"b457..."`, which survives rebuilds (commit 30e137c). At 16:56 the log had
  no mismatch line for Roger since that install.
- Two copies of Roger.app exist, `/Applications` and `apps/desktop/dist/mac-arm64`; only the
  `/Applications` one is launched.
- Both launches in that window (14:15 and 14:24) also logged an Error-level `attempted to call
  TCCAccessRequest for kTCCServiceAccessibility without the recommended ... entitlement`. Roger's
  code asks for no Accessibility access; the line comes from Electron at launch and is not a grant
  problem.
- Recipe (compare a hit with `codesign -d -r- /Applications/Roger.app`):

  ```bash
  /usr/bin/log show --last 1d \
    --predicate 'subsystem == "com.apple.TCC" AND eventMessage CONTAINS[c] "roger"' \
    | grep 'Failed to match existing code requirement'
  ```
- The app can now read its own signature: `src/main/signing.ts` reports `local-identity`,
  `developer-id`, `adhoc` or `unsigned` and a hash of the requirement, which "system audio
  verified" is stored against. M2-T10 and M2-T19 call it at startup.

**Pending: M2-T1's Mac check (a person).** On the installed app: Start, grant, quit, relaunch,
Start again. Pass: no new prompt, call audio present, and the recipe above shows no new mismatch
line. Then open each link in `src/main/settingsPanes.ts` on macOS 26 and record where it lands in
the M2 exit check log.

**Pending: the real-call check.** A 30-minute Google Meet call with `STT_PROVIDER=assemblyai` and
an AssemblyAI key on the API (owner decision, 2026-10-06: AssemblyAI replaces Deepgram as the
vendor for this check because it lists Granola as a customer, live text is about $0.15 per hour and
the free hours are generous; Deepgram stays as the second adapter), then Claude quoting a line from
it through MCP. Record the line here.

## Review

Engineer: pending.
