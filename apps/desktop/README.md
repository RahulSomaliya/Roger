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

Settings come from environment variables, with `.env` at the repo root loaded in development, or
from `config.json` in the app data folder (`~/Library/Application Support/Roger/` on macOS):

| Variable | config.json key | Meaning |
| --- | --- | --- |
| `ROGER_API_URL` | `apiUrl` | Roger API base URL. Default `http://127.0.0.1:8000`. |
| `ROGER_DESKTOP_API_TOKEN` | `apiToken` | Bearer token for the API. Required. |
| `ROGER_STT_PROVIDER` | `sttProvider` | Set to `fake` to run without the API choosing a vendor (development). |
| `ROGER_LOG_LEVEL` | `logLevel` | `debug`, `info`, `warn` or `error`. |

The local safety copy lives at `roger.sqlite` in the same app data folder.

## Layout

```
src/shared     types shared by every process: IPC contract, transcript model, PCM helpers
src/preload    the contextBridge that exposes window.roger (nothing else reaches the page)
src/main       Electron main: capture state machine, STT adapters, SQLite store, uploader, API client
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
  `electron-builder.yml`; without it macOS hands over a dead track and no error. When running from
  a terminal in development, the terminal app is the one that needs the permission.
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
```
