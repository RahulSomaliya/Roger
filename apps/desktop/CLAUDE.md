# Roger desktop: failure log

Extends the root `CLAUDE.md`, whose house rules and repo-wide failure log apply here too: these are the traps hit only in `apps/desktop` (its bench, e2e and QA scripts and the Swift helper included). Add one when you hit a new one. Renderer and UI traps from the redesign live in `src/renderer/CLAUDE.md`, main-process ones from the sweep in `src/main/CLAUDE.md`.

- In `make dev-desktop` the terminal is the app macOS asks for capture permission. cmux, iTerm2 and
  Terminal.app have no `NSAudioCaptureUsageDescription`, so the system audio ("Them") stream is
  dead with no error. Test call audio from the installed `Roger.app`: `make install-desktop`.
- An unsigned `electron-builder --mac` build re-signed with `--options runtime` but no Apple team
  id dies at launch (`Electron Framework ... not valid for use in process`). Never sign a local
  build ad hoc either: macOS pins privacy grants to the code hash, so each rebuild silently loses
  call audio while System Settings still shows Roger on (2026-10-06). `make install-desktop` signs
  with a stable per-Mac identity, without hardened runtime; see `apps/desktop/scripts/install-mac.sh`.
- To tell a lost privacy grant from a code bug, read the `tccd` log:
  `/usr/bin/log show --last 1d --predicate 'subsystem == "com.apple.TCC" AND eventMessage CONTAINS[c] "roger"' | grep 'Failed to match existing code requirement'`.
  A hit names the service (`kTCCServiceMicrophone`, `ScreenCapture`, `AudioCapture`): the grant is
  pinned to another designated requirement than `codesign -d -r- /Applications/Roger.app` prints.
  Type `/usr/bin/log`; plain `log` is a zsh builtin. The Error-level `kTCCServiceAccessibility`
  line at launch comes from Electron and is not a grant problem (2026-10-06).
- A packaged app logs to stderr only. Launch it with
  `open --stderr <file> --stdout <file> /Applications/Roger.app` to read its log.
- `eslint-plugin-react-hooks` v7 (`react-hooks/refs`) rejects a ref read inside a closure built in a
  `useState` initializer. Keep the latest callback in a plain variable on the once-made object and
  update it from a layout effect. `renderToString` runs no effects: test effect-based registration
  through the registry, not through server rendering (M4-T21a). It also puts `<!-- -->` between
  adjacent text pieces (`2<!-- --> of <!-- -->100`): strip it before matching text (M3-T8). A
  render-phase `setState` also re-runs under `renderToString`, so a latch set while rendering shows
  only if the test asserts something the page renders from the second shell (`MeetingPage.test.ts`,
  M3-T9). `renderToStaticMarkup` writes `checked` before `value`, whatever the JSX order (M4-T18).
  A component using `useId` cannot be called as a plain function in a node test: mock `useId`
  through `vi.mock('react', ...)` or test a hook-free child (M5-T12).
- A vitest test can switch time zones with `process.env.TZ` (in `src/renderer` and `src/shared`,
  where `process` has no types: `vi.stubEnv('TZ', zone)` and `vi.unstubAllEnvs()` after), but assert
  `new Date(...).getTimezoneOffset()` inside the switch, or a TZ test passes when the switch did
  nothing (M5-T8, M5-T12). An `Intl.DateTimeFormat` keeps the zone it was made in: build one per
  render, never at module level, or it writes the old zone's clock after a macOS zone change.
- `vi.setSystemTime(later)` moves `Date.now` and shifts every fake timer with it: each keeps its
  remaining wait and none fires, as Node timers behave over a Mac sleep (their clock stops; libuv
  source, not yet seen on a sleeping Mac). Recheck a deadline that must hold across sleep from the
  wall clock on wake, and test it as `setSystemTime` plus the wake call (M5-T7).
- IPC stub APIs are `object`. typescript-eslint refuses `{}`, empty interfaces and `object & object`:
  give a stub its first member as an interface, and never rewrite `RogerApi` as `A & B & ...` while
  stubs remain. Two features sharing a member name is no type error (the preload spreads silently
  overwrite); `shared/ipc.test.ts` and `preview/fakeRoger.test.ts` guard it (P2-F1).
- Adding a member to `shared/ipc/<feature>.ts`, or making a shared field required, breaks every test
  double typed as that whole type, in files the task does not own (`AudioCaptureController.test.ts`
  types its double as `CaptureApi`, TS2739; `stream.keyterms` in `SttTokenResponse`). Stub it in
  those doubles in the same commit and name the files in the hand-off (M2-T2, M3-T4a).
- STT pacing tests drive a manual clock with real timers: the pace timer only wakes the queue and the
  clock decides what may go. Move the clock, then `waitFor` the frames (M3-T18).
- A migration test that winds `roger.sqlite` back to schema N must also undo every later migration,
  or reopening re-runs them (`duplicate column name`); each new local migration adds its own
  wind-back helper (M2-T3).
- `swiftc` fails with "input file ... was modified during the build" if `native/roger-audio` changes
  while `make check` runs. `roger-audio selftest` must never create a real tap or open a device: that
  would raise a macOS privacy prompt for whatever ran `make` (M2-T7). An agent's direct run of the
  built helper is refused by the auto-mode classifier: iterate with `swiftc -typecheck` (the flags
  of `scripts/build-native.sh`) and run the selftest through the gate (M2-T7b).
- With `exactOptionalPropertyTypes`, `{ ...settings, keyterms }` with `keyterms` possibly undefined
  fails tsc (TS2379, TS2412): leave the key out, or type it `T | undefined`. `no-misused-spread`
  refuses `[...text]` on a string; count code points as Python's `len` does with
  `Array.from(text).length` (M3-T4a).
- `src/renderer` and `src/shared` are type-checked without Node types (`tsconfig.web.json`): a test
  there reads a JSON fixture with a JSON import (`shared/notes.test.ts`) and a CSS file through
  `renderer/src/theme/rendererSources.ts`, never `import.meta.glob(..., { query: '?raw' })`, which
  Vitest empties for CSS, so a colour scan through it passes on anything (M4-S2, M4-T13). `?raw`
  is fine for other files: `preview/index.test.ts` imports both `index.html` pages that way (M4-S3).
- A CSS scan with `/\{([^{}]*)\}/` reads only innermost blocks and skips every declaration of a rule
  that holds a nested rule; read declarations with `renderer/src/theme/cssDeclarations.ts` (M4-S2).
- Colour tokens are OKLCH only (`theme/tokens.css`, `docs/design.md`): an rgb or hex token makes
  `tokens.test.ts`'s reader throw. `--accent` is a fill under `--on-accent`; text in that hue is
  `--accent-ink`. A new text-on-surface pairing gets a pinned row in `tokens.test.ts` first, and
  `tokenReads.test.ts` fails any `var(--x)` no sheet defines, so a missed rename fails the gate
  instead of inheriting silently (M4-S2, redesign R0a).
- Main's errors reach the renderer as text ("Error invoking remote method '<channel>': ApiError:
  ..."), never as the class: renderer code never checks `instanceof ApiError`;
  `app/describeError.ts` strips the wrapper (M4-S3).
- `tsconfig.e2e.json` compiles every `e2e/` QA script as ONE program: two scripts that each declare
  `Window.roger` with a different type pass alone in their worktrees and fail together after the
  merge (TS2687/TS2717). `window.roger` is typed once in `e2e/previewWindow.d.ts`; a script names
  its own page globals (`__m4t17`, `__abWatch`) and never redeclares `roger` (wave 2, 2026-10-07).
- `codesign --deep` skips a Mach-O in `Contents/Resources`, and swiftc's output carries the
  linker's ad-hoc signature (`roger-audio.partial`), which `--verify --deep --strict` accepts: only
  `install-mac.sh`'s exact requirement check catches it. Under `pipefail`,
  `x="$(codesign -d -r- f | sed ...)"` ends the script silently on unsigned code:
  `{ codesign ... || true; } | sed` (M2-T9).
- typescript-eslint's `no-unnecessary-condition` trusts narrowing TypeScript never undoes (a
  `let x: T | null = null` set only in callbacks; `this.stopped` across an `await`): keep such state
  on an object or re-read it through a non-narrowing helper (`bench/run/replay.ts`, `NotesSync`)
  (M3-T11).
- `make bench` runs in `apps/desktop` (pnpm `--filter`): resolve a path the person typed against
  `INIT_CWD`, not `process.cwd()` (`bench/run/args.ts`, M3-T11).
- Test traps: importing a constant from a `*.test.ts` file registers its tests again (shared
  constants go in a non-test helper); `toEqual` tells -0 from 0; `expect.*` matchers are `any`, so
  typed lint refuses them in a `toEqual` literal; a `ReadableStream` that errors drops chunks not
  yet read (M3-T12, M4-T15); `vitest run --root /` crawls the whole disk and hangs (M5-T5).
- `node:sqlite`'s `prepare()` compiles only the first statement and ignores the rest: a SQL file
  run through it holds exactly one (`PromptLog.test.ts` checks `calendar-streak.sql`, M5-T9a).
- QA (M3-T7, M3-T8, M4-T17): an `import()` inside `page.evaluate` in an `e2e/` file throws in the
  page (Vitest rewrites it): pass that code as a string. The shell scrolls in `.shell-page`, so
  grow the viewport until it stops scrolling (`qa.fitShellPage`, `qa/driver.ts`). A package the
  app has not imported yet makes Vite reload the page mid-`evaluate`: take that on a throwaway page.
- CSS that sets `display` on an element with the `hidden` attribute overrides it (M4-S4), and on a
  native `<dialog>` it overrides the closed dialog's `display: none`: `styles.css` carries a global
  `[hidden] { display: none !important }`, and `.dialog` never sets `display` (redesign R0b).
- Newer ICU puts U+202F before "AM"/"PM" in en-US times: `clock.ts` `formatClock` joins
  `formatToParts` by hand; never swap in `toLocaleTimeString` (redesign R0b).
- TipTap (M4-T17): ProseMirror fills missing attrs with null, so `isRequired` lets a bare node
  through (add `validate`); `setEditable(x)` emits `update` unless its second argument is `false`;
  a doc given as `content` meets its first transaction at the first click (an atom click threw
  "Selection passed to setSelection must point at the current document"): run one at load.
- Merged code reads a field another task's test mock lacks: the break shows only after both merge.
  `Notifier.test.ts` (M2-T11) builds `createCaptureRuntime`, which after M2-T10 merged also reads
  `app.isPackaged`, `app.getAppPath()` and `app.on`, and the merged suite failed with
  "app.getAppPath is not a function" (fixed in 29df536, wave 3). Vitest throws for a missing
  export of a `vi.mock('electron', factory)` only when code reads it, never at import, so each
  branch was green alone, and it hit a third time with `powerMonitor` (M2-T18, 11 tests). Every test
  that builds the capture runtime now mocks `electron` through the ONE shared
  `src/main/testing/electronRuntimeMock.ts` (overriding only what it asserts on), and a slot that
  reads another Electron field adds it there, never to a test's own copy. A read
  inside a guarded timer fails silently: M2-T6's network poll catches the throw, so
  `backupSlot.test.ts` without `net` passed while logging "network check failed" every second.
  That mock has a focused `BrowserWindow` since M2-T6, so a loud warning there posts nothing: a
  test that needs a post mocks `Notification` and an unfocused window, as `Notifier.test.ts` does.
- A jitter test whose first chunk has no jitter passes on code that ignores jitter: M1 dated a
  stream from its first chunk only, so delays of `(i * 137) % 401` (zero at i = 0) proved nothing.
  Start such a pattern off zero, and see the test fail on the old code first (M2-T5).
- Map a vendor span (a line, a word, an interim) through `AudioTimeline.toCapturedSpan`, never as
  two `toCapturedAtMs` calls: a vendor almost never stamps an edge exactly on a run boundary, and
  an end 10 ms past one lands on the far side of the gap. A 20 s mic stall made a 2-word line 20 s
  long and slipped the echo filter (M2-T5 review, 2026-10-07). Keep a final's span widened over its
  words (`CaptureSession.lineSpan`): `EchoFilter` reaches call-audio lines by span. `LatencyMeter`
  too: give it the event as the transcript dates it (`CaptureSession.measureLatency`); a clock on
  `toCapturedAtMs` timed a word ended 10 ms past a 20 s stall at 390 ms. One meter per vendor
  stream, pooled per source: one meter across a reopen counts the old stream's late line as
  repeated (M3-T6b).
- Inside `describe.concurrent`, Vitest's global `onTestFinished` is not tied to the running test:
  it ran another test's cleanup and stopped its helpers (0 frames). Use the test context's hook,
  `async (context) => { context.onTestFinished(...) }` (M2-T10).
- A test that runs the audio helper never resolves it from the real `apps/desktop`: after
  `make check` on a Mac, `native/bin/roger-audio` exists, `auto` picks it, and a Start builds a
  real tap (a privacy prompt for whatever runs the tests). Use an `e2e-fake` location or a temp app
  folder holding only the fake (`createSystemAudio.test.ts`), and mock `app.getAppPath()` to a
  folder with no helper (`createCaptureRuntime.test.ts`) (M2-T10). The call app monitor starts at
  launch and runs the same helper: a test that builds the runtime on the real `apps/desktop` sets
  `ROGER_E2E=1` for the fake (`monitorSlot.test.ts`) (M2-T17a).
- Node's `child_process.spawn` throws at once for every errno but EACCES, EAGAIN, EMFILE, ENFILE
  and ENOENT (ENOEXEC for a half-written binary, EBADARCH for an x64 app carrying an arm64 helper);
  those five arrive as `error`, then `close` (code -2), never `exit`. A child's stdin emits EPIPE
  after the child exits, which with no listener is thrown and kills main. Wrap `spawn`, end a run
  on `close`, and give every helper's stdin an error listener (`HelperProcess.spawnRun`, M2-T10).
- A Node timer refreshed on each read can fire before the next read: when main blocks inside an
  I/O callback (a synchronous SQLite write waiting on `busy_timeout`), libuv runs expired timers
  before it polls again. A liveness watchdog takes one more poll (`setImmediate`) before it acts
  (`HelperProcess.watchdogFired`, M2-T10).
- A child's pid can still exist, not yet reaped, right after its stdout ends:
  `monitorRelaunch.mac.test.ts`'s `isAlive(pid)` check right after EOF failed once under a loaded
  gate (P2-C1, wave 3). Wait for the process's exit, never for its stdout to end.
- After `close()`, a `node:sqlite` prepared statement throws "statement has been finalized"; only
  `exec` and `prepare` (a `transaction()`'s BEGIN included) throw "database is not open". A test
  stub of one message proves nothing about the other (node 22.19, M4-S4b).
- ICU writes September as "Sept" in en-GB short months: a pattern over
  `toLocaleDateString('en-GB', { month: 'short' })` output needs `[a-z]{3,4}`, or one month in
  twelve escapes it (`shared/suggestTemplate.ts`, M4-T23).
- `prettier --check .` in `apps/desktop` (`make check`'s `format:check`) reads this file: a code
  span split across two lines is de-indented and fails the check. Break a line before or after a
  code span, never inside one (M3-T13).
- `ws` answers pings by itself (`autoPong`): a fake vendor that must go silent is built with
  `autoPong: false` and pongs by hand (`answersPings`, `stt/testing/fakeVendorServer.ts`), or a
  dead-socket test passes on a socket that never stopped answering. `CaptureSession.close()` waits
  for every reopen still connecting: a test whose fake STT never answers one
  (`ControlledSpeechToText`) hangs at Stop until its timeout unless it calls `stt.succeed(label)`
  first (M2-T6).
- On macOS Chromium's audio service sandbox cannot read a WAV in the temp folder:
  `--use-file-for-fake-audio-capture=<tmp>.wav` logs "Failed to read ... as input to the fake
  device" and the fake mic sends silence (a dead-mic warning). `e2e/harness.ts` passes
  `--disable-features=AudioServiceSandbox`; the page keeps its own sandbox (M2-T13).
- Playwright on Electron (M2-T13): `page.waitForFunction` resolves at once when its predicate
  returns a promise (a promise is truthy): poll from Node with
  `expect.poll(() => page.evaluate(...))`. It emulates `prefers-color-scheme: light` on every page
  it drives, whatever `nativeTheme` says: force it with `page.emulateMedia({ colorScheme })`.
  `_electron.launch` with `executablePath` adds none of its Chromium switches (mock keychain,
  `password-store=basic`), and main's lines logged before the launch resolves never reach a
  `process().stderr` listener: read startup state with `app.evaluate`.
- A test that pushes chunks through `CaptureService.pushAudio` with no `capturedAtMs`, all in one
  instant, splits the audio timeline about every 250 ms: the fan-out dates each chunk at its
  arrival minus its length, so the times run backwards, and the backup wrote 4 files for 1 s. Pass
  capture times (`backup/backupSlot.test.ts`). A status contributor that returns `warnings: []`
  puts an empty list into every status: leave the key out when it has none (M2-T15).
- A notes save names its base (`SaveNoteRequest.base`), which moves only when the editor puts a
  doc on screen (`editorShows`, `notes/useNoteDocument.ts`). Moved when a doc merely arrives,
  typing flushed at that moment goes out on a doc it never saw and main stores it over the
  server's version. A revision counts as the editor's own only when the answer's doc is the doc it
  sent: the answer to a stale save holds main's doc (M4-T16).
- SQLite uses a partial index on an expression only when the query repeats the index's `WHERE`:
  `MEETING_IDS_BY_EVENT_IDS` spells out `calendar_event_json IS NOT NULL`, or the plan is
  `SCAN meetings` (its test reads `EXPLAIN QUERY PLAN`). An index on `json_extract(column)` makes
  SQLite refuse a write of malformed JSON, yet it takes JSON5, which `JSON.parse` refuses: keep the
  read's parse guard (M5-T5).
- `util/emitter.ts`'s `Emitter` stops at the first listener that throws, and the throw surfaces in
  whatever emitted: a throwing `segment` listener skips `ipc.ts`'s send of the line to the window
  and breaks `CaptureSession.handleEvent` before the line's watermark. Guard every listener, as
  `EchoSink.guard` and `PromptService.guarded` do (M2-T14b, M5-T9b).
- `SttConnection.test.ts`'s "declares the socket dead when nothing came for 4 s" (real ws server,
  3 s `waitFor`) timed out under a loaded parallel gate and passed 5 of 5 alone: rerun it alone
  before blaming a change, and lengthen the wait if it recurs (M2-T6, M5-T11).
- At wake, `CaptureService`'s 500 ms monitor tick (G5, wall clock) can run before Electron's
  `powerMonitor` `resume`: after a sleep of `noSpeechStopMs` or more the stop reads `no-speech`,
  not `system-sleep`. `PowerCoordinator` leaves a stop under way alone; only a G5 that skips paused
  `asleep` time would fix the reason (M2-T18; open, see the build order's "Open items").
- A feature that calls `capture.refreshStatus()` and also listens to `capture.on('status')`
  re-enters its own listener synchronously: start a worker only after its handle is set
  (`GapRetranscriber.kick`), and make a test double's `refreshStatus` emit a status as
  `CaptureService` does, or the recursion shows only in the real runtime (M2-T16).
- `afconvert` writes `WAVE_FORMAT_EXTENSIBLE` (tag 0xFFFE, the real format in the sub-format GUID
  at +24) even for mono PCM16: a WAV reader that checks the plain tag refuses every decoded m4a,
  and only the real-tool test (`gapAudio.mac.test.ts`) catches it (M2-T16).
- Never map a Bluetooth output to `headphones` from its transport alone (`outputRouteOf`): it may
  be a speaker, and headphones turn the echo filter off, so every echo uploads. Unknown is the safe
  reading (M2-T17a).
- `MeetingAppMonitor` reports an EMPTY call-app list when its helper is lost, which read as everyone
  letting go stops a live call 15 s later: a reader of `onCallApps` checks `monitor.running` first
  (`CallDetector.lose`). `recording on` goes out once per meeting, never again in one a
  `--relaunched` launch resumed, or a Roger that crashes on every resume relaunches forever
  (`MeetingAppMonitor.attach`) (M2-T17a, M2-T17b).
- `app.relaunch()` with no `args` passes argv on, `--relaunched` included: filter it
  (`setup/electronSetupPorts.ts` `relaunchArgs`) or the next launch reads as the crash monitor's
  relaunch (M2-T19).
- `CallOffer`'s PromptService is late-bound: `index.ts` calls `callOffer.bindPrompts` after
  `createCalendarRuntime`, and an offer due before it is logged and dropped. `powerMonitor`
  suspend and resume have two listeners on purpose: `PowerCoordinator` acts, `CallOffer` only
  holds `CallDetector`'s release across a sleep (M2-T17b).
- `[slot M2-T23]` in `index.ts` runs before the capture runtime but resumes through `capture`: it
  defers with `setImmediate` and its closure reads `capture` before that line. An `await` between
  that slot and `createCaptureRuntime(` puts the closure in the TDZ (a ReferenceError in main);
  `CrashRecovery.test.ts` reads `index.ts` as text and fails on one. A meeting kept open for a
  resume is ended per meeting (`setMeetingStopReason` plus `markMeetingEnded`), never with
  `store.endMeetingsLeftOpen` after launch, which ends one a Start of this run just made (M2-T23).
- A silence-gate test (M3-T20, on by default) that pushes exact zeros for a minute or more meets the
  gate: sessions close after 60 s and a "reopen" test reopens on nothing. Push a voice level
  (`new Uint8Array(3200).fill(64)`) or set `sttSilenceCloseMs: 0`; a `fill(1)` chunk is not silence
  either, since any chunk 9 dB over a zeros floor reads as speech. A flow test that builds
  `CaptureService` also needs its speech-to-text double to implement `usage()`, or Start fails with
  "stt.usage is not a function" and capture stays idle with no other symptom (M3-T20, M5-T9c).
- A memory test after a forced `gc` leaves out V8's `code_space` and `trusted_space` (V8 flushes
  unused bytecode on its own schedule, about 1 MB between two measurements). Get `gc` in a Vitest
  worker with `v8.setFlagsFromString('--expose-gc')` then `vm.runInNewContext('gc')`, and wait a
  real `setImmediate`: backing stores are freed a tick after (`CaptureService.soak.test.ts`,
  M3-T4b).
- Vitest fake timers give a `setTimeout(0)` set while a tick runs a 1 ms delay, so
  `advanceTimersByTimeAsync(0)` never runs a 0 ms timer chained inside a pass: assert a bound.
  Start and Stop on `FakeSpeechToText` resolve through microtasks only, so a 0 ms timer set when
  the runtime is built fires after both: wait for the launch pass first (`sttUsageSlot.test.ts`).
  A pass with nothing to send finishes in the turn it started but its promise is still pending:
  check a "send again" flag in the `finally`, or a `sendNow` in that turn is lost (M3-T19b).
- `react-hooks/immutability` (v7) refuses a write to `someProp.current` unless the prop's name ends
  in `Ref`: pass a ref down as `fooRef`. `FormEvent` is deprecated in `@types/react` 19 and lint
  fails on it: let an `onSubmit` handler's event type be inferred (M4-T19).
- electron-vite builds both preloads in ONE pass: a module `preload/index.ts` and `preload/prompt.ts`
  both import becomes `chunks/<name>.js`, which a sandboxed preload cannot `require()`, so
  `window.roger` or `window.rogerPrompt` is missing with no build error. `prompt.ts` writes its own
  invoke and subscribe; `preload/prompt.test.ts` fails on a shared import (M5-T10).
- `page-policy`: the prompt page counts as the app for navigation (`isAppPageUrl`) but must stay
  out of `isPermissionAllowed`. Any new page in that folder inherits media from `isAppPageUrl`
  unless it is excluded as `isPromptPageUrl` is. A `BrowserWindow` created `show: false` with the
  default `backgroundThrottling` never paints, so a height reported from its page never arrives:
  the prompt panel sets `backgroundThrottling: false` (M5-T10).
- `RecordingLifecycle` reads its `quitHooks` at quit, but `index.ts` builds it before the feature
  slots that follow: a later slot joins through one late-bound entry (`let stopCalendar`,
  `run: () => stopCalendar?.()`), and a hook that awaits the account runs before the cache closes.
  The main window's `focus` is unreachable before `createMainWindow`: use
  `app.on('browser-window-focus', ...)`, so the never-focusable prompt panel is not "the user
  looking" (M5-T9c).
- Closing the main window only hides it (M5-T11). `watchWindow` stops the recording on `closed`,
  never `close`, which fires for a hide too, and `hideOnClose` (`app/windowLifecycle.ts`) must let a
  close through while `RecordingLifecycle.quitting` is true, or Cmd+Q never exits
  (`windowLifecycle.test.ts` runs the real quit sequence). A dev build's data folder is "Roger Dev"
  (`app/userDataPath.ts`, set before `requestSingleInstanceLock`): productName is "Roger" in dev
  too, so both shared one userData, one lock and one `roger.sqlite`. Never register a login item
  unpackaged or under `ROGER_E2E` (`loginItemPolicy.decideLoginItem`); `openAsHidden` is gone on
  macOS 13+, use `wasOpenedAtLogin`. Tray icons are `build/tray*Template.png` plus `@2x` (the
  `Template` suffix makes macOS tint them), reach a packaged app only through `electron-builder.yml`
  `extraResources`, and `createFromPath` of a missing file returns an EMPTY image with no error.
- The meeting page is one column: each pane is a flex column with `overflow-y: auto` inside
  `.meeting-body` (a pane without it once painted over the chat and took its clicks, M4-T20), and
  closed panes carry `hidden`. A component mounted in a slot file that reads
  `window.roger` breaks every Node test that renders the real slots: mock the slot file
  (`vi.mock('../app/slots/m4-notes', () => ({ contributions: {} }))`, likewise `m5-calendar`),
  never stub `window` (`MeetingPage.test.ts`, `AppLayout.test.ts`; M4-T20, M5-T13).
- QA traps. A check on what the page does as it loads cannot seed the preview fake (scenarios start
  after the app subscribes): emit the state on the hub once the page is up, as `redesign.qa.e2e.ts`
  does for the setup status, or wrap `window.roger` in `context.addInitScript`. `qa.expectVisible`
  uses `document.querySelector`, so `:text-is()` throws: give a control a data attribute (M2-T19). A
  `dl`'s `textContent` joins label and value ("Saved locally120 lines"): match per row (M2-T20a).
  Ask is disabled while the chat box is empty: type first (M4-T19). The AI panel's streamed lines
  reuse `.note-editor-content` and come before the editor: select `.ai-notes-editor
.note-editor-content` (M4-T18). The preview names a started meeting by the clock: read
  `getCaptureStatus().title`, not the `h1`. `no-unnecessary-condition` applies inside
  `page.evaluate`, where `textContent` is `string` and `?? ""` fails (M5-T13). A busy
  `.btn[aria-disabled='true']` has `pointer-events: none`, so `elementFromPoint` skips it: click it
  by DOM, and its handler ignores clicks itself (redesign R0b).
