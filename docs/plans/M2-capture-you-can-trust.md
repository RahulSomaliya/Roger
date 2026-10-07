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

  Run on the installed app (`make install-desktop`) with `STT_PROVIDER=assemblyai` on the API (the
  vendor since 2026-10-06; AssemblyAI opted out of training in its dashboard first). The cost guards
  stay at their defaults (`apps/desktop/README.md`, "Cost guards"). From wave 6 those include
  M3-T20's silence gate, on by default: each call's log entry records whether it was on, and a
  first word lost after a silence counts against "no lost text" like any other. The 10 calls
  include: 2 on laptop speakers (echo), 1 with AirPods connected mid-call, 1 with the lid closed for a minute and
  reopened, 1 with Roger force-quit (`kill -9`) mid-call (Roger relaunches itself and the call stays
  one meeting), and at least 2 started from the "Take notes" offer. A 2-hour soak (a long video plus
  reading aloud) stands in for the 2-hour call if no real one happens. Per call, record: the capture
  report (gaps, reconnects, echo lines hidden or trimmed, helper restarts, warnings), the local
  count of lines that are not hidden against `GET /v1/meetings/{id}/transcript`, a scan for the same
  words under Me and Them within 2 s, and 3 random minutes checked against the audio backup.

  Cut the audio three ways mid-call and time each from the action to the warning (phone screen
  recording). Each warning must appear within 10 s.
  - Call audio: stop the helper (`pkill -STOP roger-audio`). Roger warns, kills and restarts it.
  - Mic: turn Roger off under System Settings, Privacy & Security, Microphone (and back on after).
    If T11's Mac check found that this does not stop the audio on this Mac, freeze the renderer
    instead (`pkill -STOP -f 'Roger Helper (Renderer)'`). Setting the input volume to 0 counts
    only if T11 found it gives digital zeros, or the flat-level rule is in place.
  - Network: turn Wi-Fi off for 30 s. Wi-Fi coming back must lose no line. AssemblyAI takes no
    replay faster than real time (M3 design), so the words of that window come back from the audio
    backup when the gap is re-run after Stop (T6 records the gap, T16 re-runs it): this call needs
    T16.

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
- Survive: no lost or doubled words across an STT reconnect (M1 gap), AirPods and other device
  changes, sleep and wake, renderer, helper and app crashes, 2-hour calls. M1's cost guards
  (landed 2026-10-06) already reopen a failed or paused session through the open budget; M2 adds
  dead-socket and offline detection, gap records and the gap re-run from the backup on top of them
  (see "Starting point: the STT layer and the cost guards").
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
- Pacing audio sent to the vendor (M3-T18, in the shared STT core), uploading STT usage (M3-T19a
  and T19b) and silence-gated streaming (M3-T20). M2's reopen paths get the pacing for free once
  T18 lands.
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

### Starting point: the STT layer and the cost guards (landed 2026-10-06)

Branch `m1-assemblyai` merged into `phase-2` (a3be3ee) after this plan was first written. It
changes what several M2 tasks start from. Every task below builds on it and never re-builds it.

- **One STT core.** `stt/core/` (`SttProtocol`, `SttConnection`, `WebSocketSpeechToText`) runs
  the one socket lifecycle for every vendor; an adapter only describes its protocol. Vendors are
  looked up in `stt/registry.ts` (the API's twin is `stt_vendors.py`), and
  `stt/conformance.test.ts` fails any registered vendor that leaves a socket open. AssemblyAI
  Universal-Streaming is the vendor; Deepgram is the second adapter.
- **Cost guards** (`costGuards.ts`, documented in `apps/desktop/README.md`): G1 a failed or ended
  source closes its session at once (`CaptureSession.closeSource`); G2 a source that sends no chunk
  for 30 s is `paused` and reopens on its next chunk with a fresh token, holding at most 3 s of
  audio (`sttReopenBufferMs`) while it connects; G3 a session the vendor ends mid-call is
  `retrying` and reopens with audio after a backoff (2 s doubling to 60 s), and every open, Start's
  two included, passes `capture/SttOpenBudget.ts` (4 a minute across meetings, 30 a meeting); G4
  `lifecycle.ts` stops the recording on quit (5 s bound), sleep, window close, renderer crash and
  reload; G5 a recording stops after 15 minutes without a final line or at 4 hours; G6
  AssemblyAI's `inactivity_timeout` (120 s) and the token's 3-hour cap; G7 a meter
  (`CaptureStatus.meter`, the `stt meter` log lines, local SQLite migration 3 `stt_usage`).
  `capture/stopReasons.ts` names every stop.
- **The house rule** (CLAUDE.md, architecture rule 9): every vendor session open goes through the
  core and through `SttOpenBudget` in `CaptureSession`, right before `openStream`; a source with no
  audio never holds an open session. T16's re-run opens outside `CaptureSession`, so T4 rewords
  the rule and the `SttOpenBudget` doc comment in wave 2: every open acquires first, right before
  `openStream`, and the re-run is a named caller with the minute-only acquire.

What that means here: M1's reconnect gap is half closed (sessions reopen), but audio between a
failure and the reopen is lost beyond the 3 s held, and nothing records it. M2-T6 adds dead-socket
and offline detection, gap rows and the watermark on top of the landed reopen; T15 and T16 bring
the lost window back from the backup. G4's stops on sleep and on a renderer crash or reload are
where M2 wants to continue instead: T18 and T12 change those two decisions in `lifecycle.ts`, and
keep every other guard.

### Decisions

Rows marked **owner** (D1 to D9) need Rahul's sign-off; the rest are engineering calls.

| Decision | Choice | Alternative | Why |
| --- | --- | --- | --- |
| **D1 owner** System audio source | Swift helper with a Core Audio process tap (macOS 14.2+): one mono global tap, a private aggregate device that holds only the tap, `AVAudioConverter` to 16 kHz Int16, framed PCM on stdout, JSON events on stderr. Electron `desktopCapturer` stays behind the `SystemAudioSource` seam (`systemAudioCapture: "electron"` in config.json, or automatic when the helper binary is missing) | Stay on Electron's path | Needs only System Audio Recording, not Screen Recording; one permission fewer to break on a rebuild; full control of route changes. Learned from openwhispr `resources/macos-audio-tap.swift`, anarlog `crates/audio-actual/src/speaker/macos.rs`. |
| Helper threading and liveness | The IO block only copies into a bounded ring buffer (2 s); a writer thread converts, frames and writes stdout, and counts overflow in `stats.dropped`. The helper exits on stdin EOF or when its parent dies, so no tap or aggregate outlives Roger. Main's `HelperProcess` sends SIGKILL to a helper that gives no stdout byte and no event for 3 s and restarts it; that counts toward the 5 restarts. The tap's `stats` and the monitor's `alive` (both every 1 s) keep a healthy helper under it: the monitor is otherwise silent while nothing changes | Write stdout inside the IO block (openwhispr); restart only on exit | openwhispr calls `processInput` from the IO block (`macos-audio-tap.swift:293`) and loops on `write` there (`:471`): if main stops reading, the 16 to 64 KB pipe (0.5 to 2 s of audio) fills and blocks the audio IO thread. A stopped or deadlocked helper never exits, so restart-on-exit alone leaves call audio dead until the user acts. |
| Tap rebuild on device change | The helper listens to the default output device and the tap format, and rebuilds tap and aggregate (300 ms debounce), emitting `restarted`. An opt-in Mac selftest switches the default output between two devices while `afplay` plays a tone and asserts non-zero audio returns within 2 s with a `restarted` event (`make test-native-route`; audible, so not part of `make check`) | Build once (openwhispr) | openwhispr's own comment: "the tap is built once and never follows the machine", which hid openwhispr#1990. AirPods switch the output and the tap format (anarlog re-probes the format for this). The rebuild is the riskiest Swift path, so one real call is not enough proof. |
| Mic capture | Stays in the renderer (`getUserMedia`), plus device-change recovery: follow the new default input within 250 ms and show "Switched to <device>" on screen (a capture event, never a loud warning) | Move the mic into the helper | The mic path works today. One native change at a time. A removed device Roger recovers from is not a cut, so the exit check no longer uses it as one. |
| Helper build, bundling and signing | `swiftc -swift-version 5 -O -target <arch>-apple-macosx14.2` with the installed Swift 6.4 command line tools, no Xcode, no SwiftPM. Output `apps/desktop/native/bin/roger-audio` (git-ignored), shipped by `extraResources` to `Contents/Resources/bin/roger-audio`. `install-mac.sh` signs the app with `--deep` as today (Electron's frameworks and helper apps), then re-signs `roger-audio` with `--identifier ai.linkt.roger.audio`, then reseals the app's top level without `--deep`; it then reads both designated requirements and fails the install on a mismatch | A nested `.app` with its own Info.plist; signing every Electron part inside-out by hand | `--deep` treats the helper as nested code and may sign it with an identifier made from its file name; re-signing the helper after the app breaks the app's seal unless the top level is resealed. Keeping `--deep` for Electron's own parts avoids listing them by hand. Bundling as in openwhispr (`scripts/build-macos-audio-tap.js`, `extraResources` to `bin/`). Spawned by Electron main, the helper's TCC "responsible process" is Roger, so the prompt says Roger and the grant uses Roger's `NSAudioCaptureUsageDescription`. Language mode 5 avoids strict-concurrency noise around Core Audio C callbacks. |
| Permission check for system audio | No public API reads it, and a refused or still-pending tap delivers silence with no error (AudioCap README, meetily `audio/permissions.rs`). The setup screen runs `roger-audio probe` while `/usr/bin/afplay` plays a short system sound: heard means granted. The first silent probe for a signing identity reports "pending: answer the macOS dialog, then press I allowed it"; later ones report "not allowed, or the Mac is muted". After a grant (that button, or Roger regaining focus after a Start or probe while system audio is unverified) main rebuilds the tap, because a tap built while the prompt was up stays silent. A success is stored with the signing identity (T1), so "verified" resets when the identity changes. T1 checks on macOS 26 which System Settings anchor opens "System Audio Recording Only" and hardcodes that one | Private `TCCAccessPreflight` (anarlog `crates/tcc`); an anchor fallback chain | Private TCC APIs are on the "not copied" list in `docs/research/reference-repos.md`. `shell.openExternal` resolves even for an anchor System Settings does not know, so a fallback chain cannot detect that its first anchor failed. |
| Timeline | Every chunk carries the wall-clock time of its first sample, taken where it was captured: the worklet posts `currentFrame` and the renderer maps each chunk to `Date.now()` minus its first frame's age on the monotonic clock (`performance.now()` less the frame's `performanceTime` from `AudioContext.getOutputTimestamp()`), never `performance.timeOrigin + performanceTime`: Chromium's monotonic clock stops while a Mac sleeps, so that sum falls behind by every sleep since the page loaded, and past a day main refuses every mic chunk (M2-T2, `AudioChunkMessage.capturedAtMs`); the helper converts `AudioTimeStamp.mHostTime` to wall clock. `AudioTimeline` per source and STT connection records runs of contiguous audio; a new run starts when a chunk's capture time and the time its predecessors' samples predict drift apart by more than 250 ms. A vendor time maps to meeting time through its run. Each vendor stream keeps its own timeline, as the landed code keeps its own offset origin (a reopened stream's time zero is its first held chunk); runs replace the landed rule that drops held audio before a gap of over 1 s (`BUFFER_GAP_MS` in `CaptureSession.ts`) | First-chunk offset plus vendor time (M1); runs split by arrival time in main | M1's mapping drifts by the length of any gap: a 10-minute sleep would stamp later lines 10 minutes early. Arrival times in main jitter with GC pauses and synchronous SQLite writes, and the two streams arrive by different paths (renderer IPC, helper pipe), which would split runs falsely and eat into the ±700 ms echo window. Runs also give reconnect replay and the backup exact offsets. |
| STT reconnect (deltas on the landed G2 and G3) | Landed and kept: a failed session reopens with its next chunk after a backoff (2 s doubling to 60 s, reset after a minute up), with a fresh token, every open through `SttOpenBudget`, at most `sttReopenBufferMs` (3 s) of held audio sent first; states `paused` and `retrying`. M2 adds: (1) dead-socket detection in the shared core, `SttConnection`: a WebSocket ping every 1 s while audio flows (the keep-alive rule: none after `keepAliveForMs` without audio), and the socket is dead when neither a pong nor a message has arrived for 4 s; dead is a fatal error, so the landed retry takes over; it runs for every vendor and the conformance suite checks it. (2) Main polls `net.isOnline()` every 1 s; when it turns false, both sources go `offline` at once: their sockets are terminated (no finish sequence, the network is gone), audio is held as in G2, and nothing reopens or fetches a token until it is online again; then each source reopens with its next chunk, through the budget, without a backoff wait (from wave 6, a source M3-T20's silence gate had closed stays closed until speech: the reopen decision stays in `pushAudio`'s `paused` branch so T20 changes it in one place). (3) Gap rows: whenever a source's audio reached main but not the vendor (a failure, offline, a budget wait), the window from that source's watermark to the first audio the new stream carries becomes a `transcript_gaps` row (reasons `stt_failed`, `offline`, `budget`) for T16 to re-run from the backup; a window with no audio at all (a stall) is a capture event, not a gap. The gap's start is decided in one function: from wave 6, M3-T20 makes it the speech onset for a source its gate had closed, and a gated window itself is never a gap, or T16 would re-run minutes of billed silence. (4) The last final's end per source is published as that stream's watermark (T14b). No replay beyond the held 3 s, for any vendor: AssemblyAI cannot take audio faster than real time, and the backup re-run brings the window back after Stop | `ResilientSttStream` wrapping every adapter (this plan's first draft): it would open sockets outside `SttOpenBudget` and fight the landed reopen (house rule 9); ping every 5 s and dead after 10 s; the renderer's `offline` event; a 30 s replay ring | With 5 s and 10 s a cut is declared dead 10 to 15 s after it lands, past the 10 s done-when, and `ws` gets no prompt error when the interface goes down. Now the worst case is dead at most 5 s after the last pong, or 1 s after Wi-Fi goes off. Polling in main needs no renderer, which may itself be reloading. Terminating at once while offline stops a half-open socket from billing until the vendor's 120 s idle timeout. Watermark from anarlog `crates/transcript/src/channel_state.rs`. A replay ring would have to be paced at 1x behind live audio for AssemblyAI (M3 design), so the call would run late; the gap re-run has no such cost. |
| Silence and no-audio warnings | Loud, per source: no chunk for 5 s (M1; the landed stall close then closes that source's session at 30 s, G2, and these warnings never open or close a session themselves); track or helper ended; helper killed by the 3 s watchdog; mic dead signal for 8 s, where dead is a peak of at most 1 LSB or, only if T11's Mac check finds input volume 0 is not digital zero, a level flat for 8 s more than 40 dB under the running floor; STT offline. "Call audio never non-zero for 20 s after start" is loud only while system audio is unverified for this signing identity (no successful probe and no non-zero tap audio since the identity changed); once verified it shows on screen only. Call audio dead for 8 s mid-call shows on screen only (D3) | One rule for both streams; the 20 s rule always loud | Real mics never produce exact zeros (anarlog `DropoutMonitor`). With a global tap, call audio is exact zeros whenever nothing plays, so an always-loud 20 s rule would fire on every early join, waiting room and M5 "start just before the meeting", and teach users to ignore warnings. Apple Silicon may apply a minimum gain at input volume 0 rather than a hard zero, hence the Mac check. |
| **D4 owner** Mic dead threshold on Bluetooth inputs | 30 s on a Bluetooth input, 8 s elsewhere. This deviates from "warning within 10 seconds" for an AirPods mic that goes silent; the exit-check mic cut runs on the built-in mic | 8 s for every input | AirPods gate the mic between words and can give 60 to 90 s of silence at start (meetily works around it); 8 s would raise loud false warnings on most AirPods calls. Tuned on the AirPods exit call. |
| **D3 owner** Loud for call audio silence | On-screen warning at 8 s of digital silence on call audio; a notification only after 60 s of it while the mic hears speech, or 180 s regardless | Notify at 8 s | Notifying at 8 s would fire in ordinary pauses. A quiet call and a cut tap look the same, so openwhispr waits 180 s before even a soft warning. Every cut that stops delivery (helper, renderer, device, network) is loud within 10 s either way. |
| Where warnings reach the user | `Notifier`: an Electron `Notification` when Roger is not focused, one per warning spell, rate-limited per warning kind and source (at most one every 2 minutes for the same kind and source; a different kind or source always notifies); on the `failed` event, `app.dock.bounce('critical')` and a dock badge | One global limit of one every 2 minutes; a floating always-on-top pill | A global limit would hide a second, different cut (a dead mic 60 s after STT went offline), and the exit check runs three cuts back to back. Electron 42+ uses `UNUserNotificationCenter`, which needs a signed app and fails silently otherwise; the self-signed build is unverified. The pill is M11's "clear light". |
| **D2 owner** Echo | Text-level dedupe in main, confirmed by spike T0 before sign-off. A mic word matches a call-audio word with the same normalised text within ±700 ms on the meeting timeline. A mic line is hidden when at least 70% of its words match (lines of 1 or 2 words: all words, and at least 50% time overlap). In a mixed line (under 70%), runs of 3 or more matched words are trimmed and the original text kept in a local column; a line trimmed to nothing is hidden. Re-run lines (T16) pass through the same filter against stored call-audio lines. Off when the output is known headphones. Hidden lines stay in SQLite with `suppressed_reason = 'echo'`, are not uploaded, and can be unhidden, which uploads them. If T0 shows that `getUserMedia({ audio: { echoCancellation: 'all' } })` removes call audio from the mic in Electron 44 without ducking other apps, it is turned on too and the text filter stays as the backstop | Acoustic echo cancellation only; signal correlation (openwhispr `meetingEchoLeakDetector.js`) | Chrome 141 added `echoCancellation` values `all` and `remote-only`, letting a page choose how much system playout is removed from the mic ([Chrome 141 beta](https://developer.chrome.com/blog/chrome-141-beta), [release notes](https://developer.chrome.com/release-notes/141)). Electron 44.5.1 ships a newer Chromium, but neither page says `all` works on macOS or whether it goes through Apple's voice processing, which can duck other apps' audio: T0 measures it. The older claim that Chromium only cancels its own playback held before 141 and is dropped. Correlation needs many tuned thresholds and can mute real speech. Text matching is vendor-free and testable with plain unit tests; trimming keeps the user's own words in a line that mixes both. |
| Upload of mic lines | While the echo filter is on, a mic line is held (`upload_after` set to its creation plus 120 s) until the call-audio stream's watermark passes the line's end plus 700 ms, or that stream closes (a call-audio session closed by the stall pause or by M3-T20's silence gate counts: no echo twin can come from a closed session), whichever comes first; the 120 s is only a cap. The uploader never sends `end` for a meeting that still holds lines, and looks at a remotely ended meeting again whenever it has lines that can be uploaded (re-run, unhidden, released). At startup every hold an earlier run left (a line created before the uploader's `launchedAt`) is settled (checked once against stored call-audio lines, then released) before the uploader's first tick; a hold of this run is never touched, because a retried settle can run after a Start. From the batch listing until its answer, a line the uploader is sending (`markSegmentsSent`, in memory) can no longer be hidden, trimmed or held: Postgres may already hold it as sent | A fixed 6 s hold; upload at once and retract later | A fixed hold assumes the call-audio twin lands within 1 to 2 s; while that stream reconnects or replays (its backoff is independent of the mic's), echo lines would upload before their twin and Postgres would get doubled text. M1 dropped a meeting from sync for good once it was ended remotely (M1's `TranscriptUploader.ts:196-198`, `SqliteTranscriptStore.ts:111-112`, before T3b), which would strand every later line. The API accepts appends to an ended meeting and a re-sent end is idempotent (`docs/api-contract.md`), so reopening the loop needs no API change. |
| **D5 owner** Audio backup | Per stream WAV files of at most 60 s, a new file at every timeline run. A closed file is turned into AAC m4a, 48 kbps, by `/usr/bin/afconvert` in the background (the WAV stays if that fails). Retention 7 days (`audioRetentionDays`, 0 to 30; 0 turns backup off), checked at startup and hourly; a meeting with an unrecovered gap keeps its audio until the gap is recovered, the user deletes it, or 30 days pass, and the capture report and a Home card say so from day 7. Paused below 2 GiB free disk. Folder `userData/audio/<meeting>`, mode 0700. Never uploaded | `MediaRecorder` webm/opus; WAV only; FLAC | System audio now reaches main as PCM, not a `MediaStream`. WAV is crash-safe (the header is repaired from the file size); AAC is about 43 MB per call hour for both streams against 230 MB of WAV. afconvert ships with macOS: no dependency. 60 s chunks and a disk reserve from anarlog `listener-core/.../recorder/chunks.rs`. The roadmap keeps audio "so a failed transcript can be re-run"; deleting it while a re-run is pending defeats that. |
| Gap re-run | After Stop, at startup and on demand: stream each gap's backup audio (plus 1 s each side) through the same `SpeechToText` adapter (from the registry) with a fresh token, drop words that overlap lines already stored, pass mic lines through the echo filter against stored call-audio lines, save the rest with `origin = 'rerun'`. Every re-run session is an open like any other: it takes a slot in the shared `SttOpenBudget`'s per-minute window first (the vendor counts per account; T4 builds the budget in `createCaptureRuntime.ts` and injects it, so T16 shares it without editing `CaptureService.ts`), through the minute-only acquire, never from a live meeting's allowance (the meeting with gaps is the one whose failures spent it, and after Stop the count still holds that meeting's opens), and is never opened while a recording runs; the core paces it at real time; its usage is added to that meeting's `stt_usage` row, because the vendor bills it | A batch endpoint on the API | Audio never leaves the Mac in Phase 2 (C6), and it reuses the streaming adapter. Without the echo pass, a re-run gap on laptop speakers brings the doubles back. Whole-call re-runs are M12. |
| **D6 owner** Call detection | Helper monitor polls Core Audio process objects every 1 s (`kAudioHardwarePropertyProcessObjectList`, `kAudioProcessPropertyIsRunningInput`). A PID resolves to its outermost app bundle; a process outside any bundle resolves by executable path, and `/usr/libexec/avconferenced` and `callservicesd` count as "FaceTime or phone call". Allowlist of call apps (Zoom, Teams, FaceTime, Webex, Slack, browsers). Offer "Take notes" after 5 s of mic use (15 s for a browser), 10-minute cooldown after a dismiss. Never auto-start | Deny-list of any mic app (anarlog); window titles; auto-start | No permission needed. anarlog `crates/detect/src/list/macos.rs` does the same lookup, and special-cases the call daemons there (`APPLE_CALL_DAEMON_IDS`, lines 11-16) and in `apps/desktop/src/stt/meeting-apps.ts` ("iPhone Call"): FaceTime audio runs in `avconferenced`, which has no `.app` around it. anarlog's listeners stop firing on macOS 26 ([home-assistant/iOS#5635](https://github.com/home-assistant/iOS/issues/5635)), so poll. A browser using the mic is a weaker signal, hence 15 s (anarlog's default). |
| Starting from the offer | `CallDetector` hands each detection to M5's `PromptService.offer({source: 'call_detected', app})` (M5 D5, OD-24 in `phase-2-build-order.md`). M5's panel shows the card; "Take notes" goes through M5's start request (M5-T5) with `startSource: 'call_detected'`, or `notification` when exactly one calendar event is running or starts within 5 min. M2 builds no card or notification of its own for the offer. Gate confirmed on 2026-10-06: M5-T1 (check constraint), M5-T4 (`StartSource`, contract) and M5-T5 (desktop type and tests) carry `call_detected` | M2's own start path and card | One way to start a note from outside the window, not two. Without the value, Postgres rejects every offer-started meeting and the exit check's 2 offer calls cannot pass. |
| Auto-stop | Stop when no call app has used the mic for 15 s (30 s for a browser) and a call app was seen during the session, through the normal stop with a new `call-ended` reason in `capture/stopReasons.ts` (the landed no-speech and 4-hour stops stay as the backstop); notify "Stopped: the call in Zoom ended". After a wake the release clock starts at 60 s. A manual start with no call app seen never auto-stops | Ask first, as anarlog does for browsers | Muting keeps the mic running in Meet and Zoom; the debounce covers AirPods switching devices. |
| Sleep and wake (a delta on the landed G4) | `powerSaveBlocker('prevent-app-suspension')` while recording, owned by T18 only. Today `lifecycle.ts` stops the whole recording on `suspend` (`system-sleep`). T18 moves `suspend` to `PowerCoordinator`: both sources' sessions finish and close (T6's suspend path, `asleep`), nothing reopens while asleep, the event is logged. On `resume` after a sleep shorter than `noSpeechStopMs` (15 min): the helper restarts, the renderer reopens the mic, and each source reopens with its next chunk through the budget, as after a stall (from wave 6 a source M3-T20's gate had closed before the sleep waits for speech instead). After a longer sleep the recording stops at wake with the landed `system-sleep` reason and notice | Keep sockets open; keep G4's stop on every sleep | Sockets do not survive sleep, and a socket left half-open bills until the vendor's 120 s idle timeout, so they close first, as G4 intended. Stopping on every sleep would split the exit check's lid-closed call into two meetings. A lid shut for 15 minutes or more is not a pause in a meeting, and a no-speech clock running across it would stop the recording at wake anyway. New timeline runs keep post-wake lines at the right time. |
| **D7 owner** Crash recovery | Renderer gone: main reloads the page and the renderer reopens the mic because main is recording. This replaces the landed G4 stop on `render-process-gone` and on a reload (`lifecycle.ts`, T12); until the mic's chunks return, the landed stall close shuts the mic session after 30 s, so a crash costs at most that, and a reload that fails (`did-fail-load`) still stops the recording with `renderer-gone`. Helper gone or hung: the watchdog and restarts above. App killed while recording: the monitor helper sees its parent die and relaunches Roger once per meeting with `open -g -b ai.linkt.roger --args --relaunched`. At launch, a meeting left open whose last activity is under 10 minutes old resumes in the same meeting id when a call app holds the mic or the launch came from that relaunch (`--relaunched` in argv, the only sign of it): it is not ended, the gap is recorded, capture continues, and Roger shows "Roger restarted and kept taking notes" with a Stop button. A resumed meeting keeps its cost record: its saved `stt_usage` row is the base the new meter adds to (the adapter's own count restarts at zero). Its open allowance (`sttOpensPerMeeting`) starts afresh: the saved `sessions_opened` also counts M3-T20's gate reopens and T16's re-runs, which count in the per-minute window only, so seeding the allowance from it could refuse the resume's own Start, and the relaunch happens once per meeting, so a fresh allowance is spent at most twice. Otherwise it is ended as in M1. Open WAV headers are repaired and the crash tail becomes a gap the re-run fills | End the meeting at launch and offer a new one; no relaunch | One call must stay one meeting, or the per-meeting count and quote checks break. While Roger is dead nobody tells the user that capture stopped, which is the core failure this product exists to fix. A deliberate Force Quit looks the same as a crash, hence once per meeting and a visible Stop. |
| Window lifecycle | Taken from M5-T11 (close hides, `backgroundThrottling: false`, `activate` shows the window; M5-T11 also stops the landed G4 `window-closed` stop from firing on a hide). M2 adds only `render-process-gone` handling (T12, in `lifecycle.ts`) | Build it in M2 too | Detection and mic capture need a live renderer with the window closed; M5 needs the same for reminders. One owner. |
| Renderer tests | Seams for `mediaDevices` and `AudioContext` with unit tests on fakes (started in M1: `AudioCaptureController` already takes its devices as a parameter and has node tests for `followMain` and the start generation), plus one Electron smoke test with Chromium's fake audio device (`--use-fake-device-for-media-stream`, `--use-file-for-fake-audio-capture`), the fake STT and the fake helper. It runs the unpackaged build with `ROGER_E2E=1`, honoured only when `!app.isPackaged`: no macOS TCC gate (`askForMediaAccess` is never called), a dummy API token, a temporary `--user-data-dir` | Unit tests only | The worklet and `getUserMedia` wiring were only ever checked by a real call (M1 gap). Launched by an agent, the responsible process for a TCC prompt is the terminal or Electron.app, so `ensureMicrophoneAccess` (`permissions.ts`) would hang the run on a dialog, and `index.ts` refuses to start without a token. |
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
                                   net.isOnline poll (1 s, T6 slot)     |-> AudioBackupWriter -> audio/<meeting>/*.wav -> afconvert -> .m4a
                                                                        '-> CaptureSession (SttOpenBudget, pause/retry/offline, gap rows)
                                                                               -> AudioTimeline -> SttStream x2 (stt/core: pacing, ping liveness) -> vendor
                                                                               finals + watermarks -> SQLite -> EchoSink (hide, trim, hold)
                                                                               -> TranscriptUploader (holds, reopened ended meetings)
                                                                   monitor: mic users + output route --stdout--> MeetingAppMonitor -> CallDetector
                                   powerMonitor -> PowerCoordinator (was lifecycle.ts's stop)   parent dies while recording -> open -g -b ai.linkt.roger
                                   CrashRecovery at launch: resume or end
```

### Local schema (SQLite migration 4)

Migration 3 is taken: M1's cost guards added `stt_usage` (one row per meeting, no foreign key on
purpose). This migration leaves that table alone.

```sql
ALTER TABLE segments ADD COLUMN suppressed_reason TEXT CHECK (suppressed_reason IN ('echo'));
ALTER TABLE segments ADD COLUMN echo_of TEXT;            -- the call-audio segment it repeated
ALTER TABLE segments ADD COLUMN original_text TEXT;      -- set when echo words were trimmed; local only
ALTER TABLE segments ADD COLUMN upload_after TEXT;       -- hold cap; NULL = may upload now
ALTER TABLE segments ADD COLUMN origin TEXT NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'rerun'));
ALTER TABLE meetings ADD COLUMN stop_reason TEXT;        -- a StopReason (capture/stopReasons.ts), or crash
CREATE TABLE transcript_gaps (id, workspace_id NULL, meeting_id FK CASCADE, source, start_ms, end_ms, reason, created_at, recovered_at, recover_error);
CREATE TABLE audio_files (id, workspace_id NULL, meeting_id FK CASCADE, source, start_ms, end_ms, path, format CHECK IN ('wav','m4a'), bytes, created_at, closed_at, deleted_at);
CREATE TABLE capture_events (id INTEGER PK, workspace_id NULL, meeting_id FK CASCADE, at, offset_ms, source NULL, kind, detail_json);
CREATE TABLE app_state (key TEXT PK, value TEXT, updated_at);   -- device state, e.g. system audio verified for an identity
```

"Can upload" means not synced, not rejected, not suppressed, and `upload_after` NULL or past.
The unsynced queries and counts use it; without it, "N lines waiting" would never reach zero.
`meetingsNeedingSync` selects meetings not ended remotely, plus any meeting that has a line that
can upload. Unhide clears `suppressed_reason` and `echo_of`. M5-T5 adds `meetings.start_source` to
the same file as migration 5 and M3-T19b adds `stt_usage.synced_at` and `gated_ms` as migration 6;
this one is migration 4 (fixed in `phase-2-build-order.md`).

### Needs from other Phase 2 plans

| Need | Owner | Used by | Gate, and until it lands |
| --- | --- | --- | --- |
| Shell slots: a full-window setup route reachable on first run and from a menu item; a warning banner slot above every page (warnings must show wherever the user is); capture status, audio note and capture report regions on the meeting page; a card slot on Home (audio kept for a re-run) | M4-S1 (setup route, banner and Home card slots), M4-S4 (meeting-page regions) | T19, T20a, T20b | Confirmed: M4 carries them as numbered tasks in waves 1 and 2 (`phase-2-build-order.md`). Each mount task owns its own `app/slots/<task>.ts`; nothing mounts in M1's window. |
| `PromptService.offer` (the one prompt panel), `StartCaptureRequest`, `requestStart` / `takePendingStart`, and `call_detected` in `StartSource`, the Postgres check constraint, `api-contract.md` and M5-T5's tests | M5-T9b, M5-T5 | T17b | Confirmed (see "Starting from the offer"); T17b runs in wave 7, after both. |
| Close hides the window, `backgroundThrottling: false`, `activate` shows it | M5-T11 | The exit check (not a build dependency of T17b) | Detection works while the window exists. |
| M5-T5 adds `start_source` to the create payload in `TranscriptUploader.ts`, which T3b owns | M5-T5 | - | T3b lands first; M5-T5 rebases on it and keeps T3b's tests green. |

### Contract additions (desktop only)

- `shared/capture.ts` (keeps every landed field: `streams` with `paused` and `retrying`,
  `streamMessages`, `meter`, `notice`): stream state `offline` (the landed `retrying` is the
  reconnecting state, so no `reconnecting` value is added); per source `signal` (`unknown`,
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
  echoOf, text }`, one event for all three, which M3-T7 renders), unhide segment (a `hidden` line
  only: main refuses a `trimmed` one); capture report, re-run gaps and delete audio for a meeting
  (both answer the updated report), and `CaptureStatus.rerun` (meeting, `waiting` or `running`,
  gaps, finished) for re-run progress. The call-detected offer has no M2 channel: M5's prompt
  IPC carries it. `ipc-validation.ts` checks every new payload; meeting ids must be UUIDv4.
- `config.json` keys: `systemAudioCapture`, `audioBackup`, `audioRetentionDays` (0 to 30, the
  keep-for-re-run limit), `callDetection`, `echoFilter`, validated like the existing keys. No key chooses the helper binary. The cost guards
  stay in `costGuards.ts` (loaded by `config.ts`, a refused value blocks Start); M2 adds none.
- Helper protocol: `roger-audio tap --sample-rate 16000 --chunk-ms 100` writes frames to stdout:
  a 16-byte header (ASCII `RGA1`, payload bytes as u32 LE, wall-clock ms of the first sample as
  f64 LE) then 3,200 bytes of Int16; JSON lines on stderr (`ready {format}`,
  `restarted {reason}`, `stats {peak, frames, dropped}` every 1 s, `warning`, `error {code}`);
  stdin `rebuild` rebuilds the tap, EOF exits. `roger-audio monitor --parent-pid <pid>` writes
  JSON lines (`mic_users [{pid, bundleId, path, name}]`, `route {output, input}`) on change and
  `alive` after every 1 s poll (for the watchdog), takes stdin `recording on` and
  `recording off`, and on parent death while recording runs
  `open -g -b ai.linkt.roger --args --relaunched` once (`--relaunch-dry-run` prints it instead,
  for tests).
  `roger-audio probe --seconds 2` prints `{"event":"listening","seconds":N}` once its tap runs
  (main starts the system sound on that line), then `{"event":"result","peak":P,"audioMs":M}`:
  `P` > 0 is heard; `M` 0 means the tap never ran (also a stderr `no_audio` warning). A route or
  tap-format change before anything was heard ends it with exit 1, an `error` event
  `route_changed` and no result line (`Probe.swift` header). `roger-audio selftest` checks the
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
- [x] **M2-T1 Signing self-check, field report, settings anchors** · S · desktop, docs · depends
  on: none. Owns `src/main/signing.ts` (+ test): reads the designated requirement at startup and
  reports `local-identity`, `developer-id`, `adhoc` or `unsigned`, plus a hash of the requirement
  that "system audio verified" is stored against. Owns `src/main/settingsPanes.ts` (+ test): the
  anchors for Microphone and for "System Audio Recording Only", checked by hand on macOS 26 and
  hardcoded. Adds the `tccd` log recipe (`/usr/bin/log show ... "Failed to match existing code
  requirement"`) to the failure log (now `apps/desktop/CLAUDE.md`) and the field report to the M1
  exit check log. Mac check: Start, grant, quit, relaunch, Start again with no prompt and call
  audio present.
- [x] **M2-T2 Contracts, config, IPC validation** · M · desktop · depends on: P2-F1.
  Owns `src/shared/capture.ts`, `src/shared/ipc/capture.ts`, `src/shared/ipc/setup.ts`, their
  bridges in `src/preload/bridges/` and fakes in `preview/fakes/`, `src/main/config.ts`,
  `src/main/ipc-validation.ts`. Types,
  channel names, preload bridges, thresholds, config keys and payload validators above (audio
  chunk `capturedAtMs` finite and within a day of now; meeting ids UUIDv4); no behaviour. Keeps
  every landed `CaptureStatus` field and the `SttStreamState` values (`paused`, `retrying`), adds
  only `offline`; `config.ts` keeps loading the cost guards and their errors as it does today.
  Also owns the `offline` case of `describeStream` in `src/renderer/src/format.ts` (+ a case in
  `format.test.ts`): that switch covers every `SttStreamState` with a `string` return and no
  default, so a new state without its case fails the type check (TS2366) in wave 1. M2-T20a
  rewords the stream text in wave 5.
- [x] **M2-T3 Local store migration 4** · M · desktop · depends on: none.
  Owns `src/main/store/*` except the sync statements (T3b). Schema above, as migration 4 (3 is
  M1's `stt_usage`; its `saveSttUsage` and `getSttUsage` stay as they are); store methods for gaps,
  audio files, capture events, app state, suppress, trim, unhide, hold and release; the in-memory
  store kept in step. Also owns the backup fixture `apps/desktop/test/fixtures/backup/` (a small
  `roger.sqlite` built by this migration plus short WAV and m4a chunks with a gap, and the script
  that makes them), moved here from T15 so M3-T12 can start in wave 2; T15's tests read it.
- [x] **M2-T3b Uploader: no stranded lines** · S · desktop · depends on: T3.
  Owns `src/main/upload/TranscriptUploader.ts` (+ test) and the sync statements in
  `SqliteTranscriptStore.ts` and `InMemoryTranscriptStore.ts` (`meetingsNeedingSync`, unsynced
  lines, counts, held count). Rules: a remotely ended meeting with a line that can upload is synced
  again and its end re-sent; `end` is never sent while the meeting holds lines
  (`countHeldSegments`); a startup settle (T14b's) runs before the first tick so holds left by a
  crash are settled first. As built, that hook is set with
  `setBeforeFirstTick((launchedAt) => ...)` from T14b's runtime slot (the uploader is built before
  the capture runtime and started after it), is handed the uploader's launch instant, and must
  touch only holds on lines created before it. The store also gained `markSegmentsSent`: from the
  batch listing until its answer, `suppressSegment`, `trimSegment` and `holdSegment` refuse a line
  being sent, as they refuse an uploaded one.
- [x] **M2-T4 Capture pipeline seams** · M · desktop · depends on: T2, T3 (`meetings.stop_reason`).
  Owns `src/main/capture/CaptureService.ts`, `src/main/capture/AudioFanout.ts`,
  `src/main/capture/createCaptureRuntime.ts`, `src/main/capture/SttOpenBudget.ts` (+ test), the
  `[slot M2-T4 …]` blocks of `src/main/index.ts`, `src/main/ipc.ts`, and the wording of
  architecture rule 9 in `CLAUDE.md`. Audio fan-out to sinks (`onChunk(source, pcm,
  capturedAtMs)`; until T12 sends capture times, a chunk is dated at its arrival minus its own
  length, the first-sample estimate `CaptureSession` already used), session event listeners
  (`onRecording({ started, ended })`: T6, T14b, T18 and M3-T19b reach the live `CaptureSession`
  through `started`; `ended` carries `stopFailed`, true when Stop threw before the meeting was
  ended), `start({ resume: { meetingId } })` for resume, which reads the meeting's start and its
  saved `stt_usage` row from the store itself (the row seeds the meter; the open allowance starts
  afresh, D7). The shared budget: `createCaptureRuntime.ts` builds the one `SttOpenBudget` and
  injects it into `CaptureService` (an optional option; the landed construction from the guards
  stays the default, so the G3 tests build it as before) and into the T16 slot, so T16 never edits
  `CaptureService.ts`. `SttOpenBudget` gains a minute-only acquire (for example
  `acquire(count, 'minute')`: a slot in the per-minute window that never counts toward
  `sttOpensPerMeeting`), which T16's re-run and M3-T20's gate reopens use, with its test (it still
  refuses a full minute; it never spends or reads the meeting's count). Its doc comment ("must call
  acquire() right before stt.openStream and nowhere else") and rule 9 ("passes `SttOpenBudget` in
  `CaptureSession`, right before `openStream`") are reworded together to the rule that holds:
  every vendor session open acquires first, right before `openStream`, from `CaptureSession`
  (Start, stall and failure reopens on the meeting's allowance, gate reopens in the minute only),
  from T16's re-run (the minute only) and from M3-T11's bench (its own budget); no adapter opens a
  socket. A status-contributor seam (T10, T11, T14b and T15 add status fields without editing
  `CaptureService.ts`), `stop()` writing its `StopReason` to `meetings.stop_reason`, and named
  slots in `createCaptureRuntime.ts` for T6, T10, T11, T14b, T15, T16, T17a, T17b, T18, T19 and
  M3-T19b. The landed cost guards move as they are: the `SttOpenBudget` kept across meetings, the
  stall and forgotten-stop monitor, the meter and `stt_usage` saves, the stop notice, the `phase`
  getter `lifecycle.ts` reads. The landed comment in `pushAudio` that puts "M2's silence warning"
  there now points at the fan-out (T11's sink). `[slot M2-T4 runtime]` in `index.ts` keeps the
  cost-guard wiring
  (`config.costGuards` into `createSpeechToText` and `CaptureService`, `config.errors` into the
  startup error, the `RecordingLifecycle` and `watchApp`). No behaviour change (the minute-only
  acquire has no caller until wave 6); every M1 test (G1 to G7 included) stays green.
- [x] **M2-T5 Audio timeline** · M · desktop · depends on: T4.
  Owns `src/main/capture/AudioTimeline.ts`, `CaptureSession.ts`. Runs split by capture-time drift
  over 250 ms, mapping as designed; `CaptureSession` maps finals and words through it. One timeline
  per vendor stream, so a reopened stream (G2, G3) keeps its own time zero; runs replace the
  landed `BUFFER_GAP_MS` drop of held audio. The G1 to G3 tests in `CaptureSession.test.ts` stay
  green with their meeting-relative offsets. As built: a span (a line, a word, an interim) maps as
  one unit through `AudioTimeline.toCapturedSpan`, which cuts a spill of 200 ms or less across a
  run boundary off at the boundary; a final's span is widened to hold its words (`EchoFilter`
  reaches call-audio lines by span); offsets are rounded to whole ms (the API's `OffsetMs` is an
  int). Its tests stand in for the soak at the session level only: the service-level 2-hour soak
  (`CaptureService.soak.test.ts`, Tests below) had no owner and is M3-T4b's (wave 5).
- [x] **M2-T6 STT liveness, offline and gap records** · M · desktop · depends on: T3, T4, T5, M3-T5
  (file order in `stt/core`). A delta on the landed reopen (G2, G3): it adds no wrapper, no
  reconnect loop and no replay (design row "STT reconnect"). Owns: in the shared core, the ping
  liveness in `src/main/stt/core/SttConnection.ts` (ping every 1 s while audio flows, dead after 4 s
  with no pong and no message, then a fatal error and a terminated socket; a socket that never
  answers a ping in its first 10 s falls back to messages, send errors and the offline poll, and
  logs it), with its cases in `src/main/stt/conformance.test.ts` and the pong control in
  `stt/testing/fakeVendorServer.ts`, so every registered vendor proves it;
  `src/main/stt/networkStatus.ts` (+ test, `net.isOnline()` every 1 s) and the T6 runtime slot that
  feeds it to the live session; in `src/main/capture/CaptureSession.ts`: `suspendStreams(reason)`
  (`'offline'` or `'asleep'`) and `resumeStreams(reason)` (terminate at once when offline, finish
  and close when asleep; hold audio as G2 does; no token fetch and no open while suspended; T18 uses
  `asleep`), the `offline` state, gap rows from the watermark to the new stream's first audio
  (`stt_failed`, `offline`, `budget`), capture events for every pause, failure, suspend and reopen,
  and the published watermark per source. No edit to `CaptureService.ts` or to any vendor file.
  Where a gap starts is one function, and whether a `paused` source reopens stays in `pushAudio`'s
  `paused` branch: M3-T20 (wave 6) changes both for gated sources (a gap from the speech onset;
  a gated source stays gated after `resumeStreams(reason)`), and a copy elsewhere would miss it.
  Say so in a comment at each. Merges before M3-T6b in wave 4. As built (branch `p2/m2-t6`, merging
  after wave 4's other seven, so after M3-T6b): the reason of `resumeStreams` is required and the
  two reasons stack (each resume lifts only its own); `stt/SpeechToText.ts` gained an optional
  `SttStream.terminate?()`; the pong record is kept per adapter, so a vendor that answered a ping
  once keeps the dead-socket check on its later streams.
- [x] **M2-T7 Helper: tap, framing, build** · M · desktop (Swift) · depends on: P2-F3.
  Owns `apps/desktop/native/roger-audio/{main,Protocol,Tap,RingBuffer,Lifecycle,SelfTest}.swift`,
  stub `Probe.swift` and `Monitor.swift` (T7b and T8 replace their bodies, so neither edits
  `main.swift`), `apps/desktop/scripts/build-native.sh`, and the Darwin lines of `make check`
  (`roger-audio selftest` plus `pnpm test:mac` when `uname` is Darwin). P2-F3 already added the
  `native` target, the `test:mac` script, the `*.mac.test.ts` exclusion, `vitest.mac.config.ts`
  and `native/bin/` in `apps/desktop/.gitignore`. Tap with rebuild on route change, ring buffer
  and writer thread, frame header with capture time, stdin `rebuild`, exit on stdin EOF or parent
  death. `main.swift` dispatches every subcommand.
- [x] **M2-T7b Helper: probe and route selftest** · S · desktop (Swift) · depends on: T7.
  (Code merged; `make test-native-route` has not yet run on a Mac: a person runs it once and
  attaches the log.)
  Owns `native/roger-audio/Probe.swift` and `selftest --route-switch` (P2-F3 added the
  `make test-native-route` target). The route test makes a temporary multi-output device,
  plays a tone with `afplay`, switches the default output with `AudioObjectSetPropertyData`, and
  asserts non-zero audio within 2 s and a `restarted` event, then restores the output. As built,
  the device is published (`private` 0), not private: a private aggregate is visible only to the
  process that made it, and `afplay` plays only to outputs it can see. It has a fixed UID
  (`ai.linkt.roger.audio.route-test`), so a killed run's leftover is removed by the next run.
- [x] **M2-T8 Helper: monitor mode** · M · desktop (Swift) · depends on: T7.
  Owns `native/roger-audio/{Monitor,Route,ParentWatch}.swift` and
  `src/main/native/monitorRelaunch.mac.test.ts`. Mic users every 1 s with PID to outermost `.app`
  and non-bundle processes by executable path; default input and output with transport
  (Bluetooth, built-in speaker or headphones by data source, USB, other); emits on change only,
  plus `alive` after every poll so T10's watchdog does not kill a quiet monitor.
  Parent death while `recording on`: relaunch Roger once, then exit; otherwise exit.
- [x] **M2-T9 Bundle and sign the helper** · S · desktop · depends on: T7.
  Owns `electron-builder.yml`, `scripts/install-mac.sh`, `src/main/native/helperPath.ts` (+ test).
  `extraResources`, build before packaging, the signing order in the "Helper build, bundling and signing" row, verify both
  identifiers and fail the install on a mismatch or a missing helper. No config override of the
  path. As built, the install also runs the signed helper's `selftest`, and
  `src/main/native/installMac.mac.test.ts` tests the script's two signature functions on real
  unsigned and ad-hoc code.
- [x] **M2-T10 System audio through the helper** · M · desktop · depends on: T1, T3, T4, T9.
  Owns `src/main/native/HelperProcess.ts` (spawn, frame and stderr parsers, restart up to 5 times,
  the 3 s watchdog with SIGKILL, stdin closed on stop, SIGTERM then SIGKILL after 5 s),
  `src/main/audio/system/*` (`SystemAudioSource`, `TapSystemAudio`, `ElectronSystemAudio`,
  `helperEvents.ts`, selection), and the fake helper `test/fixtures/fake-roger-audio.mjs` (can
  hang on command). Rebuilds the tap on focus after a Start while unverified; records "verified"
  in `app_state` against T1's hash on the first non-zero tap audio. A helper that is out of
  restarts reports the system source `error` through the path the renderer uses today
  (`reportSourceState`), so the landed G1 closes its vendor session at once; a helper restart
  that leaves no chunk for 30 s is paused by G2 like any stall. As built: a forced `tap` with no
  helper fails at Start rather than falling back (`auto` falls back to Electron); a failed tap
  raises no warning of its own, T11's source-ended rule shows it; while a helper restarts it shows
  `helper-hung` or `source-ended`, then a `helper-restarted` notice. `systemCapture` is `tap` or
  `electron` from `starting` to `stopping`, null when idle, and the renderer opens Electron's call
  audio for `electron` or a missing field (a main from before T10), never for `tap` or null (T12).
- [x] **M2-T11 Signal health and loud warnings** · M · desktop · depends on: T2, T3, T4.
  (Code merged; the Mac check below has not run, so the flat-level rule is built and off, the
  `flatLevelRule` option of the T11 slot. D4's Bluetooth window and the "Switched to <device>"
  notice are built but had no writer: T17a feeds both, assigned after wave 3.)
  Owns `src/main/capture/SignalMonitor.ts`, `src/main/capture/warnings.ts`,
  `src/main/notify/Notifier.ts`. Rules and thresholds from the design table; ignores the first
  tick after a timer gap over 5 s (the Mac slept, from openwhispr's watchdog). Starts with a Mac
  check written to the exit check log: the built-in mic's peak at input volume 0
  (`osascript -e 'set volume input volume 0'`) and what turning off Roger's Microphone access
  mid-capture does (zeros, track ended, or nothing). Adds the flat-level rule only if the peak is
  above 1 LSB. `SignalMonitor` is a fan-out sink and only warns: it never opens or closes a vendor
  session (G2's stall close and M3-T20's silence gate do that).
- [x] **M2-T12 Renderer capture hardening** · M · desktop · depends on: T2, T4.
  Owns `src/renderer/src/audio/*`, `src/renderer/src/state/useCapture.ts`, `src/main/window.ts`,
  and in wave 3 `src/main/lifecycle.ts` and `src/main/capture/stopReasons.ts` (with their tests).
  Builds on the landed `AudioCaptureController` (devices injected, `followMain` stops capture on
  every idle status, a start generation so two captures never share a source) and keeps
  `useCapture`'s `followMain` call and its re-read of the status on window focus.
  Injectable `mediaDevices` and `AudioContext`; worklet posts `currentFrame` and the renderer maps
  it to wall clock per chunk as the Timeline row says (never through `performance.timeOrigin`); `MicRecovery` (devicechange debounce 250 ms, mute grace 800 ms, follow the
  default input, swap the source node into the same worklet, generation counter, "switched"
  report; from openwhispr `activeMicRecovery.js`); reopen the mic whenever main is recording and
  the mic is not running (covers reloads, wake and resume); system stream only when
  `systemCapture` is `electron`; `render-process-gone` reload. The G4 delta in `lifecycle.ts`:
  `render-process-gone` reloads the page instead of stopping, a reload while recording no longer
  stops (the reopened mic carries on; G2 closes the mic session if no chunk comes for 30 s), and a
  reload that fails (`did-fail-load`) stops with `renderer-gone`; `page-reloaded` leaves
  `StopReason` with its notice and tests. Close-hides is M5-T11's. As built: `window.ts` needed
  no change (the reload lives in `lifecycle.ts`); a page that crashes before it loads, or 3 times
  in 60 s, stops with `renderer-gone` instead of reloading again; a mic that opens dead 3 times in
  a row is reported to main as `error`; a reload leaves call audio shut when main gave up on it;
  call audio also opens when `systemCapture` is missing (a main from before T10).
  The "switched" report reaches main as an `active` source state whose message main drops: the
  notice comes from T17a's mic device instead.
- [x] **M2-T13 Electron smoke test** · M · desktop · depends on: T10, T12.
  Owns `apps/desktop/e2e/harness.ts`, `e2e/capture.e2e.ts`, `src/main/e2eMode.ts` (+ test) and
  `[slot M2-T13]` in `index.ts` (P2-F3 already added `vitest.e2e.config.ts`, the `test:e2e`
  script, the `e2e-desktop` target and `playwright-core`). M5-T11's "Roger Dev" userData must not
  override the e2e user data folder; its slot comes after this one. Launches the
  unpackaged build with `ROGER_E2E=1`, Chromium's fake audio device playing a fixture WAV, the
  fake helper and `ROGER_STT_PROVIDER=fake`; Start shows lines within 10 s; Stop saves them; the
  run asserts the TCC gate was skipped and no prompt was asked for. The fake provider's opens pass
  `SttOpenBudget` too, so the harness sets `ROGER_STT_OPENS_PER_MINUTE=100` (the guard's maximum)
  for runs that press Start more than twice a minute. Exposes a screenshot helper (both themes,
  wide and narrow) for T19 and T20. As built: the microphone plays a 330 Hz tone WAV made per run
  (no checked-in fixture), which needs `--disable-features=AudioServiceSandbox`; "no prompt" is
  proven by e2e mode's log line and main-process counters on `askForMediaAccess`, `getSources` and
  `Notification#show` (all 0); Stop's check compares the lines main sent the page, by id, with
  the stored lines; the shot helper (`shoot`) takes a required check and shoots only if it passes.
  Run alone after `electron-vite build`; the whole `make e2e-desktop` has not run since wave 2.
- [x] **M2-T14a Echo filter, pure** · S · desktop · depends on: none (wave 0).
  Owns `src/main/capture/echo/EchoFilter.ts` (+ test): hide, trim runs of 3 or more words, no
  Electron imports, so M3-T11's bench can load it.
- [ ] **M2-T14b Echo sink** · M · desktop · depends on: T3, T3b, T4, T5, T6, T14a.
  Owns the rest of `src/main/capture/echo/*` and the T14b runtime slot. A
  session sink: suppress, trim, emit "segment changed", hold mic lines until the call-audio
  watermark or stream close (cap 120 s), release on Stop, `settleAll(launchedAt)` at startup
  (set in its slot with `deps.uploader.setBeforeFirstTick`; it settles only holds on lines
  created before `launchedAt`, the setter's doc says why), unhide, and a `filterStored` entry for
  re-run lines. Suppress, trim and hold answer `false` for a line the uploader is sending (T3b's
  `markSegmentsSent`) as for an uploaded one: too late, the line stays, and the sink needs no
  in-flight handling of its own. Route comes through a `RouteProvider` interface (unknown until
  T17a wires the monitor; unknown means filter on).
- [x] **M2-T15 Audio backup and retention** · M · desktop · depends on: T2, T3, T4, T5.
  Owns `src/main/backup/*` (`AudioBackupWriter`, `wav.ts`, `AudioCompressor`,
  `AudioRetentionSweeper`, `audioPaths.ts`, disk guard) and the T15 runtime slot. Header repair at
  startup; the sweeper keeps audio of meetings with unrecovered gaps (30-day cap); delete-audio
  handler with the path check. Its tests read T3's backup fixture; the `audio_files` contract with
  M3-T12 is in the M3 plan ("Where recordings come from"). As built: a failed write (or an audio
  folder that cannot be made) ends the backup for that recording with `BackupStatus.state`
  `error`, an error log and a `backup_failed` event, and raises no loud warning (low disk is the
  loud `backup-paused` one; an owner call); free space is read every 10 s on the wall clock, and
  at once when it steps back; the live `bytes` is the meeting's audio on disk (an encoded file at
  its m4a size, a resumed meeting's earlier audio included); a recording that kept no audio leaves
  no folder. No call lists the meetings whose audio is kept for a re-run: T16 adds it (wave 6).
- [ ] **M2-T16 Gap re-run** · M · desktop · depends on: T6, T14b, T15.
  Owns `src/main/rerun/*`. Reads WAV or decodes m4a with `afconvert -f WAVE -d LEI16@16000`,
  streams at real time through a fresh `SttStream`, drops overlapping words, runs mic lines
  through `EchoSink.filterStored`, saves lines with `origin = 'rerun'`, marks gaps recovered or
  records why not. Crash-tail gaps at startup. Every re-run session takes a slot first from the
  shared `SttOpenBudget` that T4 injects into the T16 runtime slot, through T4's minute-only
  acquire (never the meeting's allowance: after Stop it still holds the last meeting's opens, and
  a meeting with gaps is the one whose failures spent it), and waits when the minute is full; none
  starts while a recording runs (house rule 9: the budget is the one gate, and a live reopen must
  never wait behind a re-run). No edit to `CaptureService.ts` or `SttOpenBudget.ts`. Its usage is
  added to the meeting's `stt_usage` row (the vendor bills it). Assigned after wave 4 (neither T15
  nor M5-T5 built it): the call that lists the meetings whose audio is kept for a re-run, for
  T20b's Home card, with its channel in `shared/ipc/capture.ts` (bridge, preview fake, the stub in
  `AudioCaptureController.test.ts`), its request in `main/ipc.ts` and `createCaptureRequests`, and
  its handler filled from the T16 slot (build order, section 10, "From wave 4").
- [ ] **M2-T17a Call app monitor** · S · desktop · depends on: T8, T10, T14b.
  Owns `src/main/detect/MeetingAppMonitor.ts`, `src/main/detect/callApps.ts`. Runs the monitor
  helper through `HelperProcess` while Roger runs, sends `recording on` and `recording off`,
  resolves call apps (FaceTime daemons included), feeds the echo filter's `RouteProvider`. Roger's
  own processes never count. Safari's mic use shows as WebKit's GPU process, not as Safari
  (`Monitor.swift` header). Assigned after wave 3 (T11 built both, nothing fed them): on every
  `route` event its slot calls `signalMonitor.setMicBluetooth(route.input?.transport ===
  'bluetooth')` (D4), and a status contributor sets `sources.mic.device` from `route.input.name`,
  which T11's `SignalMonitor` turns into the "Switched to <device>" notice and capture event.
- [ ] **M2-T17b Offer and auto-stop** · M · desktop · depends on: T11, T12, T17a, M5-T5,
  M5-T9b (`PromptService.offer`). M5-T11 (close hides) is needed for the exit check, not to build.
  Owns `src/main/detect/CallDetector.ts` (pure), `src/main/detect/CallOffer.ts`, the T17b runtime
  slot. `CallOffer` passes detections (after the 10-minute dismiss cooldown) to
  `PromptService.offer({source: 'call_detected', app})`; M5's panel shows the card and its "Take
  notes" starts through M5's start request. No M2 notification or card for the offer. Auto-stop
  through the normal stop with a new `call-ended` `StopReason` (`capture/stopReasons.ts` and its
  notice, wave 7), the "Stopped: the call in Zoom ended" notification through T11's `Notifier`,
  the 60 s wake grace, `callDetection` off switch.
- [ ] **M2-T18 Sleep and wake** · S · desktop · depends on: T6, T10, T12.
  Owns `src/main/power/PowerCoordinator.ts` and, in wave 5, the `suspend` handling in
  `src/main/lifecycle.ts` (with its test). Suspend and resume as designed (a delta on G4:
  `watchApp` no longer stops on `suspend`; `PowerCoordinator` calls T6's
  `suspendStreams('asleep')`, then at `resume` either `resumeStreams('asleep')` or, after a sleep
  of `noSpeechStopMs` or more, the normal stop with `system-sleep`), and the power save blocker.
  Through T4's session listeners and the T18 runtime slot; no edit to `CaptureService.ts` or
  `CaptureSession.ts`. The wake goes through `resumeStreams('asleep')`, so a source M3-T20's gate
  had closed stays closed until speech (T20 keeps it so in `CaptureSession`). The reason is
  required and lifts only `asleep`: an `offline` suspend still in force stays until T6's network
  poll lifts it.
- [ ] **M2-T19 Permission setup screen** · M · desktop · depends on: T1, T2, T7b, T9, T10, T11,
  T13, M4-S1 (setup route), M4-S3 (preview harness).
  Owns `src/main/setup/*`, `src/renderer/src/components/setup/*`, `e2e/setup.shots.e2e.ts`,
  `renderer/src/app/slots/m2-setup.ts`, the T19 runtime slot. Rows:
  microphone (status, request, open its pane), system audio (probe with a system sound, `pending`
  on the first silent probe for this identity; a probe that ends with an error, `route_changed`
  included, is no answer: probe again, never spending that first-silent `pending`; "I allowed it"
  rebuilds the tap and probes again, open T1's pane), Screen Recording only when the Electron fallback is in use, notifications
  (test), signing (T1), API health and STT token check (it fetches a token and opens no vendor
  session: every open is billed and spends the per-minute budget). Shown on first run, when Start
  fails for a permission reason, and from a menu item. Every error names the pane and the switch to
  flip, and offers "Relaunch Roger" where macOS needs it.
- [ ] **M2-T20a Capture status UI** · S · desktop · depends on: T2, T11, T13, M4-S1 (banner
  slot), M4-S4 (meeting-page regions).
  Owns `src/renderer/src/components/capture/{WarningBanner,StreamStatus,LevelMeter,Notices}.tsx`
  (+ tests), `e2e/capture-status.shots.e2e.ts`, `renderer/src/app/slots/m2-capture-status.ts`
  (replaces the M1 `StatusPanel` entry M4-S4 seeded there), and in wave 5 the stream wording in
  `renderer/src/format.ts` (+ test).
  Warning banner (loud and quiet styles from theme
  tokens), per-stream state including `paused`, `retrying` (shown as reconnecting, with its
  countdown) and `offline`, level meters, "Switched to <device>" and "helper restarted" notices.
  It keeps what `StatusPanel` shows since the cost guards landed: the meter line
  (`describeMeter`, `meterDetails`), each source's connected time (`describeSourceConnected`),
  `streamMessages`, and the stop notice (`CaptureStatus.notice`, also shown by M4-S1's frame):
  replacing the panel must not drop the cost the owner asked to see. Mounted in the shell's banner
  slot and the meeting page's capture status region.
- [ ] **M2-T20b Capture details UI** · M · desktop · depends on: T14b, T15, T16, T17b, T20a,
  T23, M4-S4.
  Owns the other files in `src/renderer/src/components/capture/` (`EchoLines`, `AudioKept`,
  `RerunProgress`, `CaptureReport`, `ResumedNotice`), `e2e/capture-details.shots.e2e.ts`,
  `renderer/src/app/slots/m2-capture-details.ts`. No call-detected card: M5-T10's panel renders
  it (M5 D5). "Stopped because the call ended" notice, a toggle that shows hidden and
  trimmed echo text, with Unhide on hidden lines only (main refuses a trimmed one), "audio kept until ..." with delete and "kept for a re-run",
  re-run progress, capture report, "Roger restarted and kept taking notes" with Stop. The Home
  card's list of meetings kept for a re-run comes from T16's call (assigned after wave 4).
- [ ] **M2-T21 Docs** · S · docs · depends on: all others.
  CLAUDE.md repo map (`apps/desktop/native`), commands (`make native`, `make e2e-desktop`,
  `make test-native-route`), failure log lines found during M2 (each in the file its trap belongs
  in, section 3.1 of the build order); `apps/desktop/README.md` (helper, permissions, audio folder,
  and what M2 changed in the cost guards' sleep and crash rows; the guard table itself is M3-T20's
  in wave 6); "Adopted in M2" in `docs/research/reference-repos.md`.
- [ ] **M2-T22 Exit check on real calls** · human plus agent · starts after T1 to T15, T3b, T7b
  and T20a (the "no lost or doubled text" set and the three cuts). The kill -9 call and the Wi-Fi
  cut also need T16 (AssemblyAI takes no replay, so that window comes back from the backup), the
  kill -9 call T23, the lid call T18, the offer calls T17b and its M5 gates, the AirPods call and
  the "Switched to <device>" line T17a (D4's flag and the mic device); T19 and T20b land
  before M2 closes. Each call also records its `stt meter at stop` log line (sessions opened,
  connected time, cost) and whether M3-T20's silence gate was on (`sttSilenceCloseSeconds`, on by
  default once wave 6 is installed; with it on, the gated time and gate reopens from the same
  line). A first word missed after a silence counts against "no lost or doubled text". The "Done
  when" procedure, recorded below.
- [ ] **M2-T23 Crash resume** · M · desktop · depends on: T3b, T4, T5, T8, T10, T12, T14b, T16,
  T17a.
  Owns `src/main/recovery/CrashRecovery.ts` (+ test) and `[slot M2-T23]` in `index.ts`, which
  replaces M1's startup `endMeetingsLeftOpen` call (it also ends meetings a quit left open after
  its 5 s `quitStopTimeoutMs`; those end as in M1, `stop_reason` `quit`). Resume or end as in D7
  (T8's relaunch puts `--relaunched` in argv), the gap row, a `resumed_after_crash` capture event, a `recording.heartbeat` app state written
  every 5 s while recording. A resume calls T4's `capture.start({ resume: { meetingId } })`, which
  reads the meeting's start and saved `stt_usage` row from the store, so the cost record carries
  on instead of restarting at zero; the open allowance starts afresh (D7). Holds are settled by
  the hook T14b sets with `setBeforeFirstTick` (only lines created before the uploader's
  `launchedAt`).

If the day runs short, T16, T17b, T18 and T23 land after the first exit-check calls; the core
set above gates "no lost or doubled text" (the Wi-Fi cut waits for T16).

## Tests

| What | Test |
| --- | --- |
| Signing kinds read from `codesign -d -r-` output (local identity, ad hoc, unsigned, Developer ID); the requirement hash changes with the identity; pane anchors are the verified constants | `src/main/signing.test.ts`, `src/main/settingsPanes.test.ts` |
| New config keys parsed, bad values named in the error, defaults (retention 7, backup on, detection on); no key sets a helper path | `src/main/config.test.ts` |
| Every new IPC payload validated; a meeting id that is not UUIDv4, `../x` or an absolute path is refused; an audio chunk with a non-finite or far-off `capturedAtMs` is refused | `src/main/ipc-validation.test.ts` |
| The `offline` stream state has its own text in `describeStream` | `src/renderer/src/format.test.ts` (T2) |
| Migration 4 on a database at schema 3 (M1 plus `stt_usage`) keeps every row, `stt_usage` included; suppressed and held lines are not "waiting"; trim keeps `original_text`; unhide; gaps, audio files, events, app state round-trip; crash reopen | `src/main/store/SqliteTranscriptStore.test.ts` |
| Re-run lines added after the meeting ended remotely are uploaded and the end re-sent; held lines left by a kill -9 and a relaunch within 6 s are settled and uploaded; an unhidden line is uploaded; `end` is not sent while lines are held; a meeting with nothing to upload is not touched again | `src/main/upload/TranscriptUploader.test.ts` |
| Fan-out delivers each chunk to every sink once with its capture time; a throwing sink is logged and the others still get audio; resume start keeps the meeting id and adds to the saved `stt_usage` row; an injected `SttOpenBudget` is the one `CaptureService` uses; the minute-only acquire refuses a full minute and never spends or checks the meeting's count; M1 behaviour unchanged, the G1 to G7 cost-guard tests included | `src/main/capture/AudioFanout.test.ts`, `SttOpenBudget.test.ts`, existing `CaptureService.test.ts`, `CaptureSession.test.ts`, `lifecycle.test.ts` |
| Contiguous audio is one run even with chunks arriving 0 to 400 ms late in random order of delay; a 300 ms capture gap starts a new run; vendor time maps into the right run; a 10-minute sleep keeps later lines at wall-clock time; 2 hours of chunks keep sample accuracy | `src/main/capture/AudioTimeline.test.ts` |
| Every registered vendor, on a manual clock against its fake: pings only while audio flows, a socket that stops answering is declared dead at most 5 s after the last pong whatever the phase of the ping cycle, then one fatal error and a terminated socket (no socket left open); a vendor that never answers pings falls back after 10 s and logs it | `src/main/stt/conformance.test.ts`, `src/main/stt/core/SttConnection.test.ts` |
| `net.isOnline()` false moves both sources to `offline` within 1 s, terminates their sockets at once and fetches no token while offline; back online, each source reopens with its next chunk through `SttOpenBudget` (no backoff wait); a dead socket goes through the landed `retrying` path; the window from the watermark to the new stream's first audio is one gap row with its reason (`stt_failed`, `offline`, `budget`), a stall with no audio is a capture event instead; the watermark is published per source; `suspendStreams('asleep')` finishes and closes both streams and opens nothing until `resumeStreams()` | `src/main/stt/networkStatus.test.ts`, `src/main/capture/CaptureSession.test.ts` |
| Converter framing, frame header and capture time, ring overflow counted as dropped | `roger-audio selftest` (in `make check` on a Mac) |
| The tap follows a switch of the default output within 2 s with a `restarted` event | `roger-audio selftest --route-switch` (`make test-native-route`, opt-in and audible; built in T7b, still to be run once by a person on the Mac, and again at the exit check) |
| Monitor resolves `avconferenced` by path; it says `alive` every poll while nothing changes; parent death while recording prints the relaunch once (`--relaunch-dry-run`) and exits; parent death while not recording just exits | `src/main/native/monitorRelaunch.mac.test.ts` (`pnpm test:mac`) |
| Helper frames and events parsed and rejected when malformed; a format other than 16 kHz Int16 refuses to start; a helper that hangs (no bytes, no event) is killed at 3 s and restarted, and that counts toward the 5; restart after a crash up to 5 times then a loud error; stop closes stdin, then SIGTERM, then SIGKILL; verified is stored on the first non-zero audio | `src/main/native/HelperProcess.test.ts`, `src/main/audio/system/TapSystemAudio.test.ts` (fake helper script) |
| Helper missing selects the Electron path; config forces either; packaged builds ignore `ROGER_E2E` | `src/main/audio/system/selectSystemAudio.test.ts`, `src/main/native/helperPath.test.ts` |
| Stall at 5 s, mic dead at 8 s, Bluetooth mic dead at 30 s, flat-level rule when enabled; "call audio never heard for 20 s" loud while unverified and on screen once verified; call audio silent on screen at 8 s and loud at 60 or 180 s; a device switch is a notice, not a warning; first tick after a sleep gap does not warn; warnings clear when audio returns | `src/main/capture/SignalMonitor.test.ts`, `warnings.test.ts` |
| One notification per spell; the same kind and source twice within 2 minutes notifies once; two different kinds 30 s apart both notify; only when unfocused; dock bounce when the notification fails | `src/main/notify/Notifier.test.ts` |
| Mic reacquired on device change and after a muted track, with a "switched" report; generation counter ignores a stale attempt; the worklet node is reused; capture times map frames to wall clock; mic opens when main is recording and stops when it stops; system stream opened only in Electron mode | `src/renderer/src/audio/MicRecovery.test.ts`, `AudioCaptureController.test.ts`, `PcmStreamCapture.test.ts` |
| `render-process-gone` reloads the page and the recording goes on; a reload while recording does not stop it; a failed reload stops with `renderer-gone`; `page-reloaded` is gone from `StopReason` | `src/main/lifecycle.test.ts`, `src/main/capture/stopReasons.test.ts` |
| Real Chromium: fake audio device to worklet to IPC to fake STT to lines on screen, then saved; no TCC prompt asked for | `apps/desktop/e2e/capture.e2e.ts` (`make e2e-desktop`), `src/main/e2eMode.test.ts` |
| Same words within 700 ms hide the mic line; different words keep it; a mixed line loses only its runs of 3 or more matched words and keeps `original_text`; short lines need full match and overlap; headphones turn it off; a call-audio line arriving after the mic line still hides it before upload; while the call-audio stream is reconnecting the mic line stays held, and is released by the watermark, by stream close, or at the 120 s cap; unhide then upload; `settleAll` at startup; re-run mic lines are filtered against stored call-audio lines | `src/main/capture/echo/EchoFilter.test.ts`, `EchoSink.test.ts` |
| WAV files per run and per 60 s with correct offsets; a torn header repaired at startup; afconvert failure keeps the WAV; files past retention deleted, open meetings never; a meeting with an unrecovered gap keeps its audio until recovered or 30 days; backup pauses below 2 GiB and says so; delete-audio refuses a path outside the audio root | `src/main/backup/*.test.ts`; the real afconvert round trip in `src/main/backup/AudioCompressor.mac.test.ts` (`pnpm test:mac`) |
| Gap audio re-run adds only the missing words; re-run mic lines that repeat stored call audio are hidden; a gap without audio is marked with the reason; crash tail becomes a gap; each re-run session takes a per-minute slot first and waits when refused, and runs even when the last meeting spent its `sttOpensPerMeeting`; no re-run starts while recording; its usage lands in the meeting's `stt_usage` row | `src/main/rerun/GapRetranscriber.test.ts` |
| Offer after 5 s for Zoom and 15 s for Chrome; `avconferenced` and `callservicesd` count as "FaceTime or phone call"; cooldown after dismiss; Roger never triggers itself; auto-stop after 15 or 30 s of release, 60 s after a wake, through the normal stop with `call-ended`; no auto-stop for a manual start with no call app; AirPods-style 2 s release does not stop | `src/main/detect/CallDetector.test.ts`, `MeetingAppMonitor.test.ts`, `src/main/capture/stopReasons.test.ts` |
| Suspend finalizes and closes streams and no longer stops the recording; resume after a short sleep restarts the helper and reopens each source with its audio; a sleep of `noSpeechStopMs` or more stops at wake with `system-sleep`; the power save blocker is held only while recording | `src/main/power/PowerCoordinator.test.ts`, `src/main/lifecycle.test.ts` |
| At launch, a recent open meeting resumes in the same id when a call app holds the mic or the launch came from the relaunch (`--relaunched` in argv), with a gap and a capture event, its saved `stt_usage` carried on; an old one, or one with no call app and no relaunch, is ended as in M1; holds are settled before the uploader's first tick | `src/main/recovery/CrashRecovery.test.ts` |
| Setup rows for granted, denied, not determined, probe pending then refused, probe heard, notifications failing, ad-hoc build; deep links | `src/main/setup/PermissionService.test.ts` |
| 2-hour soak: 72,000 chunks per stream through the service with fake STT and clock; memory buffers stay bounded; every line stored; offsets correct at 2 h | `src/main/capture/CaptureService.soak.test.ts` (M3-T4b, wave 5: no M2 task owned it; T5's `CaptureSession.test.ts` covers the session-level 2 hours) |
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
| The vendor sends no finals during silence (AssemblyAI ends a turn only after speech), so the watermark stalls | Mic lines held to the 120 s cap in quiet stretches | Lines still upload within 2 minutes and before `end`; a call-audio session closed by the stall pause or M3-T20's gate releases them at once; noted in the capture report. |
| A vendor ignores WebSocket pings | No pong ever on a healthy stream | If no pong arrives in the first 10 s, that socket relies on `net.isOnline()`, send errors and any message, and logs it; the Wi-Fi cut still warns within 1 s. |
| The landed cost guards stop where M2 wants to continue (G4 stops on sleep, a renderer crash and a reload), or M2's continuing spends money G4 meant to save | The lid-closed exit call splits into two meetings; or a session bills while nothing captures | T18 and T12 change only those decisions in `lifecycle.ts`, with tests; every session still closes first (sleep: finish and close; crash: G2's 30 s stall close) and reopens only with audio, through the budget; a long sleep still stops. |
| Reopens and re-runs exhaust the open budget (4 a minute, 30 a meeting) | "Speech-to-text was not started" or a source left `error` after "opens spent" | Offline reopens skip the backoff but not the budget; re-runs never run during a recording and count in the minute only, as M3-T20's gate reopens do, so the 30 stay for Start, stalls and failures; the budget's refusal says when the next open may go; the per-meeting cap is a setting. |
| The relaunch after a deliberate Force Quit surprises the user | A Force Quit while recording | Once per meeting; the resumed notice has Stop; D7 is an owner decision. |
| afconvert rejects 48 kbps AAC at 16 kHz | Compressor errors in the log | Keep the WAV; the Mac test pins the exact command. |
| Backup fills the disk | Free space under 2 GiB | Backup pauses with a warning; text continues; retention, the 30-day cap and a delete button. |
| Parallel tasks collide in shared files | Merge conflicts in `CaptureService.ts`, `CaptureSession.ts`, `lifecycle.ts`, `index.ts`, `ipc.ts`, `package.json`, `Makefile` | `phase-2-build-order.md`: P2-F1's slots in `index.ts`, T4's runtime slots, one writer per wave for `CaptureService.ts`, `CaptureSession.ts` and `lifecycle.ts` (a stated merge order where two share a wave), and P2-F3 owning `package.json`, the lockfile and the Makefile targets. |
| Other Phase 2 plans edit the same files | M3-T18, T4a, T5 and T15 (`stt/core/*`, the conformance suite, before and after T6; M3-T18 also two comments in `CaptureSession.ts` in wave 0), M3-T4a and T4b (`SpeechToText.ts`, `CaptureService.ts`, `CaptureSession.ts`), M3-T6b (`CaptureSession.ts`, after T6 in wave 4), M3-T9 (`useCapture.ts`), M3-T19b (`store/*`, migration 6), M3-T20 (`CaptureSession.ts`, `CaptureService.ts`, `shared/capture.ts`, `costGuards.ts`, `format.ts`; it calls T4's minute-only acquire and never edits `SttOpenBudget.ts`), M4-T22 (`CaptureService.ts`, `TranscriptUploader.ts`), M5-T5 (`shared/capture.ts`, `CaptureService.ts`, `TranscriptUploader.ts`, `roger.sqlite` migration 5), M5-T11 (`index.ts`, `window.ts`, `lifecycle.ts`), P2-F1 (`lifecycle.ts` quit hooks) | Section 3.1 of `phase-2-build-order.md` fixes the order of every shared file; local migration 3 is M1's `stt_usage`, 4 is T3's, 5 is M5-T5's and 6 is M3-T19b's. |
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
| Lines lost to a reconnect show only after Stop | The live view misses the window until the gap is re-run from the backup (no live replay, so AssemblyAI is never sent audio faster than real time) | M12 (whole-call re-run) if it matters in use |

## Exit check log

Filled in when the check runs on real calls. The Mac checks land here first: T0 (echo cancel
`all`), T1 (settings anchors on macOS 26), T11 (input volume 0 peak, revoked mic behaviour).

## Review

Engineer: pending.
