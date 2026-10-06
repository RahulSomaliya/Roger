# Roger desktop

Electron + React + TypeScript. Captures the mic and the call audio as two streams, streams both
to speech-to-text, saves every final line to a local SQLite file, and uploads it to the Roger API.

## Run

```bash
# from the repo root
cp .env.example .env         # set ROGER_DESKTOP_API_TOKEN to the API's ROGER_API_TOKEN
make dev-api                 # API on http://127.0.0.1:8000
make dev-desktop             # this app, with hot reload
```

Dev mode started from cmux, iTerm2 or Terminal.app gets no call audio on macOS (see macOS notes).
To test a real call, install the packaged app:

```bash
make install-desktop         # or `pnpm install:mac` in apps/desktop
```

It builds Roger.app for this Mac's architecture, signs it with a per-Mac local identity, quits a
running Roger and
replaces `/Applications/Roger.app`, then prints how to launch it with a log file.

In dev mode settings come from environment variables, with the `ROGER_*` keys of the repo-root
`.env` loaded. The packaged app sees neither: started from Finder or `open`, it reads
`config.json` in its app data folder, `~/Library/Application Support/Roger/config.json`
(environment variables still win when present):

```json
{ "apiUrl": "http://127.0.0.1:8000", "apiToken": "<the API's ROGER_API_TOKEN>" }
```

A `config.json` that exists but cannot be read or parsed is logged, and named in the start-up
error when it leaves Roger without an API token. The keys:

| Variable                  | config.json key | Meaning                                                               |
| ------------------------- | --------------- | --------------------------------------------------------------------- |
| `ROGER_API_URL`           | `apiUrl`        | Roger API base URL. Default `http://127.0.0.1:8000`.                  |
| `ROGER_DESKTOP_API_TOKEN` | `apiToken`      | Bearer token for the API. Required.                                   |
| `ROGER_STT_PROVIDER`      | `sttProvider`   | Set to `fake` to run without the API choosing a vendor (development). |
| `ROGER_LOG_LEVEL`         | `logLevel`      | `debug`, `info`, `warn` or `error`.                                   |

The cost guards below take their keys and variables the same way.

The local safety copy lives at `roger.sqlite` in the same app data folder. On launch, any meeting a
crash or force-quit left open is ended at its last line, and the uploader resumes where it stopped.
A meeting reaches Postgres with its first line; one stopped before anyone spoke leaves no trace
there. Each meeting's speech-to-text use is kept in its `stt_usage` table (see Cost guards).

A packaged app logs JSON lines to stderr only, so start it with its log in a file:

```bash
mkdir -p ~/Library/Logs/Roger
open --stdout ~/Library/Logs/Roger/stdout.log --stderr ~/Library/Logs/Roger/roger.log /Applications/Roger.app
tail -f ~/Library/Logs/Roger/roger.log
```

## Cost guards

AssemblyAI bills every second a speech-to-text session is open, silent or not: $0.15 an hour per
stream, and every meeting runs two (mic and call audio). A recording forgotten overnight costs
about $4.20; one socket nobody closed runs to the vendor's 3-hour cap, $0.45. So Roger never keeps
a session open that nobody needs. Every number lives in `src/main/costGuards.ts`; each can be set
in `config.json` (the key, a whole number) or with its `ROGER_*` variable, which wins. A value out
of range blocks Start with an error naming it: a typo never loosens a guard.

| Guard               | config.json key / variable                                              | Default                                   | Why                                                                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stall close         | `sttStallCloseSeconds` / `ROGER_STT_STALL_CLOSE_SECONDS`                | 30 s (10 to 300)                          | A source that sends no chunk at all has a dead capture path but its session bills like a live one. Its session closes ("paused, no audio") and reopens with its next chunk. After the 5 s "no audio" warning.                         |
| Reopen buffer       | `sttReopenBufferSeconds` / `ROGER_STT_REOPEN_BUFFER_SECONDS`            | 3 s (1 to 10)                             | Audio that arrives while a session reopens is held and sent in order, so the chunk that woke it is not lost. Kept short: it is sent at once, and AssemblyAI closes a session sent audio faster than real time (3007).                 |
| Opens per minute    | `sttOpensPerMinute` / `ROGER_STT_OPENS_PER_MINUTE`                      | 4 (2 to 100)                              | Every session open (Start's two, every reopen, both sources) passes one limiter. AssemblyAI starts 5 a minute on a free account and refuses the next after the handshake. Counted across meetings, as the vendor does.                |
| Opens per meeting   | `sttOpensPerMeeting` / `ROGER_STT_OPENS_PER_MEETING`                    | 30 (2 to 1000)                            | Bounds a reopen loop against a vendor that keeps failing. Past it the source stays closed with an error saying why.                                                                                                                   |
| Reopen backoff      | `sttReopenBackoffSeconds` / `ROGER_STT_REOPEN_BACKOFF_SECONDS`          | 2 s (1 to 60)                             | After the vendor ends a session mid-call (an error, a dropped socket, the 3-hour cap), wait before reopening, doubling per failure in a row. A stream that stayed up a minute starts over.                                            |
| Reopen backoff cap  | `sttReopenBackoffMaxSeconds` / `ROGER_STT_REOPEN_BACKOFF_MAX_SECONDS`   | 60 s (1 to 600, at least the backoff)     | The longest wait between reopens: about one try a minute until the per-meeting cap.                                                                                                                                                   |
| No-speech stop      | `noSpeechStopSeconds` / `ROGER_NO_SPEECH_STOP_SECONDS`                  | 900 s, 15 min (60 to 14400)               | A forgotten Stop with silence still flowing (a muted mic, call audio without its permission) never trips the stall close. No final line from either source for 15 minutes stops the recording, with a notice.                         |
| Recording cap       | `maxRecordingSeconds` / `ROGER_MAX_RECORDING_SECONDS`                   | 14400 s, 4 h (60 to 86400)                | Hard cap per recording, even with speech (a TV left on): past any real meeting, $1.20 for both streams.                                                                                                                               |
| Quit wait           | `quitStopTimeoutSeconds` / `ROGER_QUIT_STOP_TIMEOUT_SECONDS`            | 5 s (1 to 30)                             | Quitting while recording runs the normal stop, but never hangs the quit: after 5 s the app exits and process exit closes the sockets.                                                                                                 |
| Vendor idle timeout | `sttVendorIdleTimeoutSeconds` / `ROGER_STT_VENDOR_IDLE_TIMEOUT_SECONDS` | 120 s (10 to 3600, above the stall close) | Sent as AssemblyAI's `inactivity_timeout` on every stream: the vendor closes a session that received nothing for this long. Only fires when Roger cannot act (the Mac slept with the socket half-open). Deepgram has no such setting. |

Fixed behaviour, not settings:

| Guard                     | What happens                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed or ended source    | Its session closes at once ("not connected"); the other source keeps going. It does not reopen: a dead track never comes back.                                                                                                                                                                                                                  |
| Keep-alive                | Deepgram's KeepAlive is sent only while the stream is open and its source sent audio within the stall window, so a stalled stream is never kept alive.                                                                                                                                                                                          |
| Vendor session cap        | The API asks AssemblyAI for `max_session_duration_seconds=10800` on every token (the vendor's maximum, explicit). At it the vendor closes with 3008 and Roger reopens a fresh session.                                                                                                                                                          |
| Quit, sleep, close, crash | Quit (Cmd+Q included), the Mac going to sleep, the window closing, the renderer crashing or reloading all stop the recording through the normal stop, logged and kept as the meeting's `stt_usage.stop_reason`. Sleep, a crash or a reload leave a notice saying why; quit and a closed window (which quits Roger) leave no window to show one. |
| Connect and close         | A connect times out after 10 s; Stop terminates any socket the vendor has not closed 5 s after the finish sequence (`SttConnection`).                                                                                                                                                                                                           |

What it cost shows in the status panel ("AssemblyAI · 12m 30s connected · about $0.06", sessions,
audio and each source in its tooltip; "Last recording" after Stop), in the log (`stt meter` after
every session that closes mid-meeting, `stt meter at stop` with the reason) and in `roger.sqlite`'s
`stt_usage` table, one row per meeting, kept even when the meeting itself is discarded. The cost is
an estimate from the price the API returns (`stream.price_per_hour_usd`). Nothing is uploaded yet
(M3).

## Layout

```
src/shared     types shared by every process: IPC contract, transcript model, PCM helpers
src/preload    the contextBridge that exposes window.roger (nothing else reaches the page)
src/main       Electron main: capture state machine, STT adapters, SQLite store, uploader, API client,
               the window and what its page may do (page-policy.ts)
src/renderer   React UI and audio capture (getUserMedia, desktop capture, AudioWorklet)
```

Data flow: renderer worklet → `audio:chunk` IPC → `CaptureService` → one `SttStream` per source →
final lines into `SqliteTranscriptStore` → `TranscriptUploader` → `POST /v1/meetings/{id}/segments`.

## Speech-to-text vendors

Adapters implement `SpeechToText` in `src/main/stt/SpeechToText.ts`. The API's `/v1/stt/token`
response names the provider; `createSpeechToText` looks it up in the registry,
`src/main/stt/registry.ts`.

Vendors bill a session for as long as its socket is open (AssemblyAI by the second, silent or not),
so no adapter manages a socket. A websocket vendor only describes its protocol (`SttProtocol` in
`src/main/stt/core/SttProtocol.ts`: URL and auth, ready signal, audio framing, keep-alive, how to
read a message, the finish sequence and its completion signal, what close codes mean).
`SttConnection` (`src/main/stt/core/SttConnection.ts`) runs the one lifecycle for all of them:
connecting → open → finishing → closed, one connect timeout over the handshake and the ready signal,
audio dropped and counted outside open, Stop sends the finish sequence and terminates any socket
still open after a hard timeout (5 s) whatever the vendor does, close is idempotent, a vendor close
mid-call is one error then one "closed", keep-alive only while open and audio flowed within the stall
window. Whether a session opens or reopens at all is `CaptureSession`'s call, through the open budget
(see Cost guards); an adapter never opens one itself. It meters each stream
(connected ms from the handshake, audio ms sent) and logs both with an estimated cost at the price
the API names (`stream.price_per_hour_usd`) when the stream closes.
`src/main/stt/conformance.test.ts` runs the same contract against every registered network vendor
and a local fake vendor, and fails if any test leaves a socket open. Shipping adapters:

- `assemblyai`: Roger's vendor since 2026-10-06 (owner decision). Universal-Streaming v3
  websocket; the API's temporary token goes in the `token` query parameter. Audio is sent as
  binary PCM in 50 to 1000 ms messages (AssemblyAI closes the session otherwise; the short tail
  on Stop is padded with silence). With `format_turns` a finished turn arrives twice, raw then
  formatted: the adapter saves one line per `turn_order`, formatted when that copy comes within
  2 s. On stop: Terminate, then wait for Termination (5 s cap). Every stream sets
  `inactivity_timeout` (120 s), and the API's token caps each session at 3 hours, after which
  Roger reopens a fresh one. AssemblyAI bills the time a session is open, so a silent system
  stream costs as much as a live one: the cost guards close it. A free account may start only 5
  sessions a minute and every Start opens two; Roger's own limit (4 a minute) refuses a third
  quick Start before the vendor would, and says when to try.
- `deepgram`: the second adapter (M3 bake-off). Streaming websocket, bearer token minted by the
  API, KeepAlive every 5 s only while its source sends audio, Finalize + CloseStream on stop.
- `fake`: no network. Emits one line per two seconds of non-silent audio. Used by tests and by
  `ROGER_STT_PROVIDER=fake`.

### Add a speech-to-text vendor

Both apps change together, in one commit with `docs/api-contract.md` (house rule 8).

Desktop:

1. One protocol file, `src/main/stt/<vendor>/<Vendor>SpeechToText.ts`: a `<vendor>Protocol()`
   returning an `SttProtocol`, and a class that only passes it to `WebSocketSpeechToText`. Put the
   wire parser in `messages.ts` beside it, reading every field from `unknown` (`src/main/stt/json.ts`)
   and returning `invalid` rather than throwing. Never open, time or close a socket there.
2. Map Roger's `linear16` / 16000 Hz to the vendor's names, and cite the vendor docs you relied on,
   with the date read, in the file header (close codes, rate limits, billing).
3. One line in `src/main/stt/registry.ts`.
4. One entry in `src/main/stt/testing/conformanceVendors.ts`: how the vendor says ready, its finish
   messages and answer, a final line, a real mid-call close. The answer must match the protocol's
   `finishedOn`: the fake closes the socket itself exactly when it declares `vendor-close`. Then
   `pnpm test`: the conformance suite fails until the vendor closes every socket on every path.

API:

5. One `SttTokenIssuer` in `apps/api/src/roger_api/services/stt_tokens.py` that mints a
   short-lived token (the vendor key never leaves the API), with tests on `httpx.MockTransport`.
6. The provider id in `SttProvider` (`apps/api/src/roger_api/domain.py`), its key setting
   (`<VENDOR>_API_KEY`) and a case in `Settings.stt_vendor_key` (`config.py`).
7. One entry in `STT_VENDORS` (`apps/api/src/roger_api/stt_vendors.py`): issuer, default model,
   model-name prefix, the vendor's token TTL limit, and the list price per stream-hour by model,
   with the pricing URL and the date read. Say whether the vendor bills open time or audio sent.
8. `.env.example`, `apps/api/README.md` and the provider table in `docs/api-contract.md`.

Before relying on it: know the vendor's sessions-per-minute limit (every Start opens two), what it
bills for a silent stream, and whether it can be asked to close an idle session itself (pass
`vendorIdleTimeoutMs` through to its URL, as AssemblyAI's `inactivity_timeout` does).

## macOS notes

- The main process asks for microphone access before the renderer calls `getUserMedia`.
- System audio uses Chromium's desktop capture, which on macOS 14.2+ is a Core Audio tap gated by
  the "System Audio Recording" permission. `NSAudioCaptureUsageDescription` is set in
  `electron-builder.yml`; without it macOS hands over a dead track and no error.
- In dev mode (`make dev-desktop`) the process macOS checks is the terminal, not Roger. cmux,
  iTerm2 and Terminal.app have no `NSAudioCaptureUsageDescription`, so the system audio ("Them")
  stream is dead with no error from macOS. Its row may well keep counting "s captured": the
  "no audio for over 5 s" warning (and, after 30 s, closing its session) fires only when no audio
  arrives at all (the renderer, its worklet or IPC stopped), not for a live stream of silence,
  which is M2's silence warning; the 15-minute no-speech stop bounds that one.
  Test call audio with `make install-desktop`: the packaged app carries the key.
- Verified on 2026-10-05: the packaged Roger.app on macOS 26.6.2 (Apple Silicon)
  captured both streams, with the API on `STT_PROVIDER=fake`.
- The local install is signed without the hardened runtime: a signature with no Apple team id
  dies at launch with it (`Electron Framework ... not valid for use in process`), because library
  validation needs a team id. Signing proper is M11.
- It is signed with a self-signed identity that `install:mac` creates once per Mac in
  `~/Library/Application Support/Roger Dev Signing/`, never ad hoc. macOS pins every privacy grant
  to the app's code identity. An ad-hoc identity is the code hash, which changes on each build:
  after a rebuild macOS silently denied call audio ("No screen source is available for system
  audio") while System Settings still showed Roger switched on (2026-10-06). When the identity
  changes, `install:mac` clears Roger's old grants with `tccutil reset` so macOS asks again once.
- Call audio uses Chromium's desktop capture, so macOS needs both **Screen & System Audio
  Recording** and **Microphone** for Roger. macOS applies a new Screen Recording grant only after
  Roger restarts.
- Which prompts macOS shows (Microphone, System Audio Recording, Screen Recording) is recorded in
  `docs/plans/M1-walking-skeleton.md` once the exit check runs. A Swift helper is the fallback if
  the built-in path proves unreliable; it would replace `openSystemAudioStream` only.

## Checks

```bash
pnpm typecheck   # tsc for the node and web tsconfigs
pnpm lint        # eslint (type-aware)
pnpm format:check
pnpm test        # vitest
pnpm build       # electron-vite build into out/
pnpm package:mac # unsigned .dmg/.zip in dist/ (signing is M11)
pnpm install:mac # build, sign with the local identity, replace /Applications/Roger.app
```
