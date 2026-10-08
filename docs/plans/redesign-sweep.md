# Redesign sweep: every surface Roger shows a person

**Phase:** after 2 · **Status:** draft, waiting on the decisions in section 6 · **Owner:** Rahul ·
**Plan written:** 2026-10-08 · **Closed:** -

## Goal

Rahul, reviewing the redesign: "I see that we've completely skipped the top right banner's redesign
for meeting alerts. Can we take EVERYTHING into consideration please? Detail is the key part of our
redesign success." Then, from the installed app: "change the default window size to something like
this (landscape) and design everything accordingly", and "once I open the settings, I don't find the
reason I entered (turning on light mode), and now I don't have a way to go back to home screen (no
back). Make everything not just well designed, but very easy to use and access."

The redesign (`docs/plans/redesign.md`, R0a to R13) restyled the screens inside the main window and
checked them at 1440 and 390 wide. It never designed the surfaces around that window: the prompt
panel (R8 only removed things from it), macOS notifications, the menu bar item, the app menu, the
dock and app icon, the window itself, the Google sign-in page, the permission prompts, and the words
main writes that reach all of these. After this sweep every surface a person can see follows
`docs/design.md`, the window opens landscape and is designed for it, every page has a way back, and
Appearance is a setting.

## Done when

- [ ] Every row of the inventory below reads "yes" in its last column, checked in the QA run.
- [ ] No text a person reads (page, banner, prompt panel, notification, menu, dialog, setup row)
      holds a vendor name with an HTTP code, a route, an errno, an id, or the words helper, stream,
      worklet, Postgres, API, SQLite; raw text lives in a detail field that only Details and the log
      show. A test pins it for every known failure (T2, T7, T9).
- [ ] The window opens about 1080 × 730, landscape, and every page reads as designed at that size and
      at 420 wide.
- [ ] Every page but Home has an obvious way back; Settings has Appearance; the prompt panel follows
      it.
- [ ] `make check` green; one QA gallery at 1080 × 730 and 420 wide, light and dark, the prompt panel
      at its real place over a call, published.

## How the sweep was done

- Read `docs/design.md`, `docs/plans/redesign.md`, Rahul's brief, the root `CLAUDE.md` (Words) and
  `apps/desktop/src/renderer/CLAUDE.md`, and the 102 captions of
  `/Users/rahulsomaliya/Documents/learn/roger-qa/qa-2026-10-07-redesign.html`.
- Read every file that draws or words a surface (cited `file:line` below), and traced every path by
  which main's error text reaches the screen (appendix A).
- Shot the browser preview in both themes: the prompt panel at its real place (360 px, 16 px from
  the top right, under a menu bar, over a dark call), the app at the window's real sizes (520 × 760
  today, 1080 × 730 asked for), and states the gallery did not cover. Shots:
  `scratchpad/sweep-shots/` of the sweep session (not in the repo).
- Read, without changing anything, the installed app's data folder for the fake calendar (section 7).

## 1. Inventory

"Covered" is whether the redesign designed it (yes, partly, no). "Easy" is the ease-of-use lens:
reached in one obvious step, left in one, every control findable, keyboard and focus right, labels
say what happens, no dead end.

| # | Surface | Where | Covered | Easy to reach and leave | Gaps |
| --- | --- | --- | --- | --- | --- |
| 1 | Prompt card: a meeting with a video link | `renderer/src/prompt/PromptPanel.tsx`, `prompt.css`, `promptButtons.ts`, `promptFormat.ts` | partly (words and one primary only) | Dismiss sits alone a row below the starts; not reachable by keyboard (by design, non-activating) | P1 P2 P5 P6 P7 P11 P16 |
| 2 | Prompt card: no video link | same | partly | as 1 | P1 P7 P8 |
| 3 | Prompt card: two meetings starting together | same, `PromptService.ts` `sharesCard` | partly | 351 px tall; the overline repeats per meeting | P1 P7 |
| 4 | Prompt card: a call Roger noticed | `promptFormat.ts:29-32` | partly | the title reads as a privacy warning, not an offer | P1 P12 |
| 5 | Prompt card: another meeting is recording | `promptFormat.ts:52-55` | yes (helper line) | fine | P1 |
| 6 | Prompt card: after a start ("Recording", 5 s) | `PromptPanel.tsx:139-148` | partly | does not name the meeting; vanishes with no motion | P3 P10 |
| 7 | Prompt card: start failed, any error, the panel's own read failure | `PromptService.ts:551-817`, `PromptPanel.tsx:44-73`, `promptState.ts:37-38` | partly | raw main and vendor text; the reason sits under Dismiss | P2 P9 |
| 8 | Prompt panel window: place, width, height, stacking, shadow, motion, theme, lifetimes | `main/prompt/PromptWindow.ts`, `promptBounds.ts`, `PromptService.ts` | no | pops in and out; follows macOS, not Appearance | P3 P4 P13 P14 P15 P17 |
| 9 | macOS notifications: loud capture warnings | `main/notify/Notifier.ts`, `main/capture/warnings.ts` | no | a click only activates Roger; the meeting does not open | N1 N4 N5 |
| 10 | macOS notification: the call ended | `main/detect/CallOffer.ts:230-233` | no | fine | N2 N6 |
| 11 | macOS notification: Set up Roger's test | `main/setup/PermissionService.ts:85-86` | no | fine | N3 |
| 12 | App icon: Dock, Cmd+Tab, About, Finder, every notification | `electron-builder.yml` (no `icon`), `/Applications/Roger.app/Contents/Resources/electron.icns` | no | Roger looks like any Electron app | M1 M9 |
| 13 | Menu bar item: icon and tooltip | `main/app/trayMenu.ts:82-115`, `build/tray*Template.png` | no | a loud capture warning never shows there | M7 M8 M10 |
| 14 | Menu bar item: menu | `main/app/trayMenu.ts:90-165` | partly (R9 renamed three items) | no Settings, no meeting name while recording | M6 |
| 15 | App menu: Roger, File, Edit, View, Window | `main/appMenu.ts` | no | no Start notes, Home or Back; Reload and Developer Tools in the shipped app | M5 V3 |
| 16 | Main window: size, minimum, title bar, saved bounds, background | `main/window.ts:59-66` | no | portrait 520 × 760; two "Roger"s; forgets its size | M2 M3 M4 V5 |
| 17 | Fatal start dialog | `main/index.ts:535` | no | prints the raw error, says nothing to do | D2 |
| 18 | Google sign-in return page (in the browser) | `main/calendar/oauthLoopback.ts:239-241` | no | unstyled serif `<p>` | D1 |
| 19 | macOS permission prompts | `electron-builder.yml` `extendInfo` | no | "system audio" | K1 |
| 20 | Header and navigation | `renderer/src/app/AppHeader.tsx`, `app.css:33-80` | yes, but no way back | the wordmark is the only way Home and does not read as one | V1 V2 V3 V4 R11 |
| 21 | Banner: capture error, stop notice, loud warnings, refused lines | `app/BannerSlot.tsx`, `components/capture/WarningBanner.tsx` | yes (look); no (words) | raw vendor text above every page ("xAI: rejected with HTTP 401") | W1 W2 W3 |
| 22 | Home: empty, calendar, recording, problem | `app/HomePage.tsx`, `calendar/TodaySection.tsx`, `NextMeetingCard.tsx` | yes at 1440 and 390 | at 1080 a 360 px column floats in the window | R1 P8 W11 |
| 23 | Meeting page, live: header, status line, consent line, tabs, My notes | `meeting/*`, `components/capture/StatusLine.tsx`, `calendar/NoticeBanner.tsx` | yes | the full warning lives only in a hover tooltip | R2 R8 R9 W8 W10 |
| 24 | Meeting page, past: Write notes, Writing, AI notes, the more-actions menu, the gap line | `meeting/MeetingHeader.tsx`, `notes/*` | yes | Cancel appears under the pointer of a second click; no way to copy the notes | R3 W5 W13 |
| 25 | My notes editor content (headings, lists, quote, code, link, placeholder, selection) | `notes/notes.css:73-209` | partly | fine | R5 R6 |
| 26 | Transcript tab | `transcript/*` | yes | fine | R4 R7 |
| 27 | Chat tab | `chat/*` | yes | fine | W5 |
| 28 | Details dialog: live, past, offline, kept audio | `components/capture/CaptureDetails.tsx`, `meeting/MeetingHeader.tsx:84-111` | yes for live | empty for a meeting with no capture report | D3 |
| 29 | Confirm dialogs and confirms in place (replace edited AI notes, Delete audio, Disconnect) | `meeting/MeetingProblems.tsx:56`, `components/capture/AudioKept.tsx`, `calendar/CalendarSettings.tsx:194` | yes, but Disconnect | Disconnect ends every reminder with no confirm | D4 |
| 30 | Settings: Appearance, Calendar, Jargon list, notice, Open at login | `app/SettingsPage.tsx`, `settings/*`, `calendar/CalendarSettings.tsx` | yes (minus Appearance) | Appearance does not exist; no way back; Set up Roger only in the app menu | A1 V1 W11 |
| 31 | Set up Roger: every row state | `components/setup/*` | yes | no header: the foot button is the only exit | V4 R12 W4 |
| 32 | Loading frames, root error, slot failure | `meeting/MeetingPage.tsx:102`, `app/SlotOutlet.tsx:37-55`, `App.tsx` | partly | a render error outside a slot blanks the window | W7 |
| 33 | Focus, tooltips, selection, scrollbars, reduced motion | `styles.css:86-121`, `title=` attributes | partly | tooltips are hover only; focus never moves on navigation | R8 R11 |
| 34 | Words main writes: stop reasons, default titles, the capture report, Copy notice | `main/capture/stopReasons.ts`, `CaptureService.ts:1464`, `components/capture/reportText.ts`, `calendar/NoticeBanner.tsx` | partly (R9) | fine | W3 W9 W12 W13 |
| 35 | Where the calendar comes from (fake provider) | `apps/api/src/roger_api/config_calendar.py:44`, `services/calendar/fake.py` | no | a fake account looks real | F1 |

## 2. Gaps, by surface

Severity: **must** breaks a rule of `docs/design.md`, a house rule or honesty where a person sees it,
or blocks use; **should** is a visible inconsistency or a usability gap; **polish** is detail.
Shots are named as saved in the sweep session's `sweep-shots/`.

### Prompt panel (the top-right meeting alert)

- **P1 must. It was never designed, only trimmed.** One meeting is a 214 px card (`prompt-meeting-link`,
  measured): overline, a 2-line title, a time line, the starts, then Dismiss alone on a footer row
  (`PromptPanel.tsx:154-164`, `prompt.css:167-173`): a third of the card for the least-used
  control. Two meetings: 351 px with the overline twice. Nothing in it uses Home's vocabulary for the
  same facts. Full brief in section 3.
- **P2 must. Raw text on the card.** `card.error` is `errorMessage(error)` or `status.error`
  (`PromptService.ts:607`, `:615`, `:761`), drawn as is (`PromptPanel.tsx:72`): a failed start shows
  "xAI: rejected with HTTP 401" on the panel. The panel's read failure prints "Could not read the
  prompt panel: Error invoking remote method 'prompt:...'" (`promptState.ts:37-38`); a refused click
  prints "Roger could not do that: ..." around whatever main threw (`PromptPanel.tsx:73`).
- **P3 must. No entrance, no exit.** The window shows with `showInactive()` and goes with `hide()`
  (`PromptWindow.ts:100-104`, `:120`): the card pops in over the call and vanishes, the 5 s
  "Recording" line too (`TAKING_NOTES_SHOWN_MS`). The Motion table has no row for it.
- **P4 should. It ignores the theme preference.** The panel follows macOS only (`docs/design.md`
  Traps; `docs/plans/phase-2-build-order.md:2013`), so a person who picks Light (A1) still gets a
  dark card on a dark Mac.
- **P5 should. Its edge disappears in dark.** `raised` (L 0.25) on a 1 px `line` (L 0.30) over a
  dark call, where the system shadow cannot show (`prompt-*-dark`). A floating surface needs an edge
  that reads on any backdrop: a new `edge` token (T0).
- **P6 should. Ghost hover is invisible in dark.** `.btn:hover` paints `fill` (0.26) on `raised`
  (0.25) (`prompt.css:248-250`): the trap `docs/design.md` names ("`fill` on `raised` vanishes in
  dark"). The same rule hits the more-actions menu (`styles.css` `.menu-item:hover`). A new
  `fill-raised` token (T0).
- **P7 should. Its words differ from Home's for the same facts.** Hours "3:27 – 3:57 pm" with an en
  dash and the first "pm" dropped (`promptFormat.ts:39-45`) against Home's "3:37 pm to 4:07 pm"
  (`NextMeetingCard.tsx:28`) and the meeting page's "3:00 pm to 3:03 pm"; the overline "Starting in
  1 min" in sentence case, 12 px `ink-muted`, against Home's caps overline "NEXT · STARTING IN 2 MIN"
  (`NextMeetingCard.tsx:23-25`).
- **P8 should. "Untitled meeting".** A blank invite reads "Untitled meeting" (`promptFormat.ts:26`,
  and Home through `eventTitle`, and the tray, `trayMenu.ts:140`), but the meeting it starts is named
  "Meeting at 3:27 pm" (`CaptureService.ts:1464-1466`). The naming list retired "Untitled meeting".
- **P9 should. The failure reads last.** A failed start's reason is drawn under Dismiss, the last
  line of the card (`PromptPanel.tsx:72`, `prompt-start-failed-*`): what happened must come before
  what to do.
- **P10 should. "Recording" does not say what.** The confirmation after a start is a dot, "Recording"
  and Open Roger (`PromptPanel.tsx:139-148`); with two calls on a card it does not say which one
  started. "Clear honest confirmation after important actions" names it.
- **P11 should. No identity.** Nothing on a card floating over another app's call says Roger; every
  macOS banner names its app.
- **P12 should. "Zoom is using the microphone"** (`promptFormat.ts:29-32`) reads as a privacy
  warning (macOS already shows its own microphone light), not as an offer to take notes.
- **P13 polish. Stale system shadow.** A transparent window's shadow is computed by macOS and cached;
  nothing calls `invalidateShadow()` after `setBounds` (`PromptWindow.ts:119`), so a card that grows
  (a problem line, a second meeting) can keep the old shadow. Real-Mac check.
- **P14 polish. QA never saw the real panel.** The preview centres the card on a `fill` stage
  (`preview/prompt.tsx:42-47`) and the gallery shot it "at 1440 and 390" while the window is always
  360 px: it proved one primary, not the design.
- **P15 polish. Stacking order.** A new card goes under the ones up (`PromptService.ts` pushes);
  macOS banners put the newest on top.
- **P16 polish. Keyboard.** The panel can never take focus (`focusable: false`, on purpose: it must
  not pull focus from the call). The keyboard path is Cmd+N in the app and the menu bar's Start notes
  (V3); `docs/design.md` now says so.
- **P17 polish. Same corner as macOS banners.** A calendar app's own reminder lands in the top right
  in the same minute. Real-Mac check: which sits above, and whether 16 px from the top clears a banner.

### macOS notifications

- **N1 must. Two word lists for one warning, and the long one is main's raw message.** The body is
  `warning.message` (`Notifier.ts:104`), main's long sentences with "mic", "press Stop, then Start
  again", "transcription stopped", "test system audio" (`warnings.ts:149-168`). The titles disagree
  with the page's headlines for the same warning: "No audio from your mic" / "Roger can't hear you";
  "Your mic stopped" / "Your microphone stopped"; "Transcription is offline" / "The Mac is offline, so
  transcription stopped"; "Jargon list rejected" / "The jargon list was refused" (`warnings.ts:170-182`
  against `components/capture/captureProblems.ts:32-55`).
- **N2 should.** "Stopped: the call in Zoom ended" / "Roger stopped the recording. Your notes are in
  Roger." (`CallOffer.ts:230-233`): "recording" as a noun, and the banner says the same thing in other
  words ("Stopped at 4:59 pm: the call in Zoom ended.", `stopReasons.ts:72`).
- **N3 should.** The test: "Roger can reach you" / "This is how Roger tells you when a recording stops
  hearing you." (`PermissionService.ts:85-86`): "a recording".
- **N4 should. A click goes nowhere.** No `click` handler (`Notifier.ts:168-179`): macOS activates
  Roger on whatever page it was on. A warning's click opens its meeting.
- **N5 polish.** When macOS refuses notifications the dock bounces and shows a "!" badge
  (`Notifier.ts:34`): the only badge in Roger, kept on purpose as macOS's own signal; documented.
- **N6 polish.** Only the call-ended stop notifies. The no-speech, 4-hour and sleep stops post nothing
  while Roger is out of focus; a person away from the window finds out on return.

### App icon, menu bar, app menu, window

- **M1 must. No app icon.** `electron-builder.yml` names none and `build/` holds only tray glyphs; the
  installed app ships Electron's atom (`/Applications/Roger.app/Contents/Resources/electron.icns`). It
  is the picture on the Dock, Cmd+Tab, About, Finder and every notification. Decision D3.
- **M2 must. Portrait window.** 520 × 760, min 420 × 520 (`main/window.ts:59-63`); Rahul asks for about
  1080 × 730, landscape. No bounds are saved anywhere in main (no `getBounds` use), so the new default
  reaches every Mac on the next launch with nothing to migrate, but the size a person picks is also
  forgotten every launch (fixed in T3).
- **M3 must. Two headers.** The system title bar says "Roger" (`window.ts:64`) and the slim header
  says "Roger" again under it (`app-home-520-*`): a second chrome row on every page. Decision D1.
- **M4 should. No window background, no native theme.** No `backgroundColor` and no
  `nativeTheme.themeSource` anywhere in main: a forced theme or a dark Mac flashes the other canvas at
  show and on resize, and native menus, dialogs and the prompt panel ignore the preference (noted as
  open in `phase-2-build-order.md:1099`).
- **M5 should. View menu ships Reload and Developer Tools.** `{ role: 'viewMenu' }` (`appMenu.ts:50`)
  puts Reload (Cmd+R), Force Reload and Toggle Developer Tools in the shipped app; Cmd+R mid-call
  reloads the page that captures audio. The menus hold no Start notes, Home or Back.
- **M6 should. Menu bar menu words and gaps.** "Untitled meeting" (`trayMenu.ts:140`); "Reconnect Google
  Calendar (before Tue 14 Oct)" (`:158-164`) where the naming list says Reconnect (kept here: a menu
  has no surrounding context; the naming list now says so); while recording the menu shows Stop but
  not which meeting nor for how long; "No upcoming meetings" is an empty state (`:131`); no Settings.
- **M7 should. A loud capture warning never reaches the menu bar.** The warning glyph is only for the
  calendar grant (`trayMenu.ts:82-89`, `:111-114`): a reconnect nag shows louder than "Roger can't hear
  the call". While recording with a loud warning the icon is the recording dot with the warning mark.
- **M8 polish.** The glyphs are a bare ring, a dot and a circled "!" (`build/tray*Template.png`): no
  tie to Roger; redraw from the app icon (D3).
- **M9 polish.** About is Electron's default panel (`{ role: 'about' }`, no `setAboutPanelOptions`):
  set name, version and "© 2026 Linkt", nothing else.
- **M10 polish.** Tooltip "Roger: calendar needs attention" (`trayMenu.ts:113`) → "Roger: reconnect
  Google Calendar".

### Dialogs and pages outside the window

- **D1 should. The Google sign-in page is unstyled.** A bare `<p>` in the browser's serif
  (`oauthLoopback.ts:239-241`); "connect again" where Roger says Connect Google Calendar. One sentence
  on the paper canvas in the system font, both themes by `prefers-color-scheme`, with an inline style
  allowed by a CSP hash (no script, as now).
- **D2 polish.** The fatal start box prints the raw error and no next step (`index.ts:535`):
  "Roger could not start. Quit and open it again; if it keeps failing, send the text below to the
  Roger team." then the detail.
- **D3 should. Details opens empty.** For a meeting with no capture report the dialog holds its title
  and × only (`app-details-520-*`, `app-details2-past-meeting-light`): a control that opens nothing.
  Details always shows the stored facts (lines saved, uploaded, why it stopped), or the button is
  absent.
- **D4 should. Disconnect has no confirm.** It ends every reminder (`CalendarSettings.tsx:194`).
  Confirm in place: "Disconnect Google Calendar? Reminders stop." then the same button reads
  Disconnect.

### Permission prompts

- **K1 should.** `NSAudioCaptureUsageDescription`: "Roger captures system audio to transcribe what
  other people say on your calls." The naming list says call audio: "Roger records the call audio
  your Mac plays, to transcribe what others say in meetings." The microphone string stays.

### Words main writes, and errors (appendix A has every path)

- **W1 must. Capture failures reach the banner raw.** `CaptureStatus.error` is `errorMessage(error)`
  (`CaptureService.ts:871`, `:963`) and is drawn as is (`BannerSlot.tsx:18`, `:25`): "xAI: rejected
  with HTTP 401" (`SttConnection.ts:302`), "POST /v1/stt/token failed: connect ECONNREFUSED ..."
  (`main/api/http.ts:74`), "12 lines could not be saved on this Mac: SQLITE_BUSY ..."
  (`CaptureService.ts:837`), "Transcription of Me (me) stopped: ... Reconnecting when its audio flows,
  in 12 s." with a countdown re-written every tick (`:1241-1263`), "Mic (me) stopped: ... Press Stop,
  then Start again." (`:681`). Rahul saw the first above Settings in the installed app.
- **W2 must. Warning messages carry internals and old words.** "Call audio stopped: the call audio
  helper quit (exit 1)", "could not start ... spawn EACCES", "press Stop, then Start again"
  (`warnings.ts:109-116`, `:149-168`; `TapSystemAudio.ts:142`, `:177`, `:303`, `:359-372`), shown on
  the banner and in notifications. The QA script fed the page invented copy instead ("Roger can't hear
  the call. Check the call plays on this Mac.", `e2e/redesign.qa.e2e.ts:415-421`), so the gallery
  never showed main's real words.
- **W3 should.** The stop notice can read "Stopped at 2:32 pm because the Roger window could not reload
  (it kept crashing: crashed)" (`stopReasons.ts:67`, `lifecycle.ts:151-174`).
- **W4 should. Set up Roger rows print configuration.** "Set STT_SAMPLE_RATE=16000 and
  STT_ENCODING=linear16", "Roger's server at http://127.0.0.1:8000 did not answer", "Build it with make
  native" (`connectionChecks.ts:100`, `:113`, `:143-160`; `PermissionService.ts:383-384`), shown at
  `SetupScreen.tsx:259`.
- **W5 should.** AI notes failures show a plain title and then the raw detail on the page
  (`notes/aiNotesActions.ts:202-208` → `AiNotesPanel.tsx:184-185`); chat prints an unknown code's
  message raw (`chat/chatStream.ts:151-152`).
- **W6 should.** Calendar connect failures pass `describeError` unchanged: "Could not reach the Roger
  API to connect Google Calendar. Is it running? (POST /v1/... ECONNREFUSED ...)" and "...listen for the
  Google sign-in on 127.0.0.1: Error: listen EADDRINUSE" (`CalendarAccount.ts:238`, `:345-358`;
  `oauthLoopback.ts:78`, `:108`).
- **W7 should. Render failures.** A slot failure prints the slot and entry ids ("This part of Roger
  failed to show (banner: m2-capture-warnings): ...", `SlotOutlet.tsx:50`), and nothing catches a render
  error outside a slot (`App.tsx`, `main.tsx`): the window goes blank.
- **W8 should.** The My notes placeholder: "Roger turns them into clean notes after the call."
  (`app/slots/m4-notes.ts:14`): AI notes.
- **W9 polish.** "Start" for Start notes in every "press Stop, then Start again".
- **W10 polish.** `aria-label="Capture status"` (`StatusLine.tsx:35`, `:57`): a screen reader hears a
  retired word.
- **W11 polish.** "No calendar connected." beside Connect (`CalendarSettings.tsx:140`); "Not available
  in this copy of Roger (a development build, or Roger is not in Applications)."
  (`calendarFormat.ts:212`); Connect's helper "..., so it opens at login." (`ConnectCalendarCard.tsx:33`).
- **W12 polish.** The offline headline says "transcription" (`captureProblems.ts:49`); the naming list
  keeps Transcribing inside Details.
- **W13 polish.** The only copy-out is Copy notice. Notes leave only by selecting the editor, and
  chip times come along. Decision D5.

### Window size, layout and navigation

- **R1 should. Home floats at 1080.** Content fills 360 px of a 720 px centred column
  (`land-home-today-light`), the rest of the window empty.
- **R2 should. The meeting page's edges do not line up at 1080.** The editor is 68ch inside a 760 px
  column, so it stops 62 px short of the header's actions (`land-live-light`); a 44 px empty band sits
  between the tabs and the editor (the reserved note status line, `notes.css:27-31`).
- **R3 should. Cancel lands under the pointer.** Cancel appears to the right of "Writing notes…"
  (`MeetingHeader.tsx:67-81`) and pushes the primary left, so a second click hits Cancel; Cancel is `md`
  beside Details' `sm`.
- **R8 should. Tooltips are hover only.** The status line's full warning lives only in `title`
  (`StatusLine.tsx:39`), as do chip and remove labels (`CitationChip.tsx:43`,
  `VocabularySettings.tsx:177`); Access says details on hover and focus.
- **R10 should. QA never shot the window's real sizes.** The gallery is 1440 and 390; the window opens
  520 today and 1080 next.
- **V1 must. No way back.** On Settings and the meeting page the only way Home is the "Roger"
  wordmark, a ghost button that reads as a label (`AppHeader.tsx:30-41`). Rahul: "I don't have a way to
  go back to home screen".
- **V2 should.** The gear on Settings is marked current only by `color: ink` (`app.css:66-68`), the
  same as its hover.
- **V3 should.** No keyboard way to Home or back, no Cmd+N for Start notes, Escape does nothing on
  Settings (`appMenu.ts`).
- **V4 should.** Set up Roger has no header (R11), so its exits are Later and Done at the foot; one
  header pattern everywhere is easier. Decision D6.
- **V5 polish.** The window title is always "Roger": Mission Control and the Window menu cannot tell
  pages apart.

### Appearance

- **A1 must. There is no Appearance setting.** The `theme` preference exists
  (`shared/preferences.ts:31-37`, `theme/useTheme.ts`) but no control was ever built: not removed by the
  redesign, never planned ("No task builds a theme control in Settings",
  `phase-2-build-order.md:1099`). Rahul opened Settings for light mode and found nothing.

### Renderer details

- **R4 should.** "Them" in `accent-ink` on every other transcript line (`transcript.css:71-73`): the
  accent hue as decoration, outside `accent-ink`'s role (a link, the "check" mark). Both speakers
  `ink-muted`, Me weight 600.
- **R5 polish.** My notes is a bordered input box (`notes.css:73-91`). Kept for this sweep; at the
  landscape size its edge aligns with the column (R2). Going borderless is the next review round.
- **R6 polish.** Off the scale: inline code at 0.92em (`notes.css:146`), the calendar status at 13 px
  (`today.css:13`). Spellcheck underlines code (`app-editor-rich-light`): `spellcheck="false"` on code.
- **R7 polish.** Literal px off the ladder: `app.css:238`, `:247`, `transcript.css:107`,
  `transcriptNavigator.css:38` (52 px), `captureDetails.css:113`, `:194` (2 px).
- **R9 polish.** The live header says the time twice: "Started 2:56 pm" and "Recording · 39m"
  (`land-live-light`). While recording the time line goes; the status line keeps "Recording · 39m".
- **R11 polish.** Focus stays on the clicked header button after navigation; a screen reader hears
  nothing. Focus moves to the new page's `h1`.
- **R12 polish.** Set up Roger shows "Notifications · Not tested · Send a test notification" above "5
  checks pass" even when everything passes (`land-setup-dark`): an untested row is not a failing one,
  so it folds with the passing rows.

### Fake calendar data

- **F1 must.** The installed app shows the API's fake calendar as a real account. Section 7.

**Count: 35 surfaces; 70 gaps: 12 must, 35 should, 23 polish.**

## 3. The prompt panel: redesign brief (task T1)

A small, calm, glanceable alert: one question ("take notes on this meeting?"), answered in one click
or ignored. It speaks Home's words, and it never takes focus from the call.

### Window

- **Place.** Top right of the work area of the display under the cursor, 16 px from its right and top
  edges (unchanged, `promptBounds.ts`). Once up it stays on its display.
- **Width.** 360 px (unchanged). The card is the window's full width; under a 392 px work area it
  shrinks (unchanged).
- **Height.** The cards' natural height, reported by the page (unchanged); cut to the work area less
  32 px, the page scrolling inside. Growth goes down: the top edge is anchored.
- **Stacking.** One column, 8 px transparent gaps (clicks pass through to the call), newest card on
  top.
- **Shadow.** The system shadow (`hasShadow`, transparent window, no CSS shadow). Call
  `invalidateShadow()` after every `setBounds` and after a card leaves (P13).
- **Theme.** Follows Appearance: main sets `nativeTheme.themeSource` from the `theme` preference (T3),
  which every window's `prefers-color-scheme` follows. The panel needs no `useTheme`.
- **Lifetimes (unchanged).** A calendar card from start − lead (Remind me) until 10 min after its
  start; a call card 10 min; the "Recording" line 5 s after a start.

### One card, anatomy and sizes

```
┌──────────────────────────────────────────────┐  360, radius 12, raised, 1 px edge
│  ROGER · STARTING IN 1 MIN               [×] │  overline 12/16 caps +0.06em ink-muted; × 32 ghost
│  Northwind renewal: pricing, the security    │  title 16/24 600 ink, at most 2 lines then …
│  addendum and the rollout plan               │
│  3:27 pm to 3:57 pm                          │  hours 14/20 ink-subtle, tabular
│                                              │  12
│  [Join and start notes]  Start notes         │  buttons sm 32: primary, ghost
└──────────────────────────────────────────────┘
padding 16 · overline→title 4 · title→hours 4 · hours→actions 12
```

- Height: 144 px with a one-line title, 168 with two (214 today).
- **Dismiss is an × icon button** at the top right: ghost, 32 × 32, Lucide `x` 16 px, set 8 px into the
  padding so the glyph lines up with the 16 px edge. Accessible name and tooltip "Dismiss". It frees
  the footer row: "Join and start notes" (157 px), "Start notes" (99) and the word Dismiss (77) do not
  fit one 328 px row, which is why Dismiss sat alone.
- **Overline.** "Roger · Starting in 1 min", "Roger · Starting now", "Roger · Started 3 min ago", from
  Home's `startLabel`, drawn with a copy of `styles.css`'s `.overline` rule in `prompt.css` (caps by
  CSS; `promptCss.test.ts` pins the copy, as it pins `.btn`). "Roger" is the identity (P11).
- **Title.** The invite's title; a blank one is "Meeting at 3:27 pm", the title the meeting will get
  (P8).
- **Hours.** "3:27 pm to 3:57 pm", the one form Home and the meeting page use (`meetingHours` in
  `shared/clock.ts`, T0).
- **Buttons.** With a link Roger may open: **Join and start notes** (primary) and Start notes (ghost).
  Without: **Start notes** (primary). Across the panel only the first start is primary; a second
  meeting's first start is secondary, its other ghost (unchanged rule).
- **Another meeting recording.** One helper line under the buttons, 12/16 `ink-muted`, one line with
  an ellipsis: "Stops notes on Weekly sync" (unchanged words; +24 px).

### Every kind

| Kind | Overline | Title | Under it | Buttons |
| --- | --- | --- | --- | --- |
| Meeting with a video link | Roger · Starting in 1 min | the invite's title | hours | **Join and start notes**, Start notes, × |
| Meeting without one | Roger · Starting in 1 min | the title | hours | **Start notes**, × |
| Two meetings starting together | once, at the top | each meeting: title, hours, its buttons, a hairline between them (12 px above and below) | | the first meeting's first start is primary; × once, top right |
| A call Roger noticed | Roger · Now | Call in Zoom | nothing | **Start notes**, × |
| Another meeting recording | as its kind | as its kind | + "Stops notes on Weekly sync" under the buttons | as its kind |
| After a start (5 s) | none | one row: static dot, "Recording" (600) · the title (`ink-muted`, ellipsis) | | Open Roger (ghost) at the row's right end; 64 px tall |
| Start failed | as its kind | as its kind | a loud problem line between the hours and the buttons: icon, one sentence | the same buttons: pressing a start again is the retry |
| The panel could not read main's state | none | "Roger could not show this reminder." as a problem line | | none; it goes with the next state |

### Words for failures (plain, then what to do; raw text only to the prompt log)

| Cause | Line |
| --- | --- |
| Capture refused or failed (any `status.error`, now plain from T2) | that plain sentence, as T2 words it |
| Stopping the other meeting failed (`stop_failed`) | "Roger could not stop the notes on Weekly sync. Stop them in Roger, then try again." |
| A request main refused (`request_refused`) or the row could not be written | "Roger could not start notes from here. Try again." |
| No window took the request (`not_taken`) | "Roger's window did not start the notes. Open Roger and choose Start notes." (unchanged) |
| No link Roger can open | "This meeting has no Meet, Zoom or Teams link Roger can open." (unchanged) |
| A start already under way | "Roger is still starting your last notes. Try again in a moment." (unchanged) |
| A click main rejected | "Roger could not do that. Try again." |

### Motion (added to the Motion table in `docs/design.md`)

| Moment | What moves | Spec |
| --- | --- | --- |
| A card arrives | opacity 0 → 1, `translateX(12px)` → 0 | `slide-in` 240 ms ease-out, after the window shows |
| A card leaves (×, a start's 5 s line ending, expiry, a calendar card replacing a call card) | opacity → 0, `translateX(12px)` | 170 ms ease-in; main hides the window only when the page reports height 0 after the animation, with a 400 ms fallback in main |
| A card changes state (open → Recording, a problem line comes) | nothing; the problem line uses `arrive` | at once |
| Buttons and × | background 150 ms ease-out; pressed opacity 0.85 | the `.btn` rules |
| Reduced motion | nothing moves | the page's own reduced-motion block (kept) |

To leave with motion the page keeps the leaving card drawn until `animationend`, then reports its
height. `PromptWindow.sync` today hides the window as soon as the state has no cards: it waits for
that report instead.

### Both themes

- Light: `raised` card, 1 px `edge` (= `line` in light), the system shadow.
- Dark: `raised` (L 0.25), 1 px `edge` (a new, lighter dark value, T0) so the card has an edge over a
  dark call where the shadow cannot show; buttons' ghost hover reads `fill-raised` (T0), never `fill`.
- Every text pairing on `raised` is already pinned (`ink`, `ink-muted`, `ink-subtle`, `on-accent` on
  `accent`); T0 adds `ink` and `ink-muted` on `fill-raised`.

### Tests and checks (T1)

- `promptFormat.test.ts`: the overline per kind; "Meeting at 3:27 pm" for a blank title; hours in the
  "to" form across noon and midnight.
- `promptButtons.test.ts`: × is `dismiss` with the name Dismiss; one primary across two meetings and
  two cards.
- `PromptPanel.test.ts`: the problem line sits before the buttons; "Recording · <title>"; no text from
  a thrown error reaches the markup (feed it "xAI: rejected with HTTP 401").
- `PromptService.test.ts`: every `settleFailed` reason puts one of the lines above on the card, never
  `errorMessage(error)`; the newest card first.
- `PromptWindow.test.ts`: no `hide()` until the page reports 0 or 400 ms pass; `invalidateShadow()`
  after `setBounds`.
- QA (T10): the preview places the panel at its real spot (top right of a 1440 × 900 frame, under a
  menu bar strip, over a dark and a light call backdrop), every kind in both themes, `elementFromPoint`
  on × and on the primary.

## 4. The landscape window, navigation and Appearance (tasks T3 to T6)

### The window (T3, main)

- **Default 1080 × 730**, clamped to the work area less 48 px each way (a 1280 × 800 display), centred
  on the display under the cursor. **Minimum 420 × 520** stays: narrow still works.
- **It remembers its bounds** (position and size, per Mac) and restores them when they still fit a
  connected display, else the default. Nothing is saved today, so every Mac gets the landscape default
  on the next launch.
- **Title bar (D1):** `titleBarStyle: 'hiddenInset'`, traffic lights at `{ x: 16, y: 18 }` inside the
  52 px header row; the header is the drag region (`-webkit-app-region: drag`), its controls `no-drag`.
  One "Roger", one chrome row. Double-click on the empty header zooms, as macOS does.
- **`backgroundColor`** from the theme in force (the `canvas` values, written once in main with a
  pointer to `tokens.css`), so no white or black flash at show or resize.
- **`nativeTheme.themeSource`** follows the `theme` preference at launch and on every change: the prompt
  panel, menus, dialogs and scrollbars all follow Appearance (A1, P4, M4).
- **Window title** per page: "Roger", "Settings", "Set up Roger", the meeting's title.

### The page grid at every width (T4 shell, T5 meeting page, T6 Settings and Set up Roger)

| Window width | Gutter | Content |
| --- | --- | --- |
| 960 px and up (the landscape window) | 48 px | Home, Settings, Set up Roger: 880 px; the meeting page: 760 px |
| 720 to 959 | 32 px | Home and Settings 720 px; meeting page 760 px |
| under 720 | 16 px | full width |

- **Header (T4).** 52 px, full window width, a 1 px `line` under it (it marks the drag area). Left,
  after the traffic lights' 80 px: on Home the wordmark "Roger" as text (it goes nowhere on Home); on
  every other page **"‹ Home"**, a ghost `sm` button with `arrow-left` (in `components/ui/icons.tsx`
  already) and the word. Right: the recording chip (every
  page but the live meeting's own), Settings (ghost icon). On Settings the gear shows the selected look
  (`fill`, `ink`, `aria-current="page"`), not only a colour (V1, V2).
- **Home at 960 and up (D2).** Two columns in the 880 px content, top-aligned, 64 px apart: the left
  (1fr) holds the hero (overline, the 24 px title, hours, **Start notes** `lg`) and under it the
  calendar line or Connect with its helper; the right (360 px) holds Today, then Earlier (10, Show
  more), rows of a 88 px time column and the title, the row's action in a fixed right column on hover
  and focus. With no rows in either list the right column is absent and the hero stands alone at the
  left of the content, not centred. Under 960 it stacks as today.
- **Meeting page at 960 and up (T5).** The signed-off call holds: one column, one tab row. The column
  is 760 px, centred under the full-width header; the title block and its actions share a row (title
  left, actions right); the panes (My notes, AI notes, Transcript, Chat) span the column, so their
  right edge is the actions' right edge (R2); reading text stays at 68ch inside it. The reserved status
  band under the tabs goes: "Saved on this Mac" and "Not saved" move into the tab row's right end. The
  side space reads as a document's margins under a window-wide header. Primary actions keep their place
  when a busy state adds Cancel: Cancel sits to the LEFT of the primary (R3), all header buttons `sm`.
- **Details (T5).** The dialog's width stays 512 px. It always holds something: the stored facts of a
  past meeting (lines saved, uploaded, why it stopped) or the live sources; otherwise the button is
  absent (D3).
- **Settings at 720 and up (T6).** Section title (18 px), then rows of two columns: a 240 px label
  column (label 14/20 600, helper `ink-muted`) and the control column; sections divided by a hairline.
  Under 720 rows stack. Order, by what a person comes for: **Appearance**, **Calendar** (account,
  Remind me, the notice and its text), **Jargon list**, **Mac** (Open Roger at login, and a row "Check
  the microphone and call audio" with a secondary **Open Set up Roger**).
- **Set up Roger (T6).** The 880 px content, the rows at 640 px. With D6 it has the header and "‹ Home",
  and Later goes; Done stays the primary once all pass.
- **Loading and errors (T4).** Nothing for a read that answers in a frame; "Loading…" only where a
  network read takes seconds (unchanged). A render error in a page replaces only the page, under the
  header and banner: one problem line, "Roger could not show this page.", and **Reload** (secondary).
  The header, the recording chip and the banner stay, so Stop is one click away (W7).
- **Banner** lines align with the page column at every width (unchanged rule, new widths).

### Navigation and keyboard (T3 menu, T4 page)

| To | Mouse | Keyboard | App menu |
| --- | --- | --- | --- |
| Home | "‹ Home" in the header | Cmd+[ (everywhere), Escape on Settings and Set up Roger when focus is not in a text field | Go › Home, Cmd+[ |
| Settings | the gear | Cmd+, | Roger › Settings… (exists) |
| Set up Roger | Settings › Open Set up Roger | | Roger › Set up Roger… (exists) |
| Start notes | Home's button, the menu bar | Cmd+N | File › Start notes |
| Stop | the header's Stop, the menu bar | none: ending a recording is a click | File › Stop |
| The live meeting | the recording chip | | |

- Every page is one level under Home, so Back is Home: one menu item, no history stack.
- Escape never navigates on the meeting page: it would leave the notes mid-sentence.
- On navigation focus moves to the new page's `h1` (`tabindex="-1"`, no ring on programmatic focus).
- The shipped View menu keeps zoom and full screen and drops Reload, Force Reload and Developer Tools
  (a development build keeps them) (M5).

### Appearance (T6 renderer, T3 main)

- First section of Settings: **Appearance**, a segmented control **System · Light · Dark** (a
  `radiogroup` in the tab track's look: `fill` track, the chosen one on `control` with `e1`; arrow
  keys move and choose). It saves on change (`prefs:set` of `theme`), with no Save.
- Main applies it with `nativeTheme.themeSource` (T3), so the main window, the prompt panel and every
  native surface change together; the renderer's `data-theme` stays as it is.

## 5. Build split

Every task: its own worktree, a `set -e` gate script (`make check` and the desktop build), tests in
the same commit as the change, the session's attribution lines. A task edits only the files it owns
and may import from others. Waves run in order; tasks in a wave run in parallel. One reviewer per M
task, none on S. Renames of a shared symbol are named in the hand-off (root failure log).

| Task | Size | Owns |
| --- | --- | --- |
| **Wave 0, alone** | | |
| T0 Tokens, primitives, one clock | S | `theme/tokens.css` (new `fill-raised` and `edge`, both themes, both dark blocks), `theme/tokens.test.ts` (their pairings), `styles.css` (`.menu-item` hover and ghost hover on raised surfaces read `fill-raised`) and the copied `.btn` block in `prompt/prompt.css` in the same commit (`promptCss.test.ts`), `shared/clock.ts` (`meetingHours(startMs, endMs)`: "3:27 pm to 3:57 pm") + test |
| **Wave 1, parallel** | | |
| T1 Prompt panel | M | `renderer/src/prompt/*` (all), `main/prompt/PromptWindow.ts`, `promptBounds.ts`, `PromptService.ts` (+ their tests), `shared/calendar.ts` prompt card types and `shared/ipc/prompt.ts` (only if the "Recording" line needs the title), `preview/prompt.tsx`, `preview/prompt.html`, `preview/promptScenarios.ts` (+ a scenario per kind in section 3, a real-place stage) |
| T2 Capture words | M | new `main/capture/errorWords.ts` (+ test: every known failure's sentence holds no vendor, HTTP code, route, errno or internal word), `main/capture/CaptureService.ts` (`error` plain, new `errorDetail` raw), `main/capture/warnings.ts` (messages in the naming list; titles from shared), new `shared/captureWords.ts` (one headline per warning kind for the page and for notifications), `shared/capture.ts` (`errorDetail`, `AUDIO_SOURCE_LABEL` → "microphone", "call audio"), `main/capture/stopReasons.ts`, `main/lifecycle.ts` (the stop detail), `main/audio/system/TapSystemAudio.ts` (no "helper" in a message), `renderer/src/components/capture/captureProblems.ts` (reads `shared/captureWords.ts`), `components/capture/CaptureFacts.tsx` (shows `errorDetail` in Details), `preview/fakes/capture.ts` and every test double typed as `CaptureStatus` (the shared-type trap) |
| T3 Window, menus, appearance in main | M | `main/window.ts`, new `main/app/windowBounds.ts` (+ test), new `main/app/appearance.ts` (+ test: `themeSource` and `backgroundColor` per preference), `main/appMenu.ts` (+ test: File › Start notes Cmd+N and Stop; Go › Home Cmd+[; no Reload or Developer Tools in a packaged build), `main/index.ts` (wiring, `setAboutPanelOptions`, the fatal dialog's words), `main/notify/Notifier.ts` (a click opens the meeting), `main/navigation.ts` |
| T4 Shell, header, navigation, Home | M | `renderer/src/App.tsx`, `app/AppLayout.tsx` (page error boundary, focus on navigation, Escape, window title through main's existing route channel), `app/AppHeader.tsx`, `app/app.css`, `app/router.ts`, `app/HomePage.tsx`, `app/Earlier.tsx`, `app/SlotOutlet.tsx` (plain failure words), `app/labels.ts`, `calendar/TodaySection.tsx`, `calendar/NextMeetingCard.tsx` (hours from `meetingHours`), `calendar/ConnectCalendarCard.tsx`, `calendar/today.css` |
| T5 Meeting page | M | `meeting/MeetingHeader.tsx`, `meeting/MeetingPage.tsx`, `meeting/meeting.css`, `meeting/regions.tsx`, `notes/notes.css`, `notes/NoteEditor.tsx` (the save state in the tab row), `app/slots/m4-notes.ts` (placeholder), `transcript/transcript.css`, `transcript/transcriptNavigator.css`, `components/capture/StatusLine.tsx` (aria name, the full message on focus too), `components/capture/CaptureDetails.tsx` (never empty) |
| T6 Settings and Set up Roger | M | `app/SettingsPage.tsx`, `settings/*` (new `AppearanceSetting.tsx` + test), `calendar/CalendarSettings.tsx` (Disconnect confirms in place, no "No calendar connected."), `calendar/calendarSettings.css`, `calendar/calendarSettingsStore.ts`, `calendar/calendarFormat.ts` (the login-item line), `components/setup/*` (untested notifications fold; Later goes with D6), `app/SetupRoute.tsx` |
| T7 Native surfaces and their words | M | `main/app/trayMenu.ts`, `main/app/tray.ts`, `build/tray*Template.png` (+ the recording-with-warning glyph), `build/icon.icns` and `electron-builder.yml` (`icon`, the call audio permission string) after D3, `main/detect/CallOffer.ts` (the call-ended notification), `main/setup/PermissionService.ts` (the test notification, no "make native"), `main/setup/connectionChecks.ts` (plain row messages, raw text to the log) |
| T8 Calendar provider honesty | S | `apps/api/src/roger_api/config_calendar.py` (no default `fake`), `apps/api/src/roger_api/services/calendar/*` (connect answers `calendar_not_configured` when no provider is set), their tests, `.env.example`, `apps/api/README.md`, `docs/api-contract.md`, `apps/desktop/src/main/calendar/CalendarAccount.ts` (plain failure words), `main/calendar/oauthLoopback.ts` (the styled return page, its words) |
| T9 Errors outside capture | S | `renderer/src/app/describeError.ts` (+ test: the wrapped forms "Could not reach the Roger API to ... (...)" and "<vendor>: ..." become plain words), `notes/aiNotesActions.ts`, `notes/AiNotesPanel.tsx` (raw detail only in a closed "Details" disclosure), `chat/chatStream.ts` (an unknown code reads the generic line) |
| **Wave 2, after wave 1 merges** | | |
| T10 QA and close | M | `e2e/redesign.qa.e2e.ts` (1080 × 730 and 420 × 760, both themes; main's real warning and error words, never invented copy; Back, Escape, Cmd+[ and focus after navigation; Appearance switching both windows; the prompt panel at its real place in every kind; no raw text anywhere outside Details), `qa/driver.ts`, the preview scenarios it needs, the gallery, this plan's log |

Notes for the builders:

- T4 shows the header on Set up Roger and T6 removes Later: they land in the same merge, or Set up
  Roger has two exits or none (renderer failure log, R11).
- T2 changes `CaptureStatus`: grep `e2e/` and `preview/` first; `PromptService` reads `status.error`
  and gets the plain sentence with no change of its own.
- T1 changes `eventTitle`, which Home's rows import: Home's blank titles change with it (intended).
- T7 needs D3 for the icon; everything else in T7 runs without it.
- T8 is the only API task; its contract change goes in `docs/api-contract.md` in the same commit.

## 6. Decisions for Rahul (pick pre-filled)

- D1 Title bar: **the slim header moves into the title bar row (traffic lights inset), one "Roger"**. Else: keep the system title bar and drop the header's wordmark.
- D2 Home in the landscape window: **two columns, the next meeting and Start notes left, Today and Earlier right**; one column under 960 px. Else: one 720 px column, as today.
- D3 App icon: **the static burnt-orange dot on warm paper in the macOS rounded square, the menu bar glyph to match**. Else: commission an icon first; Roger ships Electron's until then.
- D4 Calendar on a server with no Google client: **Connect shows "Google Calendar is not set up on Roger's server yet" (disabled, the reason beside it); the fake provider only when a developer sets `CALENDAR_PROVIDER=fake`, and then the account reads "Demo calendar"**. Else: keep the fake as the default.
- D5 Copy notes: **add "Copy notes" to the more-actions menu (the AI notes as plain text, no chip times; "Notes copied")**. Else: copying stays select-and-copy in the editor.
- D6 Set up Roger: **the same header with "‹ Home" as every page; Later goes**. Else: keep no header and Later at the foot (R11).

Decided in this plan against `docs/design.md` (not for sign-off): Dismiss on a prompt card is an × at
the top right; the prompt panel's overline names Roger and uses Home's `startLabel`; hours read "3:27
pm to 3:57 pm" everywhere; Appearance is System · Light · Dark at the top of Settings and reaches
every window through `nativeTheme`; Back is Home (Cmd+[), Escape goes back only on Settings and Set up
Roger; the window remembers its bounds; Cancel sits left of the busy primary; the menu bar's
"Reconnect Google Calendar" keeps its full words.

## 7. The fake calendar in the installed app (F1)

What it is, read without changing anything in `~/Library/Application Support/Roger`:

- `config.json` points the installed app at a local Roger API, `http://127.0.0.1:8010`.
- That API runs the **fake calendar provider, which is the default**: `calendar_provider` defaults to
  `"fake"` (`apps/api/src/roger_api/config_calendar.py:44`, `.env.example:81`
  `CALENDAR_PROVIDER=fake`). Its sign-in sends the browser straight back with `code=fake` and grants
  `you@example.com` (`apps/api/src/roger_api/services/calendar/fake.py:1-33`), and its events are a
  script anchored to the API's start time ("Weekly sync", "Daily standup", "Client call (Zoom link in
  the location)", ...), so every API restart brings a fresh "call in 2 minutes".
- `calendar.sqlite` shows one connect, `you@example.com` at 2026-10-07 12:16 UTC (`connections_log`),
  7 events with keys `fake-...`, and 10 prompt-log rows: the fake "Weekly sync", "Daily standup" and
  "Client call" put up the prompt panel through the day (dismissed, expired), and one "Join and start
  notes" opened the fake Meet link `meet.google.com/abc-defg-hij` (`joined_and_started`, 2026-10-07
  12:16 UTC). A press of Connect Google Calendar against this API finishes in the browser in an instant
  and looks like nothing happened, which is why it reads as "never connected".
- It is not a desktop fixture leaking into the build (`preview/fakes/calendar.ts` holds the same names
  for the preview, but nothing in `src/main` imports it) and not an e2e run in the real folder (e2e
  mode uses a data folder of its own, `main/e2eMode.ts`).

The fix (T8, D4): the API has no calendar provider unless one is set, and Connect then says Google
Calendar is not set up on Roger's server yet; the fake runs only when a developer asks for it and its
account says so. For Rahul's Mac today: Settings › Disconnect clears the fake account and its copy; no
file in `~/Library` needs editing.

## Appendix A. Every path main's error text takes to the screen

From the sweep's trace (paths under `apps/desktop/src`). RAW: printed as is. DE: through
`describeError`, which rewrites only the API client's shapes and passes any other text through.

| Where it shows | Origin → carrier | Today | Owner |
| --- | --- | --- | --- |
| Banner, loud | STT connect "<vendor>: rejected with HTTP n" / socket text (`stt/core/SttConnection.ts:302`, `:311`) → `CaptureService.ts:871` → `CaptureStatus.error` | RAW | T2 |
| Banner, loud | STT token "POST /v1/stt/token failed: ..." (`api/http.ts:74-108`) → same | RAW | T2 |
| Banner, loud | two errors joined "...; and without the jargon list: ..." (`CaptureSession.ts:848-853`) | RAW | T2 |
| Banner, loud | adapter settings "xAI cannot be sent mulaw audio; ..." (`stt/xai/XaiSpeechToText.ts:87` and siblings) | RAW | T2 |
| Banner, loud | stream failure "Transcription of Me (me) stopped: <vendor reason>. ... in N s" (`CaptureService.ts:1241-1263`) | RAW, ticking | T2 |
| Banner, loud | local save "N lines could not be saved on this Mac: SQLITE_..." (`CaptureService.ts:837`) | RAW | T2 |
| Banner, loud | track ended "Mic (me) stopped: AbortError ..." (`CaptureService.ts:681`, `renderer/src/audio/sources.ts:42-57`) | RAW | T2 |
| Banner, loud | Stop failed (`CaptureService.ts:963`), configuration (`index.ts:221-224`) | RAW | T2 |
| Banner, loud | renderer start "Microphone: NotSupportedError: ..." (`state/useCapture.ts:122`) | RAW | T2 |
| Banner, loud | warnings "...the call audio helper quit (exit 1)..." (`capture/warnings.ts:109-116`, `audio/system/TapSystemAudio.ts:142-372`, `native/HelperProcess.ts`) | RAW | T2 |
| Banner, quiet | stop notice "(it kept crashing: crashed)" (`capture/stopReasons.ts:67`, `lifecycle.ts:151-174`) | RAW | T2 |
| Prompt panel | `settleFailed(..., errorMessage(error))` and `status.error` (`prompt/PromptService.ts:607`, `:615`, `:761`) | RAW | T1 |
| Prompt panel | "Could not read the prompt panel: <IPC text>" (`renderer/src/prompt/promptState.ts:37-38`) | RAW | T1 |
| Set up Roger | "Set STT_SAMPLE_RATE=16000...", "make native", server address (`setup/connectionChecks.ts:100-160`, `setup/PermissionService.ts:383-384`) | RAW | T7 |
| AI notes tab | the run's error detail (`renderer/src/notes/aiNotesActions.ts:202-208`) | RAW | T9 |
| Chat | an unknown code's message (`renderer/src/chat/chatStream.ts:151-152`) | RAW | T9 |
| Home, Settings | "Could not reach the Roger API to ... (POST /v1/... ECONNREFUSED)" (`calendar/CalendarAccount.ts:238`, `:345-358`; `calendar/oauthLoopback.ts:78`, `:108`) | DE, unchanged | T8, T9 |
| Any page | slot failure with slot and entry ids (`renderer/src/app/SlotOutlet.tsx:50`) | RAW | T4 |
| macOS notification | warning titles and bodies (`capture/warnings.ts:149-182`) | RAW | T2 |
| Details only (allowed) | source health and stream messages, upload `lastError`, the gap's `recoverError`, kept-audio errors, quiet warnings and notices | RAW, fine | |

## Tests

| What | Test |
| --- | --- |
| No internals in any sentence a person reads, for every known failure | `main/capture/errorWords.test.ts` (T2), `setup/connectionChecks.test.ts` (T7), `app/describeError.test.ts` (T9), `prompt/PromptPanel.test.ts` (T1) |
| One headline per warning, the same on the page and in the notification | `shared/captureWords.test.ts` (T2) |
| `fill-raised` and `edge` pairings, both themes | `theme/tokens.test.ts` (T0) |
| Hours in one form | `shared/clock.test.ts` (T0) |
| Window bounds restored only on a connected display; landscape default | `main/app/windowBounds.test.ts` (T3) |
| Appearance sets `themeSource` and the window background | `main/app/appearance.test.ts` (T3) |
| Menus: Start notes, Stop, Home, no Reload in a packaged build | `main/appMenu.test.ts` (T3) |
| A notification click opens its meeting | `main/notify/Notifier.test.ts` (T3) |
| Prompt panel kinds, words, order, exit before hide | T1's tests in section 3 |
| No `calendar_not_configured` connect succeeds; fake only when set | `apps/api/tests/test_calendar_*.py` (T8) |
| Every page in both themes at 1080 × 730 and 420, back and keyboard paths, the panel in place | `e2e/redesign.qa.e2e.ts` (T10) |

## Risks

| Risk | Signal | Response |
| --- | --- | --- |
| `hiddenInset` breaks dragging or a control under the traffic lights | a click in the header drags, or a button sits under the lights | the header's controls are `no-drag`; the left 80 px holds nothing; T10 checks `elementFromPoint` |
| The prompt panel's exit animation leaves a stale shadow or never hides | a ghost rectangle after Dismiss on a real Mac | `invalidateShadow()` after every change; main's 400 ms fallback hides anyway |
| T2's `CaptureStatus` change breaks fakes in files other tasks own | `tsc` on `tsconfig.e2e.json` red after the merge | T2 owns the capture fakes in wave 1; gate the merged branch alone |
| Plain words hide what an engineer needs | a bug report says only "Roger could not start notes" | the raw text stays in the log and in Details (`errorDetail`) |
