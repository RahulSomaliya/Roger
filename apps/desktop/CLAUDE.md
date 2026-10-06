# Roger desktop: failure log

The desktop app's part of the failure log in the root `CLAUDE.md`, whose house rules apply here
unchanged: traps someone already hit in `apps/desktop`, its bench, e2e and QA scripts and the Swift
helper included. Add one when you hit a new one. A trap that also bites the API, the repo's tooling
or this Mac goes in the root file instead.

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
  adjacent text pieces (`2<!-- --> of <!-- -->100`): strip it before matching text (M3-T8).
- A vitest test can switch time zones with `process.env.TZ`, but assert
  `new Date(...).getTimezoneOffset()` inside the switch, or a TZ test passes when the switch did
  nothing (M5-T8).
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
- In dark, one colour cannot be both a fill under white text and text on `--panel`; in light,
  danger cannot either (4.46:1 as text on `--bg`, 3.7:1 in the error box). `--accent` and
  `--danger` are fills under `--on-accent`; text in those hues uses `--accent-ink` and
  `--danger-ink`, and `tokens.test.ts` checks the fills, the inks on `--panel` and `--bg`, and
  error text on its `--danger-bg` tint (M4-S2).
- Main's errors reach the renderer as text ("Error invoking remote method '<channel>': ApiError:
  ..."), never as the class: renderer code never checks `instanceof ApiError`;
  `app/describeError.ts` strips the wrapper (M4-S3).
- Never write `location.hash`, `<a href="#/...">`, `history.pushState` or `history.replaceState`
  in the renderer while `lifecycle.ts` stops recording on `did-start-loading`: Chromium starts a
  load on a same-document navigation, a hash change or a `replaceState` (seen in Chrome; Electron
  not yet checked). The shell keeps its route in `sessionStorage` (`app/router.ts`). The
  controller drops this line once M2-T12 removes the stop (M4-S1).
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
  yet read (M3-T12, M4-T15).
- `node:sqlite`'s `prepare()` compiles only the first statement and ignores the rest: a SQL file
  run through it holds exactly one (`PromptLog.test.ts` checks `calendar-streak.sql`, M5-T9a).
- QA (M3-T7, M3-T8, M4-T17): an `import()` inside `page.evaluate` in an `e2e/` file throws in the
  page (Vitest rewrites it): pass that code as a string. The shell scrolls in `.shell-page`, so
  grow the viewport until it stops scrolling (`fitShellPage`, `e2e/m3-t8.qa.e2e.ts`). A package the
  app has not imported yet makes Vite reload the page mid-`evaluate`: take that on a throwaway page.
- CSS that sets `display` on an element with the `hidden` attribute overrides it: add
  `[hidden] { display: none }` beside it (`meeting/meeting.css`, M4-S4).
- TipTap (M4-T17): ProseMirror fills missing attrs with null, so `isRequired` lets a bare node
  through (add `validate`); `setEditable(x)` emits `update` unless its second argument is `false`;
  a doc given as `content` meets its first transaction at the first click (an atom click threw
  "Selection passed to setSelection must point at the current document"): run one at load.
