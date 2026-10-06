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
- Speech-to-text behind a `SpeechToText` interface: a Deepgram streaming adapter and a fake adapter
  for development and tests. Vendor key stays on the API; the desktop gets a short-lived token.
- Transcript lines saved to local SQLite the moment they are final, then uploaded in batches with
  retry. Postgres is the source of truth.
- API: meetings, segments, transcript read, STT token, health. Alembic migrations.
- MCP server in the API: one tool, `get_transcript`.
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
| STT vendor for M1 | Deepgram nova-3 streaming (`linear16`, 16 kHz, `interim_results`, `KeepAlive` every 5 s, `Finalize` then `CloseStream` on stop) | AssemblyAI, OpenAI Realtime | Documented short-lived token grant and a simple binary websocket. Bake-off is M3. |
| Token flow | `POST /v1/stt/token` returns provider + 30 s token + stream settings | Key in the desktop `.env` | House rule 3. Also makes "swap vendor" an API config change. |
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
- [x] `apps/desktop`: `CaptureSession` state machine, SQLite store, uploader, API client with tests.
- [x] `apps/desktop`: electron-builder config with `NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription`.
- [ ] Exit check on a real call (needs a Mac).

## Tests

| What | Test |
| --- | --- |
| API auth on every non-public route, meetings, idempotent segments, transcript ordering, end, health | `apps/api/tests/test_auth.py`, `test_meetings.py`, `test_health.py` |
| STT token issuing (fake and Deepgram via mocked HTTP) | `apps/api/tests/test_stt_token.py` |
| MCP tool through the SDK client, both handshakes; the text read never selects word timings | `apps/api/tests/test_mcp.py` |
| PCM conversion and chunking | `apps/desktop/src/shared/pcm.test.ts`, `src/renderer/src/audio/PcmChunker.test.ts` |
| Deepgram message parsing to `SttEvent` | `apps/desktop/src/main/stt/deepgram/messages.test.ts` |
| Deepgram adapter against a local fake websocket server | `apps/desktop/src/main/stt/deepgram/DeepgramSpeechToText.test.ts` |
| Capture state machine, partial-open cleanup, mid-call stream failure, finals during close | `apps/desktop/src/main/capture/CaptureService.test.ts`, `CaptureSession.test.ts` |
| SQLite store append, unsynced query, mark synced, rejected lines, crash recovery, restart | `apps/desktop/src/main/store/SqliteTranscriptStore.test.ts` |
| Uploader batching, retry, ordering, 422 quarantine, lost-meeting resync | `apps/desktop/src/main/upload/TranscriptUploader.test.ts` |
| Renderer payload validation (odd-length and oversized chunks) | `apps/desktop/src/main/ipc-validation.test.ts` |
| API client request shapes and error mapping | `apps/desktop/src/main/api/ApiClient.test.ts` |

## Risks

| Risk | Signal | Response |
| --- | --- | --- |
| Electron's system audio path shows a Screen Recording prompt or delivers a dead track | Track `readyState` is `ended` at start, or zero chunks from the system stream in 5 s | The UI shows "no system audio". Plan B is a Swift helper behind the same `SystemAudioSource` seam (M2). |
| Deepgram token TTL (30 s) expires before the socket opens on slow networks | 401 on connect | Fetch the token right before connecting; the API TTL is a setting. |
| API down mid-call | Uploader backoff visible in status line ("12 lines waiting") | Rows stay local with `synced_at NULL`; uploader resumes. Meeting `end` is retried too. |
| Vendor message format drifts | Parsing tests fail; unknown message types are logged, not fatal | Adapter isolates the shape. |

## Known gaps carried forward

The M1 wrap-up left these alone on purpose. Each has an owner.

| Gap | What happens today | Owner |
| --- | --- | --- |
| Deepgram reconnect after a network blip | A dropped socket ends that stream for the rest of the call, with a visible failure. Lines already final stay saved. | M2 |
| Warning when a live stream carries only silence | A stream that hears nothing still looks live. | M2 |
| MCP transcript slicing | `get_transcript` returns the whole call in one block, so a long enough call can exceed an MCP client's output cap. | M7 |
| Automated tests for the renderer capture code | `getUserMedia`, `getDisplayMedia` and the worklet wiring are only checked by a real call. | M2 |
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

**Pending: the real-call check.** A 30-minute Google Meet call with `STT_PROVIDER=deepgram` and a
Deepgram key on the API, then Claude quoting a line from it through MCP. Record the line here.

## Review

Engineer: pending.
