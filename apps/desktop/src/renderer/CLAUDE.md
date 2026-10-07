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
- A regex word boundary matches inside a hyphenated class name: assert a removed class with
  `/class="(?:[^"]* )?notice[" ]/`, not `\bnotice\b`, which matched `calendar-notice` (redesign R9).
