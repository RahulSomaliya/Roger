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

The cost guards below take their keys and variables the same way. The capture settings are
`config.json` keys only, with no environment variable. A value of the wrong type or out of range
keeps its default and blocks Start with an error naming the key, as a cost guard does:

| config.json key      | Default       | Meaning                                                                                                                                                                                               |
| -------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `systemAudioCapture` | `"auto"`      | How call audio is captured. `"auto"`: the helper's tap when its binary exists, else Electron's desktop capture. `"tap"`: the helper only, and Start fails without it. `"electron"`: never the helper. |
| `audioBackup`        | `true`        | Keep each call's audio on this Mac (see Audio backup). `false`, or a retention of 0, keeps none.                                                                                                      |
| `audioRetentionDays` | `7` (0 to 30) | Days a call's audio is kept. 0 turns the backup off.                                                                                                                                                  |
| `callDetection`      | `true`        | Offer to take notes when a call app uses the mic, and stop the recording when the call ends. `false` turns off both.                                                                                  |
| `echoFilter`         | `true`        | Hide mic lines that repeat call audio (laptop speakers). Known headphones turn it off for the lines said while they played.                                                                           |

No key names the helper binary, here or anywhere in `config.json`: a config file must never choose
the program that hears every call. Roger runs the helper bundled in the app, or, unpackaged, the
dev build.

The local safety copy lives at `roger.sqlite` in the same app data folder. On launch, a meeting
Roger was recording under 10 minutes ago may resume (see Crash resume); any other meeting a crash
or force-quit left open is ended at its last line, and the uploader resumes where it stopped.
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
| Reopen buffer       | `sttReopenBufferSeconds` / `ROGER_STT_REOPEN_BUFFER_SECONDS`            | 3 s (1 to 10)                             | Audio that arrives while a session reopens is held and sent in order, so the chunk that woke it is not lost. Kept short: it is paced at 1x (AssemblyAI takes nothing faster, 3007) and adds its own length of lag to that session.    |
| Opens per minute    | `sttOpensPerMinute` / `ROGER_STT_OPENS_PER_MINUTE`                      | 4 (2 to 100)                              | Every session open (Start's two, every reopen, both sources) passes one limiter. AssemblyAI starts 5 a minute on a free account and refuses the next after the handshake. Counted across meetings, as the vendor does.                |
| Opens per meeting   | `sttOpensPerMeeting` / `ROGER_STT_OPENS_PER_MEETING`                    | 30 (2 to 1000)                            | Bounds a reopen loop against a vendor that keeps failing. Past it the source stays closed with an error saying why.                                                                                                                   |
| Reopen backoff      | `sttReopenBackoffSeconds` / `ROGER_STT_REOPEN_BACKOFF_SECONDS`          | 2 s (1 to 60)                             | After the vendor ends a session mid-call (an error, a dropped socket, the 3-hour cap), wait before reopening, doubling per failure in a row. A stream that stayed up a minute starts over.                                            |
| Reopen backoff cap  | `sttReopenBackoffMaxSeconds` / `ROGER_STT_REOPEN_BACKOFF_MAX_SECONDS`   | 60 s (1 to 600, at least the backoff)     | The longest wait between reopens: about one try a minute until the per-meeting cap.                                                                                                                                                   |
| No-speech stop      | `noSpeechStopSeconds` / `ROGER_NO_SPEECH_STOP_SECONDS`                  | 900 s, 15 min (60 to 14400)               | A forgotten Stop with silence still flowing (a muted mic, call audio without its permission) never trips the stall close. No final line from either source for 15 minutes stops the recording, with a notice.                         |
| Recording cap       | `maxRecordingSeconds` / `ROGER_MAX_RECORDING_SECONDS`                   | 14400 s, 4 h (60 to 86400)                | Hard cap per recording, even with speech (a TV left on): past any real meeting, $1.20 for both streams.                                                                                                                               |
| Quit wait           | `quitStopTimeoutSeconds` / `ROGER_QUIT_STOP_TIMEOUT_SECONDS`            | 5 s (1 to 30)                             | Quitting while recording runs the normal stop, but never hangs the quit: after 5 s the app exits and process exit closes the sockets.                                                                                                 |
| Vendor idle timeout | `sttVendorIdleTimeoutSeconds` / `ROGER_STT_VENDOR_IDLE_TIMEOUT_SECONDS` | 120 s (10 to 3600, above the stall close) | Sent as AssemblyAI's `inactivity_timeout` on every stream: the vendor closes a session that received nothing for this long. Only fires when Roger cannot act (the Mac slept with the socket half-open). Deepgram has no such setting. |
| Silence close       | `sttSilenceCloseSeconds` / `ROGER_STT_SILENCE_CLOSE_SECONDS`            | 30 s (0 is off, else 10 to 3600)          | The silence gate: chunks arrive but none is speech (a muted mic, a waiting room). The session closes ("closed while silent") and reopens on speech, its token fetched while closed. Never within 60 s of an open; no gap.             |
| Silence pre-roll    | `sttSilencePreRollSeconds` / `ROGER_STT_SILENCE_PRE_ROLL_SECONDS`       | 1 s (1 to 3)                              | Audio from before the speech that reopens a gated session is sent first, so a soft first syllable is kept. Paced at 1x: that session's words show about 1 s later. With the reopen buffer, at most 10 s.                              |
| Silence reopens     | `sttSilenceReopensPerMeeting` / `ROGER_STT_SILENCE_REOPENS_PER_MEETING` | 120 (1 to 1000)                           | The gate's own reopens, both sources: each takes a per-minute slot, never one of the opens per meeting, which failures need. Past it the gate is off for that meeting, and the meter's tooltip says so.                               |

Fixed behaviour, not settings:

| Guard                  | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed or ended source | Its session closes at once ("not connected"); the other source keeps going. It does not reopen: a dead track never comes back.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Keep-alive             | Deepgram's KeepAlive and Soniox's keepalive are sent only while the stream is open and its source sent audio within the stall window, so a stalled stream is never kept alive.                                                                                                                                                                                                                                                                                                                                                                          |
| Vendor session cap     | The API asks AssemblyAI for `max_session_duration_seconds=10800` on every token and Soniox for `18000` (each vendor's maximum, explicit). At it AssemblyAI closes with 3008, Soniox sends `temp_api_key_session_expired`, and Roger reopens a fresh session.                                                                                                                                                                                                                                                                                            |
| Quit, close, reload    | Quit (Cmd+Q included) stops the recording through the normal stop, logged and kept as the meeting's `stt_usage.stop_reason`; it leaves no window to show a notice. Closing the window only hides it, and the recording goes on. A renderer crash or a reload does not stop: the page reloads and reopens the mic, and until it does the stall close shuts the mic's session after 30 s. A page that cannot be brought back, or crashes 3 times in 60 s, stops the recording (`renderer-gone`) with a notice.                                            |
| Sleep                  | Both sessions close at once when the Mac sleeps, so no socket is left half-open and billing. At wake each source reopens with its next audio, through the open budget, and the call audio helper restarts. A sleep of the no-speech stop (15 min) or longer is not a pause in a meeting: the recording stops at wake (`system-sleep`, with a notice), and the audio held since the suspend becomes a gap re-run from the backup. While recording, Roger holds a power save blocker so an idle Mac does not sleep mid-call (closing the lid still does). |
| Offline                | Both sources show `offline` within about 1 s of the network dropping. Their sockets are terminated (no finish sequence), the audio is held, and nothing reopens or fetches a token until the network is back; each source then reopens with its next audio, without a backoff wait. The window with no transcript is a gap, re-run from the backup after Stop. The no-speech stop still ends a recording after 15 minutes offline.                                                                                                                      |
| Call ended             | With `callDetection` on, a recording in which a call app was seen on the mic stops (`call-ended`, a notification) once no call app has held it for 15 s (30 s for a browser). The no-speech and 4-hour stops stay as the backstop for a recording that never saw a call app.                                                                                                                                                                                                                                                                            |
| Crash                  | A crash or `kill -9` leaves the meeting open; see Crash resume.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Connect and close      | A connect times out after 10 s; Stop terminates any socket the vendor has not closed 5 s after the finish sequence. A socket that sends a ping every 1 s while audio flows and gets neither a pong nor a message for 4 s is declared dead, and the reopen path takes over (`SttConnection`).                                                                                                                                                                                                                                                            |

What it cost shows in the status panel ("AssemblyAI · 25m 00s connected · about $0.06" for a
12½-minute call: the time sums both sources' sessions, since each bills; then what the silence gate
saved, "saved about $0.03 in silence"; sessions, audio and each source in its tooltip; each
source's own time on its row; "Last recording" after Stop), in the log (`stt meter` after every
session that closes mid-meeting, `stt meter at stop` with the reason, both with the time closed for
silence and the gate's reopens) and in `roger.sqlite`'s `stt_usage` table (the closed time as
`gated_ms`), one row per meeting, kept even when the meeting itself is discarded. The cost is an
estimate from the price the API returns (`stream.price_per_hour_usd`).
Each row goes up to the API after it changes (every 30 s while the API answers, backing off to at
most 5 min after failures, and at once after Stop), where `GET /v1/stt-usage/summary` sums the
cost per meeting hour (docs/api-contract.md, "STT usage").

## Call audio and permissions

Call audio ("Them") comes from `roger-audio`, a small Swift helper (`native/roger-audio`) that taps
the system's output with Core Audio and writes PCM to Roger. `make native` builds it for this
Mac's CPU (`make check` does too, on a Mac). In a packaged app it is
`Roger.app/Contents/Resources/bin/roger-audio`, signed by `make install-desktop` as
`ai.linkt.roger.audio` with the app's identity; `make install-desktop` fails if it is missing. The
helper also runs in monitor mode from launch to quit: it reports which apps hold the mic (for call
detection) and which output device plays, and it relaunches Roger once if Roger is killed while
recording (see Crash resume). A hung helper is killed after 3 s and restarted.

Which permissions Roger needs depends on the path:

| Path                                                                     | macOS permissions                                    |
| ------------------------------------------------------------------------ | ---------------------------------------------------- |
| With the helper (the default once it is built)                           | Microphone, and System Audio Recording only          |
| Electron's fallback (no helper, or `systemAudioCapture` is `"electron"`) | Microphone, System Audio Recording, Screen Recording |
| `systemAudioCapture` is `"tap"` and there is no helper                   | Start fails and says so                              |

Roger's setup screen (the app menu, and on first run or a Start refused for a permission) checks
each one: the microphone, call audio (it plays a short sound and listens for it), notifications (a
test one), the signing identity, and the API and the speech-to-text token (it fetches a token and
opens no vendor session). Every failure names the pane and the switch to flip.

In `make dev-desktop` the helper is the dev build when it exists (run `make native` first on a
fresh clone), and macOS attributes its tap to the terminal, so call audio is silent there just as
with Electron's path (see macOS notes): test it from the installed app.

## Audio backup and gap re-run

Every call's audio is kept on this Mac, never uploaded, so a stretch that was not transcribed can be
re-run. It lives under the app data folder in `audio/<meeting>/` (folders mode 0700, files 0600),
one file per source: written as WAV in pieces of at most 60 s and compressed to 48 kbps AAC by
`afconvert` once a piece is closed. It is kept 7 days (`audioRetentionDays`, 0 to 30), swept at
launch and hourly. Audio with a gap that has not been re-run yet is kept up to 30 days. The backup
pauses below 2 GiB of free disk (a loud warning; the text goes on) and resumes by itself. A meeting
page can delete its audio.

A gap is any stretch where a source's audio reached Roger but not the vendor: a failed or budget-
refused reopen, the network down, a sleep, or the audio a crash cut off. After Stop, and at launch
for crash tails, Roger re-transcribes each gap from the backup through a fresh session at real time,
drops words that overlap lines already saved, and saves the rest as ordinary lines. It starts only
while nothing records, takes slots from the same per-minute open budget as a live reopen, and its
connected time is added to the meeting's `stt_usage` (the vendor bills it). A gap with no audio left
stays unrecovered.

## Crash resume

The monitor helper notices when Roger dies while recording and relaunches it once (`--relaunched`).
At launch Roger resumes the same meeting, instead of ending it, when it was last seen recording
under 10 minutes ago and either this launch is that relaunch or a call app holds the mic. A resume
keeps the meeting's cost record (the `stt_usage` row carries on) and starts a fresh open allowance;
the time Roger was down has no audio, so it shows as a `resumed_after_crash` event, not as a gap, and
the window says "Roger restarted and kept taking notes", with Stop. A resume that is refused (no
microphone, no token, the vendor) ends the meeting as a crash, and Roger relaunches itself once per meeting,
so a Roger that dies on every start does not loop.

## Layout

```
src/shared     types shared by every process: IPC contract, transcript model, PCM helpers
src/preload    the contextBridge that exposes window.roger (nothing else reaches the page)
src/main       Electron main: capture state machine, STT adapters, SQLite store, uploader, API client,
               the window and what its page may do (page-policy.ts)
src/renderer   React UI and audio capture (getUserMedia, desktop capture, AudioWorklet)
native         roger-audio, the Swift audio helper (`make native`)
e2e, qa        the Electron smoke test and the browser QA scripts (qa/README.md)
```

Data flow: renderer worklet → `audio:chunk` IPC → `CaptureService` → one `SttStream` per source →
final lines into `SqliteTranscriptStore` → `TranscriptUploader` → `POST /v1/meetings/{id}/segments`.

## Speech-to-text vendors

Adapters implement `SpeechToText` in `src/main/stt/SpeechToText.ts`. The API's `/v1/stt/token`
response names the provider; `createSpeechToText` looks it up in the registry,
`src/main/stt/registry.ts`.

Vendors bill a session for as long as its socket is open (AssemblyAI by the second, silent or not),
so no adapter manages a socket. A websocket vendor only describes its protocol (`SttProtocol` in
`src/main/stt/core/SttProtocol.ts`: URL and auth, the messages it must hear before any audio,
ready signal, audio framing, keep-alive, how to read a message, the finish sequence and its
completion signal, what close codes mean).
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
- `soniox`: the optional third adapter (M3 decision D1, bake-off run D; its docs say audio and
  transcripts never train its models, read 2026-10-07). Real-time websocket, `stt-rt-v5`; the
  API's temporary key goes in `Authorization: Bearer`. The configuration is a start request, the
  first message on the socket (the protocol's opening message, which the core sends before any
  audio): `pcm_s16le` at 16 kHz, endpoint detection on, and the jargon list as `context.terms`.
  Soniox answers it with nothing, so the stream opens on the handshake, and a refused key, model
  or start request arrives after it as an error on an open stream: Start succeeds, then that
  stream fails and reopens like any failed one (its backoff, its per-meeting cap). Replies are
  single tokens: the adapter holds the final ones until Soniox marks the end of an utterance
  (`<end>`) and saves them as one line, showing the line in progress as the interim. Audio goes as
  it comes, in 50 ms to 1 s frames; a keepalive every 10 s only while its source sends audio
  (Soniox may close a session that hears nothing for 20 s). On stop: `finalize`, then an empty
  text frame, answered by `finished`. Billed for the whole time a stream is open, like AssemblyAI;
  the API's key caps a session at 5 hours.
- `fake`: no network. Emits one line per two seconds of non-silent audio. Used by tests and by
  `ROGER_STT_PROVIDER=fake`.

### Add a speech-to-text vendor

Both apps change together, in one commit with `docs/api-contract.md` (house rule 8). The one
allowed split is the API first: list the vendor in `AWAITING_A_DESKTOP_ADAPTER`
(`apps/api/tests/test_stt_providers.py`) until `registry.ts` names it, and delete it from there in
the commit that adds the adapter. Meanwhile a Start on its preset fails on the Mac. Phase 2 lands
Soniox this way (M3-T14, then M3-T15).

Desktop:

1. One protocol file, `src/main/stt/<vendor>/<Vendor>SpeechToText.ts`: a `<vendor>Protocol()`
   returning an `SttProtocol`, and a class that only passes it to `WebSocketSpeechToText`. Put the
   wire parser in `messages.ts` beside it, reading every field from `unknown` (`src/main/stt/json.ts`)
   and returning `invalid` rather than throwing. Never open, time or close a socket there.
2. Map Roger's `linear16` / 16000 Hz to the vendor's names, and cite the vendor docs you relied on,
   with the date read, in the file header (close codes, rate limits, billing). Declare
   `audioPacing`: `realtime` if the vendor closes a session sent audio faster than real time
   (AssemblyAI, 3007; the core then paces it), else `none`, and say the same in its conformance
   entry (`rejectsAudioFasterThanRealTime`). Map `settings.keyterms` (already cut to the shared
   limits in `keyterms.ts`) to the vendor's jargon parameter, and declare `keytermsRejected` for the
   refusal it gives a list it will not take (Deepgram: HTTP 400 at the handshake), with the same in
   the entry's `keyterms`; never retry it, `CaptureSession` reopens once without the list. A vendor
   that refuses nothing while it connects (Soniox) declares none, and its entry says
   `refusal: null`. Configuration that must reach the vendor before any audio goes in
   `openingMessages`, never in `encodeAudio` or the keep-alive.
3. One line in `src/main/stt/registry.ts`.
4. One entry in `src/main/stt/testing/conformanceVendors.ts`: what it must hear first, how the
   vendor says ready, its finish messages and answer, a final line, a real mid-call close. The
   answer must match the protocol's `finishedOn`: the fake closes the socket itself exactly when
   it declares `vendor-close`. Then `pnpm test`: the conformance suite fails until the vendor
   closes every socket on every path.

API:

5. One `SttTokenIssuer` in `apps/api/src/roger_api/services/stt_tokens.py` that mints a
   short-lived token (the vendor key never leaves the API), with tests on `httpx.MockTransport`.
6. The provider id in `SttProvider` (`apps/api/src/roger_api/domain.py`), its key setting
   (`<VENDOR>_API_KEY`) and a case in `Settings.stt_vendor_key` (`config.py`).
7. One entry in `STT_VENDORS` (`apps/api/src/roger_api/stt_vendors.py`): issuer, the vendor's
   token TTL limit, and the list price per stream-hour by model, with the pricing URL and the date
   read. Say whether the vendor bills open time or audio sent. Then at least one `STT_PRESETS` row
   (a preset id, the vendor, and the model spelt as the vendor spells it), its id added to
   `SttPresetId`: `STT_PROVIDER` names a preset, never a vendor, and a test fails on a vendor no
   preset names.
8. `.env.example`, and the preset tables in `apps/api/README.md` and `docs/api-contract.md` (the
   contract's list of `provider` ids too).

Before relying on it: know the vendor's sessions-per-minute limit (every Start opens two), what it
bills for a silent stream, and whether it can be asked to close an idle session itself (pass
`vendorIdleTimeoutMs` through to its URL, as AssemblyAI's `inactivity_timeout` does).

## macOS notes

- The main process asks for microphone access before the renderer calls `getUserMedia`.
- Call audio comes from the Swift helper's Core Audio tap, gated by the "System Audio Recording"
  permission only. Without a helper Roger falls back to Chromium's desktop capture, which is the
  same kind of tap and also needs Screen Recording. `NSAudioCaptureUsageDescription` is set in
  `electron-builder.yml`; without it macOS hands over a dead track and no error.
- In dev mode (`make dev-desktop`) the process macOS checks is the terminal, not Roger. cmux,
  iTerm2 and Terminal.app have no `NSAudioCaptureUsageDescription`, so the system audio ("Them")
  stream is dead with no error from macOS, and the helper's tap is attributed to the terminal in
  the same way. Its row may well keep counting "s captured": the "no audio for over 5 s" warning
  (and, after 30 s, closing its session) fires only when no audio arrives at all (the renderer, its
  worklet or IPC stopped), not for a live stream of silence. That is the call-audio silence warning:
  on screen after 8 s of digital silence, a macOS notification after 60 s while the mic hears
  speech or 180 s whatever it hears, and the 15-minute no-speech stop bounds it.
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
- With the helper, macOS needs **Microphone** and **System Audio Recording** for Roger, and no
  Screen Recording. Only Electron's fallback also needs **Screen & System Audio Recording**, and
  macOS applies a new Screen Recording grant only after Roger restarts.
- Which prompts macOS shows (Microphone, System Audio Recording, Screen Recording) is recorded in
  `docs/plans/M1-walking-skeleton.md` once the exit check runs. M2's setup screen checks each one
  and opens its System Settings pane.

## Checks

```bash
pnpm typecheck   # tsc for the node and web tsconfigs
pnpm lint        # eslint (type-aware)
pnpm format:check
pnpm test        # vitest
pnpm build       # electron-vite build into out/
pnpm package:mac # unsigned .dmg/.zip in dist/ (signing is M11)
pnpm install:mac # build, sign with the local identity, replace /Applications/Roger.app
pnpm test:mac    # the *.mac.test.ts suite: real afconvert and the real helper (macOS only)
pnpm test:e2e    # the Electron smoke test, `make e2e-desktop` from the repo root
```

From the repo root, `make check` on a Mac also builds the helper, runs `roger-audio selftest` (no
tap, no device, no privacy prompt) and `pnpm test:mac`. `make test-native-route` is not part of it:
it plays a tone and switches this Mac's default output device to prove the tap follows the switch.

`make e2e-desktop` builds the app and launches the unpackaged Electron with a temporary data
folder, a fake helper, fake audio and the fake speech-to-text vendor, and checks lines reach the
window. Each checkout fetches the Electron binary once
(`node node_modules/electron/install.js` in `apps/desktop`, when pnpm's install scripts are off).
The `*.qa.e2e.ts` files beside it are browser QA, not Electron (`qa/README.md`).
