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
| Where audio is turned into PCM | Renderer, one `AudioContext({sampleRate: 16000})` per stream feeding an `AudioWorklet` that emits Int16 chunks of 1600 samples (100 ms) | `MediaRecorder` with WebM | Vendors want raw linear16 at 16 kHz; letting Chromium resample avoids a hand-written resampler. Pattern from openwhispr. |
| Where STT and persistence live | Main process | Renderer | Main owns secrets, sockets and files. Renderer stays display-only (house rule 5). |
| STT event shape | Our own `SttEvent` union (`interim`, `final`, `error`, `closed`), vendor messages parsed inside the adapter | Pass vendor JSON through | One normalised shape keeps the session, store and UI vendor-free (anarlog's `StreamResponse`). |
| STT vendor for M1 | Deepgram nova-3 streaming (`linear16`, 16 kHz, `interim_results`, `KeepAlive` every 5 s, `Finalize` then `CloseStream` on stop) | AssemblyAI, OpenAI Realtime | Documented short-lived token grant and a simple binary websocket. Bake-off is M3. |
| Token flow | `POST /v1/stt/token` returns provider + 30 s token + stream settings | Key in the desktop `.env` | House rule 3. Also makes "swap vendor" an API config change. |
| Local safety copy | `node:sqlite` (built into Electron 44's Node), WAL, append-only `segments` rows with `synced_at` | `better-sqlite3` | No native rebuild, no ABI mismatch between vitest and Electron. |
| Upload | `TranscriptUploader` polls unsynced rows every 2 s, batches up to 200, exponential backoff on failure, marks `synced_at` | Upload each segment as it arrives | Fewer requests, same guarantee: nothing is lost locally. |
| Ids | Desktop generates UUIDv4 for meetings and segments; API upserts | Server ids | Retries and replays are safe (house rule 7). |
| MCP auth | Bearer middleware with the shared secret on `/mcp` | SDK `TokenVerifier` + OAuth | OAuth is M7. A plain header works with `claude mcp add --header` today. |
| MCP mounting | `mcp.streamable_http_app()` mounted at `/` after the REST routes, session manager entered in the FastAPI lifespan | Separate process | One deploy, one auth story. |

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
| API auth, meetings, idempotent segments, transcript ordering, end, health | `apps/api/tests/test_meetings.py`, `test_health.py` |
| STT token issuing (fake and Deepgram via mocked HTTP) | `apps/api/tests/test_stt_token.py` |
| MCP tool through the SDK client, including auth rejection | `apps/api/tests/test_mcp.py` |
| PCM conversion and downsampling | `apps/desktop/src/shared/pcm.test.ts` |
| Deepgram message parsing to `SttEvent` | `apps/desktop/src/main/stt/deepgram/messages.test.ts` |
| Deepgram adapter against a local fake websocket server | `apps/desktop/src/main/stt/deepgram/DeepgramSpeechToText.test.ts` |
| Capture session state machine with fake STT and in-memory store | `apps/desktop/src/main/capture/CaptureSession.test.ts` |
| SQLite store append, unsynced query, mark synced, restart recovery | `apps/desktop/src/main/store/SqliteTranscriptStore.test.ts` |
| Uploader batching, retry, ordering | `apps/desktop/src/main/upload/TranscriptUploader.test.ts` |
| API client request shapes and error mapping | `apps/desktop/src/main/api/ApiClient.test.ts` |

## Risks

| Risk | Signal | Response |
| --- | --- | --- |
| Electron's system audio path shows a Screen Recording prompt or delivers a dead track | Track `readyState` is `ended` at start, or zero chunks from the system stream in 5 s | The UI shows "no system audio". Plan B is a Swift helper behind the same `SystemAudioSource` seam (M2). |
| Deepgram token TTL (30 s) expires before the socket opens on slow networks | 401 on connect | Fetch the token right before connecting; the API TTL is a setting. |
| API down mid-call | Uploader backoff visible in status line ("12 lines waiting") | Rows stay local with `synced_at NULL`; uploader resumes. Meeting `end` is retried too. |
| Vendor message format drifts | Parsing tests fail; unknown message types are logged, not fatal | Adapter isolates the shape. |

## Exit check log

Pending: needs a Mac with macOS 14.2+ and a Deepgram key on the API. Record the macOS permission
prompts shown (Microphone, System Audio Recording, Screen Recording?) here when it runs.

## Review

Engineer: pending.
