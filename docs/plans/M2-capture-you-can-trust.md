# M2. Capture you can trust

**Phase:** 2 · **Status:** draft · **Owner:** Rahul · **Plan written:** 2026-10-06 · **Closed:** -

## Goal

Roger never loses or doubles a line, and it says so loudly when it cannot hear. Call audio comes
from a small Swift helper that needs only the System Audio Recording permission. A network blip,
AirPods, sleep, a crash or a 2-hour call no longer ends a stream, and a Roger that was killed comes
back by itself into the same meeting. Every call keeps a local audio backup for a few days, so a
part that was not transcribed can be re-run. Roger notices a call, offers to take notes, and stops
when the call ends.

## Done when

- [ ] 10 real calls in a row with no lost or doubled text, and cutting the audio mid-call triggers
  the warning within 10 seconds.

  Run on the installed app (`make install-desktop`) with `STT_PROVIDER=deepgram` on the API. The
  10 calls include: 2 on laptop speakers (echo), 1 with AirPods connected mid-call, 1 with the lid
  closed for a minute and reopened, 1 with Roger force-quit (`kill -9`) mid-call (Roger relaunches
  itself and the call stays one meeting), and at least 2 started from the "Take notes" offer. A
  2-hour soak (a long video plus reading aloud) stands in for the 2-hour call if no real one
  happens. Per call, record: the capture report (gaps, reconnects, echo lines hidden or trimmed,
  helper restarts, warnings), the local count of lines that are not hidden against
  `GET /v1/meetings/{id}/transcript`, a scan for the same words under Me and Them within 2 s, and
  3 random minutes checked against the audio backup.

  Cut the audio three ways mid-call and time each from the action to the warning (phone screen
  recording). Each warning must appear within 10 s.
  - Call audio: stop the helper (`pkill -STOP roger-audio`). Roger warns, kills and restarts it.
  - Mic: turn Roger off under System Settings, Privacy & Security, Microphone (and back on after).
    If T11's Mac check found that this does not stop the audio on this Mac, freeze the renderer
    instead (`pkill -STOP -f 'Roger Helper (Renderer)'`). Setting the input volume to 0 counts
    only if T11 found it gives digital zeros, or the flat-level rule is in place.
  - Network: turn Wi-Fi off for 30 s. Wi-Fi coming back must lose no line.

  The seconds the helper and mic cuts really lost show as gaps in the capture report. Unplugging a
  USB mic (or switching the input) is recovery, not a cut: Roger follows the new default input
  within 1 s and shows "Switched to <device>" on screen, with no loud warning. An AirPods mic that
  goes silent warns at 30 s, not 10 s (D4, an owner deviation from this line).

## In scope

- Swift helper `roger-audio`: system audio through a Core Audio process tap, and a monitor mode
  that reports which apps hold the mic and which output device is in use, and relaunches Roger if
  it dies while recording. Built, bundled and signed with the local identity. The Electron
  `desktopCapturer` path stays as a fallback.
- Permission setup screen: microphone, system audio (verified by hearing a test sound),
  notifications, signing check, API and speech-to-text reachability, each with a clear fix.
- Loud warnings: no audio, dead signal, stream ended, helper hung, transcription offline, backup
  paused. macOS notification when Roger is in the background, dock bounce when notifications fail.
- Survive: STT reconnect with replay and no lost or doubled words (M1 gap), AirPods and other
  device changes, sleep and wake, renderer, helper and app crashes, 2-hour calls.
- Upload that never strands a line: re-run, unhidden and held lines reach Postgres after the
  meeting has ended there.
- Echo fix: hide a mic line that repeats what call audio said at the same moment, trim the
  repeated words out of a mixed line, and let the user unhide a line.
- Local audio backup per call and stream, 7 days by default, never uploaded (C6). Gap re-run
  from the backup.
- Call detection: offer to take notes when a call app starts using the mic; stop when it stops.
- Silence warning for live-but-silent streams (M1 gap) and automated renderer capture tests,
  including a real-Chromium smoke test (M1 gap).

## Out of scope

- Live transcript polish, interim text, jargon list, vendor bake-off (M3).
- The app shell (sidebar, Home, meeting page). M2 builds its screens as standalone components and
  mounts them in the shell built by M4-S1 to M4-S4b ("SHELL"; M4 D6, `phase-2-build-order.md`).
- Calendar-aware detection ("Are you in Weekly sync?") and the pre-call notification (M5).
- Re-running a whole call with a better model, and click-to-hear (M12). M2 re-runs gaps only.
- Meet-specific detection from window titles or the page (M9 Chrome extension). Window titles
  need Screen Recording, the permission M2 removes.
- Keeping Roger running with the window closed (close hides, `backgroundThrottling: false`,
  menu bar, open at login): M5-T11 owns it. The "Take notes" start request: M5-T5 owns it.
- A floating "listening" light, Developer ID signing, hardened runtime for the helper, universal
  binaries, notarization (M11).
- Any API, Postgres or MCP change. M2 leaves `docs/api-contract.md` as it is; the one API value
  it needs (`call_detected` as a `start_source`) is asked of M5, which owns that column.

## Design

### Starting point: the 2026-10-06 field report

After a restart the installed app said it could not detect system audio, and asked for the mic
again although System Settings showed it allowed. The `tccd` log explains both:

- 14:12 to 14:15: `Failed to match existing code requirement for subject ai.linkt.roger and
  service kTCCServiceMicrophone` (then a new mic prompt), and the same for `ScreenCapture` and
  `AudioCapture`. Those builds were ad-hoc signed, so every rebuild changed the code requirement
  the grants were pinned to. With ScreenCapture refused, `desktopCapturer.getSources` returns
  nothing, which is the "No screen source is available for system audio" error.
- 14:22:55: TCC deleted Roger's three records (`install-mac.sh` resets them when the signing
  identity changes). The app installed at 14:24 is signed `identifier "ai.linkt.roger" and
  certificate leaf = H"b457..."`, which survives rebuilds (commit 30e137c).

So the next Start asks once per permission and later launches should not. M2-T1 proves that on
the Mac. Two copies of Roger.app exist (`/Applications` and `apps/desktop/dist/mac-arm64`); only
the `/Applications` one is launched. The helper then removes the Screen Recording need altogether.

### Decisions

Rows marked **owner** (D1 to D9) need Rahul's sign-off; the rest are engineering calls.

| Decision | Choice | Alternative | Why |
| --- | --- | --- | --- |
| **D1 owner** System audio source | Swift helper with a Core Audio process tap (macOS 14.2+): one mono global tap, a private aggregate device that holds only the tap, `AVAudioConverter` to 16 kHz Int16, framed PCM on stdout, JSON events on stderr. Electron `desktopCapturer` stays behind the `SystemAudioSource` seam (`systemAudioCapture: "electron"` in config.json, or automatic when the helper binary is missing) | Stay on Electron's path | Needs only System Audio Recording, not Screen Recording; one permission fewer to break on a rebuild; full control of route changes. Learned from openwhispr `resources/macos-audio-tap.swift`, anarlog `crates/audio-actual/src/speaker/macos.rs`. |
| Helper threading and liveness | The IO block only copies into a bounded ring buffer (2 s); a writer thread converts, frames and writes stdout, and counts overflow in `stats.dropped`. The helper exits on stdin EOF or when its parent dies, so no tap or aggregate outlives Roger. Main's `HelperProcess` sends SIGKILL to a helper that gives no stdout byte and no event for 3 s and restarts it; that counts toward the 5 restarts | Write stdout inside the IO block (openwhispr); restart only on exit | openwhispr calls `processInput` from the IO block (`macos-audio-tap.swift:293`) and loops on `write` there (`:471`): if main stops reading, the 16 to 64 KB pipe (0.5 to 2 s of audio) fills and blocks the audio IO thread. A stopped or deadlocked helper never exits, so restart-on-exit alone leaves call audio dead until the user acts. |
| Tap rebuild on device change | The helper listens to the default output device and the tap format, and rebuilds tap and aggregate (300 ms debounce), emitting `restarted`. An opt-in Mac selftest switches the default output between two devices while `afplay` plays a tone and asserts non-zero audio returns within 2 s with a `restarted` event (`make test-native-route`; audible, so not part of `make check`) | Build once (openwhispr) | openwhispr's own comment: "the tap is built once and never follows the machine", which hid openwhispr#1990. AirPods switch the output and the tap format (anarlog re-probes the format for this). The rebuild is the riskiest Swift path, so one real call is not enough proof. |
| Mic capture | Stays in the renderer (`getUserMedia`), plus device-change recovery: follow the new default input within 250 ms and show "Switched to <device>" on screen (a capture event, never a loud warning) | Move the mic into the helper | The mic path works today. One native change at a time. A removed device Roger recovers from is not a cut, so the exit check no longer uses it as one. |
| Helper build, bundling and signing | `swiftc -swift-version 5 -O -target <arch>-apple-macosx14.2` with the installed Swift 6.4 command line tools, no Xcode, no SwiftPM. Output `apps/desktop/native/bin/roger-audio` (git-ignored), shipped by `extraResources` to `Contents/Resources/bin/roger-audio`. `install-mac.sh` signs the app with `--deep` as today (Electron's frameworks and helper apps), then re-signs `roger-audio` with `--identifier ai.linkt.roger.audio`, then reseals the app's top level without `--deep`; it then reads both designated requirements and fails the install on a mismatch | A nested `.app` with its own Info.plist; signing every Electron part inside-out by hand | `--deep` treats the helper as nested code and may sign it with an identifier made from its file name; re-signing the helper after the app breaks the app's seal unless the top level is resealed. Keeping `--deep` for Electron's own parts avoids listing them by hand. Bundling as in openwhispr (`scripts/build-macos-audio-tap.js`, `extraResources` to `bin/`). Spawned by Electron main, the helper's TCC "responsible process" is Roger, so the prompt says Roger and the grant uses Roger's `NSAudioCaptureUsageDescription`. Language mode 5 avoids strict-concurrency noise around Core Audio C callbacks. |
| Permission check for system audio | No public API reads it, and a refused or still-pending tap delivers silence with no error (AudioCap README, meetily `audio/permissions.rs`). The setup screen runs `roger-audio probe` while `/usr/bin/afplay` plays a short system sound: heard means granted. The first silent probe for a signing identity reports "pending: answer the macOS dialog, then press I allowed it"; later ones report "not allowed, or the Mac is muted". After a grant (that button, or Roger regaining focus after a Start or probe while system audio is unverified) main rebuilds the tap, because a tap built while the prompt was up stays silent. A success is stored with the signing identity (T1), so "verified" resets when the identity changes. T1 checks on macOS 26 which System Settings anchor opens "System Audio Recording Only" and hardcodes that one | Private `TCCAccessPreflight` (anarlog `crates/tcc`); an anchor fallback chain | Private TCC APIs are on the "not copied" list in `docs/research/reference-repos.md`. `shell.openExternal` resolves even for an anchor System Settings does not know, so a fallback chain cannot detect that its first anchor failed. |
| Timeline | Every chunk carries the wall-clock time of its first sample, taken where it was captured: the worklet posts `currentFrame` and the renderer maps it through `AudioContext.getOutputTimestamp()` and `performance.timeOrigin`; the helper converts `AudioTimeStamp.mHostTime` to wall clock. `AudioTimeline` per source and STT connection records runs of contiguous audio; a new run starts when a chunk's capture time and the time its predecessors' samples predict drift apart by more than 250 ms. A vendor time maps to meeting time through its run | First-chunk offset plus vendor time (M1); runs split by arrival time in main | M1's mapping drifts by the length of any gap: a 10-minute sleep would stamp later lines 10 minutes early. Arrival times in main jitter with GC pauses and synchronous SQLite writes, and the two streams arrive by different paths (renderer IPC, helper pipe), which would split runs falsely and eat into the ±700 ms echo window. Runs also give reconnect replay and the backup exact offsets. |
| STT reconnect | `ResilientSttStream` wraps every stream `createSpeechToText` returns: a fresh token per attempt, backoff 0.5, 1, 2, 4, 8, then 10 s with no attempt limit while recording. WebSocket ping every 1 s; the socket counts as dead when neither a pong nor a message has arrived for 4 s. Main polls `net.isOnline()` every 1 s and marks both streams offline the moment it turns false. Audio is kept while down (60 s per stream); on reconnect, replay from the last final's end (30 s ring). Words that end at or before that point are dropped. Audio beyond the buffer becomes a recorded gap. The last final's end per source is published as that stream's watermark | Ping every 5 s and dead after 10 s; the renderer's `offline` event | With 5 s and 10 s a cut is declared dead 10 to 15 s after it lands, past the 10 s done-when, and `ws` gets no prompt error when the interface goes down. Now the worst case is dead at most 5 s after the last pong, or 1 s after Wi-Fi goes off. Polling in main needs no renderer, which may itself be reloading. Watermark dedupe from anarlog `crates/transcript/src/channel_state.rs`, replay ring from `listener-core/.../source/pipeline.rs` (5 s there; 30 s here because the token fetch adds a round trip). A 30 s token only has to be valid at the handshake ([Deepgram token auth](https://developers.deepgram.com/guides/fundamentals/token-based-authentication)). |
| Silence and no-audio warnings | Loud, per source: no chunk for 5 s (M1); track or helper ended; helper killed by the 3 s watchdog; mic dead signal for 8 s, where dead is a peak of at most 1 LSB or, only if T11's Mac check finds input volume 0 is not digital zero, a level flat for 8 s more than 40 dB under the running floor; STT offline. "Call audio never non-zero for 20 s after start" is loud only while system audio is unverified for this signing identity (no successful probe and no non-zero tap audio since the identity changed); once verified it shows on screen only. Call audio dead for 8 s mid-call shows on screen only (D3) | One rule for both streams; the 20 s rule always loud | Real mics never produce exact zeros (anarlog `DropoutMonitor`). With a global tap, call audio is exact zeros whenever nothing plays, so an always-loud 20 s rule would fire on every early join, waiting room and M5 "start just before the meeting", and teach users to ignore warnings. Apple Silicon may apply a minimum gain at input volume 0 rather than a hard zero, hence the Mac check. |
| **D4 owner** Mic dead threshold on Bluetooth inputs | 30 s on a Bluetooth input, 8 s elsewhere. This deviates from "warning within 10 seconds" for an AirPods mic that goes silent; the exit-check mic cut runs on the built-in mic | 8 s for every input | AirPods gate the mic between words and can give 60 to 90 s of silence at start (meetily works around it); 8 s would raise loud false warnings on most AirPods calls. Tuned on the AirPods exit call. |
| **D3 owner** Loud for call audio silence | On-screen warning at 8 s of digital silence on call audio; a notification only after 60 s of it while the mic hears speech, or 180 s regardless | Notify at 8 s | Notifying at 8 s would fire in ordinary pauses. A quiet call and a cut tap look the same, so openwhispr waits 180 s before even a soft warning. Every cut that stops delivery (helper, renderer, device, network) is loud within 10 s either way. |
| Where warnings reach the user | `Notifier`: an Electron `Notification` when Roger is not focused, one per warning spell, rate-limited per warning kind and source (at most one every 2 minutes for the same kind and source; a different kind or source always notifies); on the `failed` event, `app.dock.bounce('critical')` and a dock badge | One global limit of one every 2 minutes; a floating always-on-top pill | A global limit would hide a second, different cut (a dead mic 60 s after STT went offline), and the exit check runs three cuts back to back. Electron 42+ uses `UNUserNotificationCenter`, which needs a signed app and fails silently otherwise; the self-signed build is unverified. The pill is M11's "clear light". |
| **D2 owner** Echo | Text-level dedupe in main, confirmed by spike T0 before sign-off. A mic word matches a call-audio word with the same normalised text within ±700 ms on the meeting timeline. A mic line is hidden when at least 70% of its words match (lines of 1 or 2 words: all words, and at least 50% time overlap). In a mixed line (under 70%), runs of 3 or more matched words are trimmed and the original text kept in a local column; a line trimmed to nothing is hidden. Re-run lines (T16) pass through the same filter against stored call-audio lines. Off when the output is known headphones. Hidden lines stay in SQLite with `suppressed_reason = 'echo'`, are not uploaded, and can be unhidden, which uploads them. If T0 shows that `getUserMedia({ audio: { echoCancellation: 'all' } })` removes call audio from the mic in Electron 44 without ducking other apps, it is turned on too and the text filter stays as the backstop | Acoustic echo cancellation only; signal correlation (openwhispr `meetingEchoLeakDetector.js`) | Chrome 141 added `echoCancellation` values `all` and `remote-only`, letting a page choose how much system playout is removed from the mic ([Chrome 141 beta](https://developer.chrome.com/blog/chrome-141-beta), [release notes](https://developer.chrome.com/release-notes/141)). Electron 44.5.1 ships a newer Chromium, but neither page says `all` works on macOS or whether it goes through Apple's voice processing, which can duck other apps' audio: T0 measures it. The older claim that Chromium only cancels its own playback held before 141 and is dropped. Correlation needs many tuned thresholds and can mute real speech. Text matching is vendor-free and testable with plain unit tests; trimming keeps the user's own words in a line that mixes both. |
| Upload of mic lines | While the echo filter is on, a mic line is held (`upload_after` set to its creation plus 120 s) until the call-audio stream's watermark passes the line's end plus 700 ms, or that stream closes, whichever comes first; the 120 s is only a cap. The uploader never sends `end` for a meeting that still holds lines, and looks at a remotely ended meeting again whenever it has lines that can be uploaded (re-run, unhidden, released). At startup every hold is settled (checked once against stored call-audio lines, then released) before the uploader's first tick | A fixed 6 s hold; upload at once and retract later | A fixed hold assumes the call-audio twin lands within 1 to 2 s; while that stream reconnects or replays (its backoff is independent of the mic's), echo lines would upload before their twin and Postgres would get doubled text. M1 drops a meeting from sync for good once it is ended remotely (`TranscriptUploader.ts:196-198`, `SqliteTranscriptStore.ts:111-112`), which would strand every later line. The API accepts appends to an ended meeting and a re-sent end is idempotent (`docs/api-contract.md`), so reopening the loop needs no API change. |
| **D5 owner** Audio backup | Per stream WAV files of at most 60 s, a new file at every timeline run. A closed file is turned into AAC m4a, 48 kbps, by `/usr/bin/afconvert` in the background (the WAV stays if that fails). Retention 7 days (`audioRetentionDays`, 0 turns backup off), checked at startup and hourly; a meeting with an unrecovered gap keeps its audio until the gap is recovered, the user deletes it, or 30 days pass, and the capture report and a Home card say so from day 7. Paused below 2 GiB free disk. Folder `userData/audio/<meeting>`, mode 0700. Never uploaded | `MediaRecorder` webm/opus; WAV only; FLAC | System audio now reaches main as PCM, not a `MediaStream`. WAV is crash-safe (the header is repaired from the file size); AAC is about 43 MB per call hour for both streams against 230 MB of WAV. afconvert ships with macOS: no dependency. 60 s chunks and a disk reserve from anarlog `listener-core/.../recorder/chunks.rs`. The roadmap keeps audio "so a failed transcript can be re-run"; deleting it while a re-run is pending defeats that. |
| Gap re-run | After Stop, at startup and on demand: stream each gap's backup audio (plus 1 s each side) through the same `SpeechToText` adapter with a fresh token, drop words that overlap lines already stored, pass mic lines through the echo filter against stored call-audio lines, save the rest with `origin = 'rerun'` | A batch endpoint on the API | Audio never leaves the Mac in Phase 2 (C6), and it reuses the streaming adapter. Without the echo pass, a re-run gap on laptop speakers brings the doubles back. Whole-call re-runs are M12. |
| **D6 owner** Call detection | Helper monitor polls Core Audio process objects every 1 s (`kAudioHardwarePropertyProcessObjectList`, `kAudioProcessPropertyIsRunningInput`). A PID resolves to its outermost app bundle; a process outside any bundle resolves by executable path, and `/usr/libexec/avconferenced` and `callservicesd` count as "FaceTime or phone call". Allowlist of call apps (Zoom, Teams, FaceTime, Webex, Slack, browsers). Offer "Take notes" after 5 s of mic use (15 s for a browser), 10-minute cooldown after a dismiss. Never auto-start | Deny-list of any mic app (anarlog); window titles; auto-start | No permission needed. anarlog `crates/detect/src/list/macos.rs` does the same lookup, and special-cases the call daemons there (`APPLE_CALL_DAEMON_IDS`, lines 11-16) and in `apps/desktop/src/stt/meeting-apps.ts` ("iPhone Call"): FaceTime audio runs in `avconferenced`, which has no `.app` around it. anarlog's listeners stop firing on macOS 26 ([home-assistant/iOS#5635](https://github.com/home-assistant/iOS/issues/5635)), so poll. A browser using the mic is a weaker signal, hence 15 s (anarlog's default). |
| Starting from the offer | `CallDetector` hands each detection to M5's `PromptService.offer({source: 'call_detected', app})` (M5 D5, OD-24 in `phase-2-build-order.md`). M5's panel shows the card; "Take notes" goes through M5's start request (M5-T5) with `startSource: 'call_detected'`, or `notification` when exactly one calendar event is running or starts within 5 min. M2 builds no card or notification of its own for the offer. Gate confirmed on 2026-10-06: M5-T1 (check constraint), M5-T4 (`StartSource`, contract) and M5-T5 (desktop type and tests) carry `call_detected` | M2's own start path and card | One way to start a note from outside the window, not two. Without the value, Postgres rejects every offer-started meeting and the exit check's 2 offer calls cannot pass. |
| Auto-stop | Stop when no call app has used the mic for 15 s (30 s for a browser) and a call app was seen during the session; notify "Stopped: the call in Zoom ended". After a wake the release clock starts at 60 s. A manual start with no call app seen never auto-stops | Ask first, as anarlog does for browsers | Muting keeps the mic running in Meet and Zoom; the debounce covers AirPods switching devices. |
| Sleep and wake | `powerSaveBlocker('prevent-app-suspension')` while recording, owned by T18 only. On `suspend`: finalize and close both STT streams, log the event. On `resume`: reopen streams, restart the helper, the renderer reopens the mic | Keep sockets open | Sockets do not survive sleep. New timeline runs keep post-wake lines at the right time. |
| **D7 owner** Crash recovery | Renderer gone: main reloads the page and the renderer reopens the mic because main is recording. Helper gone or hung: the watchdog and restarts above. App killed while recording: the monitor helper sees its parent die and relaunches Roger once per meeting with `open -g -b ai.linkt.roger`. At launch, a meeting left open whose last activity is under 10 minutes old resumes in the same meeting id when a call app holds the mic or the launch came from that relaunch: it is not ended, the gap is recorded, capture continues, and Roger shows "Roger restarted and kept taking notes" with a Stop button. Otherwise it is ended as in M1. Open WAV headers are repaired and the crash tail becomes a gap the re-run fills | End the meeting at launch and offer a new one; no relaunch | One call must stay one meeting, or the per-meeting count and quote checks break. While Roger is dead nobody tells the user that capture stopped, which is the core failure this product exists to fix. A deliberate Force Quit looks the same as a crash, hence once per meeting and a visible Stop. |
| Window lifecycle | Taken from M5-T11 (close hides, `backgroundThrottling: false`, `activate` shows the window). M2 adds only `render-process-gone` handling | Build it in M2 too | Detection and mic capture need a live renderer with the window closed; M5 needs the same for reminders. One owner. |
| Renderer tests | Seams for `mediaDevices` and `AudioContext` with unit tests on fakes, plus one Electron smoke test with Chromium's fake audio device (`--use-fake-device-for-media-stream`, `--use-file-for-fake-audio-capture`), the fake STT and the fake helper. It runs the unpackaged build with `ROGER_E2E=1`, honoured only when `!app.isPackaged`: no macOS TCC gate (`askForMediaAccess` is never called), a dummy API token, a temporary `--user-data-dir` | Unit tests only | The worklet and `getUserMedia` wiring were only ever checked by a real call (M1 gap). Launched by an agent, the responsible process for a TCC prompt is the terminal or Electron.app, so `ensureMicrophoneAccess` (`permissions.ts`) would hang the run on a dialog, and `index.ts` refuses to start without a token. |
| **D8 owner** New dev dependency | `playwright-core` 1.63.0 for the smoke test only | Hand-written CDP client over `ws` | See "New dependencies" below. |
| **D9 owner** `workspace_id` on local tables | The three new meeting-scoped local tables (`transcript_gaps`, `audio_files`, `capture_events`) carry a nullable `workspace_id`, NULL until M6. M1's `meetings` and `segments` and the device-level `app_state` stay without it; M6 backfills them all in one migration | No column on any local table until M6 | C5 and house rule 2 say every table row. The Mac has no workspace identity before M6 sign-in, and M2 touches no Postgres table. A nullable column now makes M6 a backfill rather than a schema change for M2's tables; the rest is a deviation that needs sign-off. |
| Delete-audio and helper path safety | The delete-audio IPC accepts only a UUIDv4 meeting id (`ipc-validation.ts`); main resolves `userData/audio/<id>`, asserts the resolved path stays inside the audio root, and only then removes it. `helperPath.ts` reads only `process.resourcesPath` or the dev build path (the fake helper only under `ROGER_E2E=1` when unpackaged), never config.json | Trust the renderer's id; a configurable helper path | A renderer-supplied `../` would otherwise be a path-traversal delete, and a configurable path would let a config file pick the binary that records call audio. |

### New dependencies

| Package | Ecosystem | Weekly downloads | Last publish | Why |
| --- | --- | --- | --- | --- |
| `playwright-core` (dev) | npm | 143,875,987 (week 2026-09-28 to 2026-10-04) | 1.63.0 on 2026-09-04 (re-checked 2026-10-06, still latest); zero dependencies; no advisories (npm bulk advisory check 2026-10-06) | Drives the Electron renderer in the smoke test. Outside the 7-day quarantine. Electron support is marked experimental by Playwright. |

No new Python dependency. No runtime npm dependency: WAV writing is hand-written, encoding uses
`afconvert`, the helper uses only Apple frameworks.

### Data flow

```
renderer (stays alive when hidden)        main                                         helper roger-audio (Resources/bin)
getUserMedia(mic) -> worklet --IPC-->  CaptureService.pushAudio ---+              tap:     IO block -> ring -> writer thread
  (pcm + capture time)                                             |                        -> framed chunks + capture time --stdout--> TapSystemAudio
MicRecovery (devicechange)                                         |                        events (ready, restarted, stats) --stderr-->
                                   TapSystemAudio (system) --------+-> AudioFanout          exits on stdin EOF or parent death
                                   HelperProcess watchdog (3 s)         |-> SignalMonitor -> warnings -> Notifier (per kind and source), banner
                                   net.isOnline poll (1 s)              |-> AudioBackupWriter -> audio/<meeting>/*.wav -> afconvert -> .m4a
                                                                        '-> CaptureSession -> AudioTimeline -> ResilientSttStream x2 -> vendor
                                                                               finals + watermarks -> SQLite -> EchoSink (hide, trim, hold)
                                                                               -> TranscriptUploader (holds, reopened ended meetings)
                                                                   monitor: mic users + output route --stdout--> MeetingAppMonitor -> CallDetector
                                   powerMonitor -> PowerCoordinator         parent dies while recording -> open -g -b ai.linkt.roger
                                   CrashRecovery at launch: resume or end
```

### Local schema (SQLite migration 3)

```sql
ALTER TABLE segments ADD COLUMN suppressed_reason TEXT CHECK (suppressed_reason IN ('echo'));
ALTER TABLE segments ADD COLUMN echo_of TEXT;            -- the call-audio segment it repeated
ALTER TABLE segments ADD COLUMN original_text TEXT;      -- set when echo words were trimmed; local only
ALTER TABLE segments ADD COLUMN upload_after TEXT;       -- hold cap; NULL = may upload now
ALTER TABLE segments ADD COLUMN origin TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'rerun'));
ALTER TABLE meetings ADD COLUMN stop_reason TEXT;        -- user | call_ended | quit | crash
CREATE TABLE transcript_gaps (id, workspace_id NULL, meeting_id FK CASCADE, source, start_ms, end_ms, reason, created_at, recovered_at, recover_error);
CREATE TABLE audio_files (id, workspace_id NULL, meeting_id FK CASCADE, source, start_ms, end_ms, path, format CHECK IN ('wav','m4a'), bytes, created_at, closed_at, deleted_at);
CREATE TABLE capture_events (id INTEGER PK, workspace_id NULL, meeting_id FK CASCADE, at, offset_ms, source NULL, kind, detail_json);
CREATE TABLE app_state (key TEXT PK, value TEXT, updated_at);   -- device state, e.g. system audio verified for an identity
```

"Can upload" means not synced, not rejected, not suppressed, and `upload_after` NULL or past.
The unsynced queries and counts use it; without it, "N lines waiting" would never reach zero.
`meetingsNeedingSync` selects meetings not ended remotely, plus any meeting that has a line that
can upload. Unhide clears `suppressed_reason` and `echo_of`. M5-T5 adds `meetings.start_source` to
the same file as migration 4; this one is migration 3 (fixed in `phase-2-build-order.md`).

### Needs from other Phase 2 plans

| Need | Owner | Used by | Gate, and until it lands |
| --- | --- | --- | --- |
| Shell slots: a full-window setup route reachable on first run and from a menu item; a warning banner slot above every page (warnings must show wherever the user is); capture status, audio note and capture report regions on the meeting page; a card slot on Home (audio kept for a re-run) | M4-S1 (setup route, banner and Home card slots), M4-S4 (meeting-page regions) | T19, T20a, T20b | Confirmed: M4 carries them as numbered tasks in waves 1 and 2 (`phase-2-build-order.md`). Each mount task owns its own `app/slots/<task>.ts`; nothing mounts in M1's window. |
| `PromptService.offer` (the one prompt panel), `StartCaptureRequest`, `requestStart` / `takePendingStart`, and `call_detected` in `StartSource`, the Postgres check constraint, `api-contract.md` and M5-T5's tests | M5-T9b, M5-T5 | T17b | Confirmed (see "Starting from the offer"); T17b runs in wave 7, after both. |
| Close hides the window, `backgroundThrottling: false`, `activate` shows it | M5-T11 | The exit check (not a build dependency of T17b) | Detection works while the window exists. |
| M5-T5 adds `start_source` to the create payload in `TranscriptUploader.ts`, which T3b owns | M5-T5 | - | T3b lands first; M5-T5 rebases on it and keeps T3b's tests green. |

### Contract additions (desktop only)

- `shared/capture.ts`: stream state `reconnecting` and `offline`; per source `signal` (`unknown`,
  `signal`, `quiet`, `dead`), `levelDb`, `device`; `warnings: CaptureWarning[]` (kind, source,
  since, message, loud); notices (device switched, helper restarted, resumed after a crash);
  `systemCapture` (`tap`, `electron`); `systemAudioVerified`; `route` (output speakers,
  headphones or unknown, device names); `trigger` (call app); `paused` (`asleep`); `backup`
  (state, bytes, keep until, kept for re-run); `echo` (hidden, trimmed, held counts). Threshold
  constants live here once.
- `shared/ipc/capture.ts` and `shared/ipc/setup.ts` (per-feature modules from P2-F1) with their
  preload bridges and preview fakes: the audio chunk gains `capturedAtMs`; setup status (including
  `pending` for system audio), request mic, test system audio, "I allowed it", test notification,
  open a System Settings pane, relaunch; `transcript:segment-changed`
  (`IpcChannel.TranscriptSegmentChanged`, preload `onTranscriptSegmentChanged`, payload
  `{ meetingId, segmentId, source, change: 'hidden' | 'trimmed' | 'unhidden', reason: 'echo',
  echoOf, text }`, one event for all three, which M3-T7 renders), unhide segment; capture report,
  re-run gaps, delete audio for a meeting. The call-detected offer has no M2 channel: M5's prompt
  IPC carries it. `ipc-validation.ts` checks every new payload; meeting ids must be UUIDv4.
- `config.json` keys: `systemAudioCapture`, `audioBackup`, `audioRetentionDays`, `callDetection`,
  `echoFilter`, validated like the existing keys. No key chooses the helper binary.
- Helper protocol: `roger-audio tap --sample-rate 16000 --chunk-ms 100` writes frames to stdout:
  a 16-byte header (ASCII `RGA1`, payload bytes as u32 LE, wall-clock ms of the first sample as
  f64 LE) then 3,200 bytes of Int16; JSON lines on stderr (`ready {format}`,
  `restarted {reason}`, `stats {peak, frames, dropped}` every 1 s, `warning`, `error {code}`);
  stdin `rebuild` rebuilds the tap, EOF exits. `roger-audio monitor --parent-pid <pid>` writes
  JSON lines (`mic_users [{pid, bundleId, path, name}]`, `route {output, input}`) on change, takes
  stdin `recording on` and `recording off`, and on parent death while recording runs
  `open -g -b ai.linkt.roger` once (`--relaunch-dry-run` prints it instead, for tests).
  `roger-audio probe --seconds 2` prints the peak it heard. `roger-audio selftest` checks the
  converter, framing and ring overflow; `selftest --route-switch` is the audible route test.

## Work items

Each task owns its files; another task touches them only where a dependency says so. The waves,
the foundations (P2-F1 to P2-F3) and the order of every shared file are in
`phase-2-build-order.md`, which wins over this list where they differ. T2 and T3 land first, then
T4 and T3b: they create the seams every later task plugs into, so parallel work adds new files
plus one slot block. Every task is TDD: the failing test first,
`make check TEST_DB=roger_test_<task>` green before the commit.

- [ ] **M2-T0 Echo-cancel spike** · S · human plus agent · depends on: none. Before sign-off.
  On a throwaway branch, open the mic with `echoCancellation: 'all'` in Electron 44, record
  `track.getSettings()`, play a YouTube talk on the laptop speakers for 2 minutes with and without
  it, and compare leaked Them words in the mic transcript and the tap's level (ducking). Writes the
  result and its source into D2 and the exit check log. No code lands.
- [ ] **M2-T1 Signing self-check, field report, settings anchors** · S · desktop, docs · depends
  on: none. Owns `src/main/signing.ts` (+ test): reads the designated requirement at startup and
  reports `local-identity`, `developer-id`, `adhoc` or `unsigned`, plus a hash of the requirement
  that "system audio verified" is stored against. Owns `src/main/settingsPanes.ts` (+ test): the
  anchors for Microphone and for "System Audio Recording Only", checked by hand on macOS 26 and
  hardcoded. Adds the `tccd` log recipe (`/usr/bin/log show ... "Failed to match existing code
  requirement"`) to the CLAUDE.md failure log and the field report to the M1 exit check log. Mac
  check: Start, grant, quit, relaunch, Start again with no prompt and call audio present.
- [ ] **M2-T2 Contracts, config, IPC validation** · M · desktop · depends on: P2-F1.
  Owns `src/shared/capture.ts`, `src/shared/ipc/capture.ts`, `src/shared/ipc/setup.ts`, their
  bridges in `src/preload/bridges/` and fakes in `preview/fakes/`, `src/main/config.ts`,
  `src/main/ipc-validation.ts`. Types,
  channel names, preload bridges, thresholds, config keys and payload validators above (audio
  chunk `capturedAtMs` finite and within a day of now; meeting ids UUIDv4); no behaviour.
- [ ] **M2-T3 Local store migration 3** · M · desktop · depends on: none.
  Owns `src/main/store/*` except the sync statements (T3b). Schema above; store methods for gaps,
  audio files, capture events, app state, suppress, trim, unhide, hold and release; the in-memory
  store kept in step. Also owns the backup fixture `apps/desktop/test/fixtures/backup/` (a small
  `roger.sqlite` built by this migration plus short WAV and m4a chunks with a gap, and the script
  that makes them), moved here from T15 so M3-T12 can start in wave 2; T15's tests read it.
- [ ] **M2-T3b Uploader: no stranded lines** · S · desktop · depends on: T3.
  Owns `src/main/upload/TranscriptUploader.ts` (+ test) and the sync statements in
  `SqliteTranscriptStore.ts` and `InMemoryTranscriptStore.ts` (`meetingsNeedingSync`, unsynced
  lines, counts, held count). Rules: a remotely ended meeting with a line that can upload is synced
  again and its end re-sent; `end` is never sent while the meeting holds lines; a
  `beforeFirstTick` hook (T14's settle) runs before the first tick so holds left by a crash are
  settled first.
- [ ] **M2-T4 Capture pipeline seams** · M · desktop · depends on: T2.
  Owns `src/main/capture/CaptureService.ts`, `src/main/capture/AudioFanout.ts`,
  `src/main/capture/createCaptureRuntime.ts`, the `[slot M2-T4 …]` blocks of `src/main/index.ts`,
  `src/main/ipc.ts`. Audio fan-out to sinks (`onChunk(source, pcm, capturedAtMs)`, arrival time as
  the fallback until T12 sends capture times), session event listeners, `start()` that can take an
  existing meeting (id and start) for resume, a status-contributor seam (T10, T11, T14b and T15
  add status fields without editing `CaptureService.ts`), and named slots in
  `createCaptureRuntime.ts` for T10, T11, T14b, T15, T16, T17a, T17b, T18 and T19. No behaviour
  change; every M1 test stays green.
- [ ] **M2-T5 Audio timeline** · M · desktop · depends on: T4.
  Owns `src/main/capture/AudioTimeline.ts`, `CaptureSession.ts`. Runs split by capture-time drift
  over 250 ms, mapping as designed; `CaptureSession` maps finals and words through it.
- [ ] **M2-T6 STT reconnect with replay** · M · desktop · depends on: T3, T5, M3-T4a
  (`SpeechToText.inlineReplay`), M3-T5 (merges before T6 in `createSpeechToText.ts`).
  When an adapter's `inlineReplay` is false (AssemblyAI, the vendor since 2026-10-06), live audio
  goes out at once and the buffered window becomes a gap for T16; the comment from the M3 plan's
  builder notes goes into `ResilientSttStream.ts`. The AssemblyAI adapter gets the same liveness
  check as Deepgram.
  Owns `src/main/stt/ResilientSttStream.ts`, `src/main/stt/networkStatus.ts`,
  `src/main/stt/createSpeechToText.ts` (every adapter's stream is wrapped here),
  `src/main/stt/deepgram/DeepgramSpeechToText.ts` (ping and pong). Reconnect, buffer, replay,
  watermark dedupe and the published watermark, `net.isOnline()` polling, gap rows, capture
  events, stream states `reconnecting` and `offline`.
- [ ] **M2-T7 Helper: tap, framing, build** · M · desktop (Swift) · depends on: P2-F3.
  Owns `apps/desktop/native/roger-audio/{main,Protocol,Tap,RingBuffer,Lifecycle,SelfTest}.swift`,
  stub `Probe.swift` and `Monitor.swift` (T7b and T8 replace their bodies, so neither edits
  `main.swift`), `apps/desktop/scripts/build-native.sh`, and the Darwin lines of `make check`
  (`roger-audio selftest` plus `pnpm test:mac` when `uname` is Darwin). P2-F3 already added the
  `native` target, the `test:mac` script, the `*.mac.test.ts` exclusion, `vitest.mac.config.ts`
  and `native/bin/` in `apps/desktop/.gitignore`. Tap with rebuild on route change, ring buffer
  and writer thread, frame header with capture time, stdin `rebuild`, exit on stdin EOF or parent
  death. `main.swift` dispatches every subcommand.
- [ ] **M2-T7b Helper: probe and route selftest** · S · desktop (Swift) · depends on: T7.
  Owns `native/roger-audio/Probe.swift` and `selftest --route-switch` (P2-F3 added the
  `make test-native-route` target). The route test makes a temporary private multi-output device,
  plays a tone with `afplay`, switches the default output with `AudioObjectSetPropertyData`, and
  asserts non-zero audio within 2 s and a `restarted` event, then restores the output.
- [ ] **M2-T8 Helper: monitor mode** · M · desktop (Swift) · depends on: T7.
  Owns `native/roger-audio/{Monitor,Route,ParentWatch}.swift` and
  `src/main/native/monitorRelaunch.mac.test.ts`. Mic users every 1 s with PID to outermost `.app`
  and non-bundle processes by executable path; default input and output with transport
  (Bluetooth, built-in speaker or headphones by data source, USB, other); emits on change only.
  Parent death while `recording on`: relaunch Roger once, then exit; otherwise exit.
- [ ] **M2-T9 Bundle and sign the helper** · S · desktop · depends on: T7.
  Owns `electron-builder.yml`, `scripts/install-mac.sh`, `src/main/native/helperPath.ts` (+ test).
  `extraResources`, build before packaging, the signing order in the "Helper build, bundling and signing" row, verify both
  identifiers and fail the install on a mismatch or a missing helper. No config override of the
  path.
- [ ] **M2-T10 System audio through the helper** · M · desktop · depends on: T1, T3, T4, T9.
  Owns `src/main/native/HelperProcess.ts` (spawn, frame and stderr parsers, restart up to 5 times,
  the 3 s watchdog with SIGKILL, stdin closed on stop, SIGTERM then SIGKILL after 5 s),
  `src/main/audio/system/*` (`SystemAudioSource`, `TapSystemAudio`, `ElectronSystemAudio`,
  `helperEvents.ts`, selection), and the fake helper `test/fixtures/fake-roger-audio.mjs` (can
  hang on command). Rebuilds the tap on focus after a Start while unverified; records "verified"
  in `app_state` against T1's hash on the first non-zero tap audio.
- [ ] **M2-T11 Signal health and loud warnings** · M · desktop · depends on: T2, T3, T4.
  Owns `src/main/capture/SignalMonitor.ts`, `src/main/capture/warnings.ts`,
  `src/main/notify/Notifier.ts`. Rules and thresholds from the design table; ignores the first
  tick after a timer gap over 5 s (the Mac slept, from openwhispr's watchdog). Starts with a Mac
  check written to the exit check log: the built-in mic's peak at input volume 0
  (`osascript -e 'set volume input volume 0'`) and what turning off Roger's Microphone access
  mid-capture does (zeros, track ended, or nothing). Adds the flat-level rule only if the peak is
  above 1 LSB.
- [ ] **M2-T12 Renderer capture hardening** · M · desktop · depends on: T2, T4.
  Owns `src/renderer/src/audio/*`, `src/renderer/src/state/useCapture.ts`, `src/main/window.ts`.
  Injectable `mediaDevices` and `AudioContext`; worklet posts `currentFrame` and the renderer maps
  it to wall clock; `MicRecovery` (devicechange debounce 250 ms, mute grace 800 ms, follow the
  default input, swap the source node into the same worklet, generation counter, "switched"
  report; from openwhispr `activeMicRecovery.js`); reopen the mic whenever main is recording and
  the mic is not running (covers reloads, wake and resume); system stream only when
  `systemCapture` is `electron`; `render-process-gone` reload. Close-hides is M5-T11's.
- [ ] **M2-T13 Electron smoke test** · M · desktop · depends on: T10, T12.
  Owns `apps/desktop/e2e/harness.ts`, `e2e/capture.e2e.ts`, `src/main/e2eMode.ts` (+ test) and
  `[slot M2-T13]` in `index.ts` (P2-F3 already added `vitest.e2e.config.ts`, the `test:e2e`
  script, the `e2e-desktop` target and `playwright-core`). M5-T11's "Roger Dev" userData must not
  override the e2e user data folder; its slot comes after this one. Launches the
  unpackaged build with `ROGER_E2E=1`, Chromium's fake audio device playing a fixture WAV, the
  fake helper and `ROGER_STT_PROVIDER=fake`; Start shows lines within 10 s; Stop saves them; the
  run asserts the TCC gate was skipped and no prompt was asked for. Exposes a screenshot helper
  (both themes, wide and narrow) for T19 and T20.
- [ ] **M2-T14a Echo filter, pure** · S · desktop · depends on: none (wave 0).
  Owns `src/main/capture/echo/EchoFilter.ts` (+ test): hide, trim runs of 3 or more words, no
  Electron imports, so M3-T11's bench can load it.
- [ ] **M2-T14b Echo sink** · M · desktop · depends on: T3, T3b, T4, T5, T6, T14a.
  Owns the rest of `src/main/capture/echo/*` and the T14b runtime slot. A
  session sink: suppress, trim, emit "segment changed", hold mic lines until the call-audio
  watermark or stream close (cap 120 s), release on Stop, `settleAll` at startup (wired as T3b's
  `beforeFirstTick`), unhide, and a `filterStored` entry for re-run lines. Route comes through a
  `RouteProvider` interface (unknown until T17a wires the monitor; unknown means filter on).
- [ ] **M2-T15 Audio backup and retention** · M · desktop · depends on: T2, T3, T4, T5.
  Owns `src/main/backup/*` (`AudioBackupWriter`, `wav.ts`, `AudioCompressor`,
  `AudioRetentionSweeper`, `audioPaths.ts`, disk guard) and the T15 runtime slot. Header repair at
  startup; the sweeper keeps audio of meetings with unrecovered gaps (30-day cap); delete-audio
  handler with the path check. Its tests read T3's backup fixture; the `audio_files` contract with
  M3-T12 is in the M3 plan ("Where recordings come from").
- [ ] **M2-T16 Gap re-run** · M · desktop · depends on: T6, T14b, T15.
  Owns `src/main/rerun/*`. Reads WAV or decodes m4a with `afconvert -f WAVE -d LEI16@16000`,
  streams at real time through a fresh `SttStream`, drops overlapping words, runs mic lines
  through `EchoSink.filterStored`, saves lines with `origin = 'rerun'`, marks gaps recovered or
  records why not. Crash-tail gaps at startup.
- [ ] **M2-T17a Call app monitor** · S · desktop · depends on: T8, T10, T14b.
  Owns `src/main/detect/MeetingAppMonitor.ts`, `src/main/detect/callApps.ts`. Runs the monitor
  helper through `HelperProcess` while Roger runs, sends `recording on` and `recording off`,
  resolves call apps (FaceTime daemons included), feeds the echo filter's `RouteProvider`. Roger's
  own processes never count.
- [ ] **M2-T17b Offer and auto-stop** · M · desktop · depends on: T11, T12, T17a, M5-T5,
  M5-T9b (`PromptService.offer`). M5-T11 (close hides) is needed for the exit check, not to build.
  Owns `src/main/detect/CallDetector.ts` (pure), `src/main/detect/CallOffer.ts`, the T17b runtime
  slot. `CallOffer` passes detections (after the 10-minute dismiss cooldown) to
  `PromptService.offer({source: 'call_detected', app})`; M5's panel shows the card and its "Take
  notes" starts through M5's start request. No M2 notification or card for the offer. Auto-stop
  with `stop_reason`, the "Stopped: the call in Zoom ended" notification through T11's
  `Notifier`, the 60 s wake grace, `callDetection` off switch.
- [ ] **M2-T18 Sleep and wake** · S · desktop · depends on: T6, T10, T12.
  Owns `src/main/power/PowerCoordinator.ts`. Suspend and resume as designed, and the power save
  blocker.
- [ ] **M2-T19 Permission setup screen** · M · desktop · depends on: T1, T2, T7b, T9, T10, T11,
  T13, M4-S1 (setup route), M4-S3 (preview harness).
  Owns `src/main/setup/*`, `src/renderer/src/components/setup/*`, `e2e/setup.shots.e2e.ts`,
  `renderer/src/app/slots/m2-setup.ts`, the T19 runtime slot. Rows:
  microphone (status, request, open its pane), system audio (probe with a system sound, `pending`
  on the first silent probe for this identity, "I allowed it" rebuilds the tap and probes again,
  open T1's pane), Screen Recording only when the Electron fallback is in use, notifications
  (test), signing (T1), API health and STT token check. Shown on first run, when Start fails for a
  permission reason, and from a menu item. Every error names the pane and the switch to flip, and
  offers "Relaunch Roger" where macOS needs it.
- [ ] **M2-T20a Capture status UI** · S · desktop · depends on: T2, T11, T13, M4-S1 (banner
  slot), M4-S4 (meeting-page regions).
  Owns `src/renderer/src/components/capture/{WarningBanner,StreamStatus,LevelMeter,Notices}.tsx`
  (+ tests), `e2e/capture-status.shots.e2e.ts`, `renderer/src/app/slots/m2-capture-status.ts`
  (replaces the M1 `StatusPanel` entry M4-S4 seeded there).
  Warning banner (loud and quiet styles from theme
  tokens), per-stream state including reconnecting and offline, level meters, "Switched to
  <device>" and "helper restarted" notices. Mounted in the shell's banner slot and the meeting
  page's capture status region.
- [ ] **M2-T20b Capture details UI** · M · desktop · depends on: T14b, T15, T16, T17b, T20a,
  T23, M4-S4.
  Owns the other files in `src/renderer/src/components/capture/` (`EchoLines`, `AudioKept`,
  `RerunProgress`, `CaptureReport`, `ResumedNotice`), `e2e/capture-details.shots.e2e.ts`,
  `renderer/src/app/slots/m2-capture-details.ts`. No call-detected card: M5-T10's panel renders
  it (M5 D5). "Stopped because the call ended" notice, a toggle that shows hidden and
  trimmed echo text with Unhide, "audio kept until ..." with delete and "kept for a re-run",
  re-run progress, capture report, "Roger restarted and kept taking notes" with Stop.
- [ ] **M2-T21 Docs** · S · docs · depends on: all others.
  CLAUDE.md repo map (`apps/desktop/native`), commands (`make native`, `make e2e-desktop`,
  `make test-native-route`), failure log lines found during M2; `apps/desktop/README.md` (helper,
  permissions, audio folder); "Adopted in M2" in `docs/research/reference-repos.md`.
- [ ] **M2-T22 Exit check on real calls** · human plus agent · starts after T1 to T15, T3b, T7b
  and T20a (the "no lost or doubled text" set and the three cuts). The kill -9 call also needs
  T16 and T23, the lid call T18, the offer calls T17b and its M5 gates; T19 and T20b land before
  M2 closes. The "Done when" procedure, recorded below.
- [ ] **M2-T23 Crash resume** · M · desktop · depends on: T3b, T4, T5, T8, T10, T12, T14b, T16,
  T17a.
  Owns `src/main/recovery/CrashRecovery.ts` (+ test) and `[slot M2-T23]` in `index.ts`, which
  replaces
  M1's startup `endMeetingsLeftOpen` call. Resume or end as in D7, the gap row, a
  `resumed_after_crash` capture event, a `recording.heartbeat` app state written every 5 s while
  recording.

If the day runs short, T16, T17b, T18 and T23 land after the first exit-check calls; the core
set above gates "no lost or doubled text".

## Tests

| What | Test |
| --- | --- |
| Signing kinds read from `codesign -d -r-` output (local identity, ad hoc, unsigned, Developer ID); the requirement hash changes with the identity; pane anchors are the verified constants | `src/main/signing.test.ts`, `src/main/settingsPanes.test.ts` |
| New config keys parsed, bad values named in the error, defaults (retention 7, backup on, detection on); no key sets a helper path | `src/main/config.test.ts` |
| Every new IPC payload validated; a meeting id that is not UUIDv4, `../x` or an absolute path is refused; an audio chunk with a non-finite or far-off `capturedAtMs` is refused | `src/main/ipc-validation.test.ts` |
| Migration 3 on an M1 database keeps every row; suppressed and held lines are not "waiting"; trim keeps `original_text`; unhide; gaps, audio files, events, app state round-trip; crash reopen | `src/main/store/SqliteTranscriptStore.test.ts` |
| Re-run lines added after the meeting ended remotely are uploaded and the end re-sent; held lines left by a kill -9 and a relaunch within 6 s are settled and uploaded; an unhidden line is uploaded; `end` is not sent while lines are held; a meeting with nothing to upload is not touched again | `src/main/upload/TranscriptUploader.test.ts` |
| Fan-out delivers each chunk to every sink once with its capture time; a throwing sink is logged and the others still get audio; resume start keeps the meeting id; M1 behaviour unchanged | `src/main/capture/AudioFanout.test.ts`, existing `CaptureService.test.ts` |
| Contiguous audio is one run even with chunks arriving 0 to 400 ms late in random order of delay; a 300 ms capture gap starts a new run; vendor time maps into the right run; a 10-minute sleep keeps later lines at wall-clock time; 2 hours of chunks keep sample accuracy | `src/main/capture/AudioTimeline.test.ts` |
| Reconnect after a dropped socket with a fresh token; backoff schedule; with fake timers, dead is declared at most 6 s after the last pong whatever the phase of the ping cycle; `net.isOnline()` false marks the stream offline within 1 s; audio sent while down is replayed; words before the watermark are not stored twice; audio past the 60 s buffer becomes one gap; the watermark is published; states go reconnecting then open; every adapter from `createSpeechToText` is wrapped | `src/main/stt/ResilientSttStream.test.ts`, `createSpeechToText.test.ts`, `DeepgramSpeechToText.test.ts` (ping against the local fake server) |
| Converter framing, frame header and capture time, ring overflow counted as dropped | `roger-audio selftest` (in `make check` on a Mac) |
| The tap follows a switch of the default output within 2 s with a `restarted` event | `roger-audio selftest --route-switch` (`make test-native-route`, opt-in and audible; run in T7b and the exit check) |
| Monitor resolves `avconferenced` by path; parent death while recording prints the relaunch once (`--relaunch-dry-run`) and exits; parent death while not recording just exits | `src/main/native/monitorRelaunch.mac.test.ts` (`pnpm test:mac`) |
| Helper frames and events parsed and rejected when malformed; a format other than 16 kHz Int16 refuses to start; a helper that hangs (no bytes, no event) is killed at 3 s and restarted, and that counts toward the 5; restart after a crash up to 5 times then a loud error; stop closes stdin, then SIGTERM, then SIGKILL; verified is stored on the first non-zero audio | `src/main/native/HelperProcess.test.ts`, `src/main/audio/system/TapSystemAudio.test.ts` (fake helper script) |
| Helper missing selects the Electron path; config forces either; packaged builds ignore `ROGER_E2E` | `src/main/audio/system/selectSystemAudio.test.ts`, `src/main/native/helperPath.test.ts` |
| Stall at 5 s, mic dead at 8 s, Bluetooth mic dead at 30 s, flat-level rule when enabled; "call audio never heard for 20 s" loud while unverified and on screen once verified; call audio silent on screen at 8 s and loud at 60 or 180 s; a device switch is a notice, not a warning; first tick after a sleep gap does not warn; warnings clear when audio returns | `src/main/capture/SignalMonitor.test.ts`, `warnings.test.ts` |
| One notification per spell; the same kind and source twice within 2 minutes notifies once; two different kinds 30 s apart both notify; only when unfocused; dock bounce when the notification fails | `src/main/notify/Notifier.test.ts` |
| Mic reacquired on device change and after a muted track, with a "switched" report; generation counter ignores a stale attempt; the worklet node is reused; capture times map frames to wall clock; mic opens when main is recording and stops when it stops; system stream opened only in Electron mode | `src/renderer/src/audio/MicRecovery.test.ts`, `AudioCaptureController.test.ts`, `PcmStreamCapture.test.ts` |
| Real Chromium: fake audio device to worklet to IPC to fake STT to lines on screen, then saved; no TCC prompt asked for | `apps/desktop/e2e/capture.e2e.ts` (`make e2e-desktop`), `src/main/e2eMode.test.ts` |
| Same words within 700 ms hide the mic line; different words keep it; a mixed line loses only its runs of 3 or more matched words and keeps `original_text`; short lines need full match and overlap; headphones turn it off; a call-audio line arriving after the mic line still hides it before upload; while the call-audio stream is reconnecting the mic line stays held, and is released by the watermark, by stream close, or at the 120 s cap; unhide then upload; `settleAll` at startup; re-run mic lines are filtered against stored call-audio lines | `src/main/capture/echo/EchoFilter.test.ts`, `EchoSink.test.ts` |
| WAV files per run and per 60 s with correct offsets; a torn header repaired at startup; afconvert failure keeps the WAV; files past retention deleted, open meetings never; a meeting with an unrecovered gap keeps its audio until recovered or 30 days; backup pauses below 2 GiB and says so; delete-audio refuses a path outside the audio root | `src/main/backup/*.test.ts`; the real afconvert round trip in `src/main/backup/AudioCompressor.mac.test.ts` (`pnpm test:mac`) |
| Gap audio re-run adds only the missing words; re-run mic lines that repeat stored call audio are hidden; a gap without audio is marked with the reason; crash tail becomes a gap | `src/main/rerun/GapRetranscriber.test.ts` |
| Offer after 5 s for Zoom and 15 s for Chrome; `avconferenced` and `callservicesd` count as "FaceTime or phone call"; cooldown after dismiss; Roger never triggers itself; auto-stop after 15 or 30 s of release, 60 s after a wake; no auto-stop for a manual start with no call app; AirPods-style 2 s release does not stop | `src/main/detect/CallDetector.test.ts`, `MeetingAppMonitor.test.ts` |
| Suspend finalizes and closes streams; resume reopens them and restarts the helper; the power save blocker is held only while recording | `src/main/power/PowerCoordinator.test.ts` |
| At launch, a recent open meeting resumes in the same id when a call app holds the mic or the launch came from the relaunch, with a gap and a capture event; an old one, or one with no call app and no relaunch, is ended as in M1; holds are settled before the uploader's first tick | `src/main/recovery/CrashRecovery.test.ts` |
| Setup rows for granted, denied, not determined, probe pending then refused, probe heard, notifications failing, ad-hoc build; deep links | `src/main/setup/PermissionService.test.ts` |
| 2-hour soak: 72,000 chunks per stream through the service with fake STT and clock; memory buffers stay bounded; every line stored; offsets correct at 2 h | `src/main/capture/CaptureService.soak.test.ts` |
| UI: setup screen, warning banner, notices, call card, echo toggle in light and dark at desktop and narrow widths | QA gallery from `e2e/setup.shots.e2e.ts`, `e2e/capture-status.shots.e2e.ts`, `e2e/capture-details.shots.e2e.ts` |

## Risks

| Risk | Signal | Response |
| --- | --- | --- |
| The helper's permission is not attributed to Roger | Probe hears nothing after granting; the `tccd` log shows another responsible process | Spawn from main with default `posix_spawn` (no disclaim). If still wrong, ship the helper as a nested app with its own Info.plist. The Electron path stays as fallback. |
| A tap built while the TCC prompt is up stays silent | First Start after install has no call audio | Rebuild on "I allowed it" and on focus while unverified; the 20 s rule is loud while unverified. |
| Re-signing order breaks the app's seal | `codesign --verify --deep --strict` fails, or the helper's identifier is `roger-audio` | `install-mac.sh` checks both requirements and stops; the order is reseal last. |
| Notifications do not show on the self-signed build | `Notification` emits `failed` | Dock bounce and badge; the setup screen says so; Developer ID in M11. |
| Process-object listeners do not fire on macOS 26 | Known upstream | The monitor polls every 1 s. |
| AirPods give 60 to 90 s of silence at start (meetily works around it) or gate the mic between words | Dead-signal warnings with AirPods | Bluetooth inputs get 30 s (D4); check on the AirPods exit call and tune. |
| Input volume 0 or a revoked mic does not give digital zeros on this Mac | T11's Mac check | Flat-level rule; the exit-check mic cut falls back to freezing the renderer. |
| Echo filter hides real speech ("yes, exactly" said back) | Hidden lines that are the user's own words in the exit calls | Lines stay local with the reason, a show toggle and Unhide (which uploads them); headphones turn it off; trimming needs runs of 3 words; tune the 70% and 700 ms on the speaker calls. |
| `echoCancellation: 'all'` ducks other apps or does nothing on macOS | T0 | Leave it off; the text filter carries the echo fix. |
| Deepgram sends no finals during silence, so the watermark stalls | Mic lines held to the 120 s cap in quiet stretches | Lines still upload within 2 minutes and before `end`; noted in the capture report. |
| Deepgram ignores WebSocket pings | No pong ever on a healthy stream | If no pong arrives in the first 10 s, that socket relies on `net.isOnline()`, send errors and any message, and logs it; the Wi-Fi cut still warns within 1 s. |
| The relaunch after a deliberate Force Quit surprises the user | A Force Quit while recording | Once per meeting; the resumed notice has Stop; D7 is an owner decision. |
| afconvert rejects 48 kbps AAC at 16 kHz | Compressor errors in the log | Keep the WAV; the Mac test pins the exact command. |
| Backup fills the disk | Free space under 2 GiB | Backup pauses with a warning; text continues; retention, the 30-day cap and a delete button. |
| Parallel tasks collide in shared files | Merge conflicts in `CaptureService.ts`, `index.ts`, `ipc.ts`, `package.json`, `Makefile` | `phase-2-build-order.md`: P2-F1's slots in `index.ts`, T4's runtime slots, one writer per wave for `CaptureService.ts`, and P2-F3 owning `package.json`, the lockfile and the Makefile targets. |
| Other Phase 2 plans edit the same files | M3-T4a and T4b (`SpeechToText.ts`, `DeepgramSpeechToText.ts`, `CaptureService.ts`, `CaptureSession.ts`), M3-T6b (`CaptureSession.ts`), M3-T9 (`useCapture.ts`), M4-T22 (`CaptureService.ts`, `TranscriptUploader.ts`), M5-T5 (`shared/capture.ts`, `CaptureService.ts`, `TranscriptUploader.ts`, `roger.sqlite` migration 4), M5-T11 (`index.ts`, `window.ts`) | Section 3.1 of `phase-2-build-order.md` fixes the order of every shared file; local migration 3 is T3's and 4 is M5-T5's. |
| Cross-plan gates are not met | Resolved 2026-10-06: the shell is M4-S1 to S4b (waves 1 to 3), and `call_detected` is in M5-T1, T4 and T5 | If a shell task slips, the mount tasks (T19, T20a, T20b) wait; the rest of M2 does not. |
| Linux CI cannot build Swift or run afconvert | CI job | `*.mac.test.ts` is excluded from `vitest run`; the Mac-only parts run in `make check` on a Mac; CI runs the rest. A macOS runner is M11. |
| Audio on disk is sensitive | - | 0700 folder, 7-day default, delete button, path-checked delete, never uploaded; noted in the setup screen. |

## Known gaps carried forward

| Gap | What happens after M2 | Owner |
| --- | --- | --- |
| M1's local `meetings` and `segments` and the device-level `app_state` carry no `workspace_id` (D9) | Fine for one user per Mac; M2's new meeting tables carry a NULL column | M6 |
| Whole-call re-run with a better model, click-to-hear | Only gaps are re-run | M12 |
| Floating listening light, menu bar icon | Warnings use notifications and the dock | M11 |
| Helper: hardened runtime, Developer ID, universal binary, macOS CI | Built for the local CPU and signed with the local identity | M11 |
| Browser calls are detected by mic use only | "Chrome is using the mic", not "Meet call" | M9 |
| If Roger crashes twice in one meeting, or the relaunch fails, nothing tells the user | One relaunch per meeting | M11 (the listening light) |

## Exit check log

Filled in when the check runs on real calls. The Mac checks land here first: T0 (echo cancel
`all`), T1 (settings anchors on macOS 26), T11 (input volume 0 peak, revoked mic behaviour).

## Review

Engineer: pending.
