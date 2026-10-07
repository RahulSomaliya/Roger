# Roger renderer: failure log

Extends `apps/desktop/CLAUDE.md` and the root `CLAUDE.md`: these are the traps hit in the renderer
and its UI since the Course Player redesign (`docs/design.md`, `docs/plans/redesign.md`). Add one
when you hit a new one.

- Main and the page share one clock, `shared/clock.ts` `formatClock(at, timeZone?)`
  (`renderer/src/clock.ts` re-exports it). Words the user reads never come from
  `toLocaleTimeString` with en-GB (24 h); the tray's `createTrayFormat(timeZone)` passes the zone
  through, so tests pin one (redesign R9).
- `onClick={startNewNote}` passes the click event as the `StartCaptureRequest`: always write
  `onClick={() => startNewNote()}` (`app/ShellContext.tsx`, redesign R1).
- A page that builds an `AiNotesSession` (or any store over `window.roger`) while rendering hands it
  a lazy forwarder, `(...args) => window.roger.x(...args)`, never `window.roger` itself: Node has no
  `window`, and `renderToString` runs the render phase (`meeting/useMeeting.ts`, redesign R2). A
  component using `useId` and a hook that reads `window.roger` (`useCalendar`) cannot render in a
  node test either: mock the hook module as `HomePage.test.ts` does (redesign R1).
- `todayGroups` returns no all-day and no declined events: code that wants them reads
  `state.events` itself (redesign R1).
- A control that is `disabled` while a save is out loses the click after a blur-save: blur fires on
  mousedown of the next control, and the re-render disables it before mouseup. Settings controls
  are never disabled for "saving" (main's `prefs:set` is synchronous, so sets apply in order). A
  disabled text box also drops the caret for good: a save-at-once list editor keeps the box enabled
  and queues edits behind the save in flight, and an older answer never replaces a newer draft
  (`settings/vocabularyEditor.ts`, `calendar/CalendarSettings.tsx`, redesign R6).
- Set up Roger folds only rows of tone ok (`splitRows`). A grey check that carries a message is
  tone attention (`fromCheck`), so it is never folded and blocks Done (`setupRows.test.ts`,
  redesign R7).
- The prompt panel does not load `styles.css`: its `.btn`, `.problem` and space and type tokens are
  copies in `prompt/prompt.css`, and `tokenReads.test.ts` pools every sheet, so it passes on a var
  only `styles.css` defines. `prompt/promptCss.test.ts` pins the copies: change a `.btn` or
  `.problem` rule in both sheets in one commit. The panel's window draws its own shadow
  (`hasShadow`, transparent), which clips a CSS `box-shadow`: the card sits on a 1 px line. Across
  stacked cards only the panel's first start is primary (`promptButtons.ts` `leading`)
  (redesign R8).
- The consent line shows its text as an out-of-flow popover (opacity, not `display: none`) on hover
  and focus: a line that grows would move the notes under the cursor, and `display: none` hides the
  text from screen readers. Its buttons are `.calendar-notice-buttons`; `.calendar-notice-actions`
  is the settings editor's (redesign R9).
- A regex word boundary matches inside a hyphenated class name, and `toContain` matches a longer
  one: assert a removed class with `/class="(?:[^"]* )?notice[" ]/`, not `\bnotice\b` (it matched
  `calendar-notice`) or `toContain('capture-warning')` (the wrapper is `capture-warnings`)
  (redesign R9, R3).
- `renderToStaticMarkup` escapes an apostrophe as `&#x27;`: a test helper that strips tags also
  replaces it before matching text that holds one (redesign R3).
- The banner hides loud capture warnings on the recording meeting's own page, because the header's
  status line says them there; both decide with `captureStatusFor` (`meeting/liveMeeting.ts`).
  Change both in one commit, or a warning shows twice or not at all (redesign R3).
- The renderer has no logger and `no-console` is an error: report an error the page shows on
  purpose nowhere with `reportError(new Error(...))` in an effect (`AppLayout`, the theme
  preference), never `console` (redesign R3).
- Two `AiNotesSession`s run per meeting page: the header's (`useMeetingNotes`) and the AI tab's
  (`AiNotesPanel`). A confirmation or error one holds is invisible to the other, so each action's
  failure shows in the surface of the session that ran it (redesign R4).
- Deleting a phase or key from a shared type (`needs_template`, a preference key) fails typecheck in
  `e2e/*.qa.e2e.ts` and in every test double typed as the whole type: grep `e2e` and `preview`
  first (redesign R4).
- A meeting pane scrolls, so it clips a focus ring (2 px plus a 2 px offset) on a control flush to
  its edge: keep `--space-1` of room at its sides and bottom (`chat/chat.css`) (redesign R5).
- Set up Roger has no header, so its only exit is the button at the foot of `SetupScreen`: Later
  while a check needs you, Done when all pass. Never hide both behind `needsYou()`, or a person who
  cannot pass a check yet is stuck on `#/setup` (redesign R11).
