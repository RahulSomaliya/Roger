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

It builds Roger.app for this Mac's architecture, signs it ad hoc, quits a running Roger and
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

The local safety copy lives at `roger.sqlite` in the same app data folder. On launch, any meeting a
crash or force-quit left open is ended at its last line, and the uploader resumes where it stopped.
A meeting reaches Postgres with its first line; one stopped before anyone spoke leaves no trace.

A packaged app logs JSON lines to stderr only, so start it with its log in a file:

```bash
mkdir -p ~/Library/Logs/Roger
open --stdout ~/Library/Logs/Roger/stdout.log --stderr ~/Library/Logs/Roger/roger.log /Applications/Roger.app
tail -f ~/Library/Logs/Roger/roger.log
```

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
response names the provider; `createSpeechToText` picks the adapter. Shipping adapters:

- `deepgram`: streaming websocket, bearer token minted by the API, KeepAlive every 5 s,
  Finalize + CloseStream on stop.
- `fake`: no network. Emits one line per two seconds of non-silent audio. Used by tests and by
  `ROGER_STT_PROVIDER=fake`.

## macOS notes

- The main process asks for microphone access before the renderer calls `getUserMedia`.
- System audio uses Chromium's desktop capture, which on macOS 14.2+ is a Core Audio tap gated by
  the "System Audio Recording" permission. `NSAudioCaptureUsageDescription` is set in
  `electron-builder.yml`; without it macOS hands over a dead track and no error.
- In dev mode (`make dev-desktop`) the process macOS checks is the terminal, not Roger. cmux,
  iTerm2 and Terminal.app have no `NSAudioCaptureUsageDescription`, so the system audio ("Them")
  stream is dead with no error from macOS. Its row may well keep counting "s captured": the
  "no audio for over 5 s" warning fires only when no audio arrives at all (the renderer, its
  worklet or IPC stopped), not for a live stream of silence, which is M2's silence warning.
  Test call audio with `make install-desktop`: the packaged app carries the key.
- Verified on 2026-10-05: the packaged, ad hoc signed Roger.app on macOS 26.6.2 (Apple Silicon)
  captured both streams, with the API on `STT_PROVIDER=fake`.
- The local install is signed ad hoc without the hardened runtime: an ad hoc signature with it
  dies at launch (`Electron Framework ... not valid for use in process`), because library
  validation needs a team id. Each build has a new code hash, so macOS asks for Microphone and
  System Audio Recording again after every install. Signing proper is M11.
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
pnpm install:mac # build, sign ad hoc and replace /Applications/Roger.app
```
