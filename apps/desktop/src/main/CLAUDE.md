# Roger main process: failure log (since the redesign sweep)

Extends `apps/desktop/CLAUDE.md` (at its 300-line limit) and the root `CLAUDE.md`: these are the
traps hit in `apps/desktop/src/main` and the native surfaces since the redesign sweep
(`docs/plans/redesign-sweep.md`). Add one when you hit a new one.

- The window is `hiddenInset` with its traffic lights at x 16, y 18 for the renderer's 52 px header
  (`TRAFFIC_LIGHT_POSITION` in `window.ts`; `--header-height` and the 80 px
  `--header-inset-start` in `renderer/src/app/app.css`). Change both sides together, or the lights
  sit off the header's middle line. Saved bounds (`app/windowBounds.ts`) restore only when the whole
  window lies inside a connected display: a window half on a vanished display has its title bar out
  of reach (sweep T3).
- `app/appearance.ts` holds the `canvas` colours as hex, because `BrowserWindow` takes no oklch:
  change them with `--canvas` in `tokens.css`, or the window flashes the wrong colour at show. Go >
  Settings keeps `registerAccelerator: false`: Roger > Settings owns Cmd+, and two registered owners
  both fire (sweep T3).
- A shown `Notification` is garbage-collected with its click listener once nothing holds it:
  `notify/Notifier.ts` keeps each one until `click`, `close` or `failed` (capped at 20). Read a
  meeting's id before `capture.stop()` if a later notice must open it: the session is gone once
  Stop resolves (`detect/CallOffer.ts`) (sweep T3, follow-ups).
- A capture failure's words come from `capture/errorWords.ts`. Three refusals reach it as plain
  Errors told apart by their text (`CaptureSession.open`'s budget refusal, the jargon-list retry,
  ipc-validation's `refuse`): reword a throw and its pattern together, or the person reads the
  fallback sentence. `CaptureStatus.error` is that plain sentence; the raw text is `errorDetail`,
  shown only in Details and the log (sweep T2).
- A meeting's default title comes from the same instant the prompt card shows: a blank calendar
  invite is named from its `scheduledStart`, a manual Start from the click (`CaptureService`) (sweep
  follow-ups).
- The prompt window hides only on the page's height-0 report, or after `EXIT_FALLBACK_MS`
  (`prompt/PromptWindow.ts`); the page's `EXIT_BACKSTOP_MS` stays under it, or a leaving card is cut
  off. A card's text never comes from a thrown error: the panel gets a flag or a card id, and
  `PromptService` writes a plain line while the raw text goes to the prompt log's `detail` (sweep T1).
- The app icon and the tray glyphs are drawn only by `apps/desktop/scripts/make-icons.py`
  (`python3 -I`, Pillow and `iconutil`): a token change does not reach them on its own. A new
  `tray*Template.png` needs its `@2x` and a `TRAY_ICON_FILES` entry. In `app/trayMenu.ts` only
  `recording-warning` may ride on the recording icon; the calendar warning never outranks
  `recording` (sweep T7).
- A message in `setup/connectionChecks.ts` holds no address, setting name, status code or vendor:
  those go to the log line, and `connectionChecks.test.ts` fails on them (sweep T7).
- The Google sign-in return page (`calendar/oauthLoopback.ts`) runs under `default-src 'none'`: its
  one inline stylesheet is allowed by a sha256 of `PAGE_STYLE`. Edit the style through that
  constant, never inline in `page()`, or the browser drops it in silence; its colours are copied
  from `tokens.css` (sweep T8).
