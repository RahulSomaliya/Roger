# Redesign: Roger in the Course Player style

**Phase:** after 2 · **Status:** signed off 2026-10-07 (all 8 calls as pre-filled) · **Owner:** Rahul ·
**Plan written:** 2026-10-07 · **Closed:** -

## Goal

Rahul: "we've made the entire app infinitely more complex." After this pass every screen shows
only what is essential, has at most one primary action, and follows `docs/design.md` (tokens,
type, space, motion, words). Nothing the house rules or `docs/spec.md` need is lost: the person
still sees when a call is not being saved, the loud warnings still come, the consent notice is
still on by default, every AI line still links to its transcript lines.

## Done when

- [ ] `docs/design.md` matches the code; zero literal colours; every pinned pairing AA in both themes.
- [ ] Each view has at most one primary button, the one the table in `docs/design.md` names.
- [ ] Everything in the removal list below is deleted (code, CSS and tests), not hidden.
- [ ] 12-hour times, one word per concept (the naming list is in `CLAUDE.md`), plain copy.
- [ ] `make check` green; one QA gallery (1440 and 390, light and dark, happy and failure path,
      realistic data) published.

## 1. Removal list

Each line: what goes, then why. "Away" is what moves one click away instead of disappearing.

### Home (`app/HomePage.tsx`, `app/Sidebar.tsx`, `app/RecentMeetings.tsx`, `calendar/`)

- `Sidebar.tsx` and its `.sidebar*` CSS: its "New note" is a second Start, and its three items fit a header and Home.
- `RecentMeetings.tsx`, `meeting/recentMeetings.css`: Home's "Earlier" list replaces it (titles and day, newest 10).
- The "Home" `<h1>`: it names nothing; the title bar already says Roger.
- The empty states "Take notes on your next call" (`HomePage.tsx`) and "Nothing on your calendar today" (`TodaySection.tsx`): Start notes says it.
- The live card "Recording now · Untitled meeting · Open" (`HomePage.tsx`): the hero shows the live meeting with Stop.
- The "NEXT · STARTING IN 2 MIN" card and its own Start notes (`NextMeetingCard.tsx`): that meeting becomes the hero's subject; one Start.
- All-day chips (`calendar-allday`, "Release week"): not meetings; nobody starts notes on one.
- Declined meetings (`calendar-declined`): you are not going.
- The guest line on rows ("Jane and Ali", `calendar-meta`): lists show titles.
- "Roger will open at login… Undo / Dismiss" (`OpenAtLoginLine`): said once in Connect's helper line; the switch stays in Settings.
- The Connect card's heading and paragraph (`ConnectCalendarCard.tsx`): one secondary button and one helper line.
- "Audio kept for a re-run" (`HomeKeptAudio`, `KeptForRerun`, the `home` mount in `slots/m2-capture-details.ts`): re-runs start on their own; a meeting with a gap says so on its own page.
- Away: past meetings beyond 10 ("Show more"); Settings (a ghost icon in the header).
- Stays: one Start notes, today's timed meetings (time + title, a ghost Start notes on hover), the live meeting with Stop, a calendar problem as one quiet line with Reconnect.

### Meeting page (`meeting/`, `components/capture/`, `notes/`, `chat/`, `transcript/`)

- The capture panel on the page (`StreamStatus` in `meetingCaptureStatus`): source rows, "Transcribing" pills, captured and connected times, devices, "Saved locally", "Postgres", the vendor line. Nobody acts on them mid-call; problems arrive as warnings.
- `LevelMeter.tsx` and its CSS: a bar moving twice a second is decoration; the loud no-audio warning is what says Roger can't hear.
- The "Recording" pill beside Stop (`meeting-phase` in `MeetingHeader.tsx`): the status line says it in words.
- Side-by-side panes, `PaneButtons` and the 720 px container query (`regions.tsx`, `meeting.css`): your notes are the page.
- The second tab row (`NotesTabs`): one tab row, My notes · AI notes · Transcript · Chat.
- "Synced" and its green dot (`saveStatus.ts`): saving is normal; only "Saved on this Mac" and "Not saved" show.
- AI notes' empty state "No AI notes yet / Generate notes" (`AiNotesPanel.tsx`): the header's Write notes is the action; the AI notes tab appears once notes exist or are being written.
- "Which kind of call was this?" and the template cards with descriptions and "Suggested" (`AskWhichCall`, `TemplatePicker.tsx`): see decision 6.
- Regenerate and Restore previous notes in the AI notes bar (`AiNotesBar`): into the ⋯ menu.
- The meta line "Client call template, 1 line to check" (`ai-notes-meta`): the menu names the template; a flagged line marks itself.
- The intro paragraph of Removed lines (`RemovedLines`): the closed "2 lines left out" stays.
- Chat's empty paragraph "Ask anything about this call…" and the filled Ask button (`MeetingChat.tsx`): the placeholder says it; Ask is ghost, Enter sends.
- "Listening. Lines appear here as people speak." (`LiveTranscript.tsx`): empty states are absent.
- The consent notice's tinted box, full text and filled button (`NoticeBanner.tsx`): one line, Copy notice (secondary), Dismiss (ghost); the text shows on hover and focus.
- The resumed notice's own Stop (`ResumedNotice.tsx`): the header's Stop is right there; the line stays.
- Away (one "Details" dialog from the header): source states and devices, saved and uploaded counts, speech-to-text time and cost (the owner's G7 meter), recoveries (`Notices.tsx`), the capture report (`CaptureReport.tsx`), echo lines and Unhide (`EchoLines.tsx`), audio kept and Delete audio (`AudioNote`).
- Stays: title, time line, one primary (Stop, then Write notes), the consent line while recording, loud warnings and save failures (house rule 1), the gap line ("2 parts were not transcribed · Transcribe again"), your notes at 68ch, citation chips.

### Settings (`app/SettingsPage.tsx`, `settings/`, `notes/NotesSettings.tsx`, `calendar/CalendarSettings.tsx`)

- The Notes section (`NotesSettings.tsx`, prefs `notes.autoGenerate` and `notes.whenUnsure`): decisions 5 and 6 leave nothing to set.
- The jargon list's Save button and its unsaved state (`VocabularySettings.tsx`, `vocabularyEditor.ts`): each add or remove saves at once.
- The limits helper and the "5 of 100 terms · 35 of 800 characters" counter: shown only near a limit.
- "Save notice" and "Use the default text" (`CalendarSettings.tsx`): the text saves on blur; "Use default" (ghost) shows only when the text differs.
- The long System Settings helper under "Open Roger at login": shown only when macOS asks for approval.
- The section cards: sections are space and a hairline.
- Stays: Calendar (account, Disconnect, Remind me, the notice switch and text, Open at login), Jargon list.

### Set up Roger (`components/setup/`)

- The two-paragraph intro (`setup-intro`): one line.
- Passing rows in the default view (This copy of Roger, Roger's server, Speech-to-text, any row that is fine): one line "4 checks pass · Show" (away, one click).
- Tinted status pills (`setup-state` tones): words with a ✓ or ! icon in `ink-muted`.
- "Done" while a check fails: the first failing check's fix is the primary; Done appears once all pass.
- The `audioRetentionDays` wording in the privacy line: one plain sentence.
- Stays: each failing check with what is wrong and its fix, the call audio test, Relaunch.

### Prompt panel (`prompt/`, `main/prompt/PromptService.ts`)

- Copy notice (`footerButtons`): decision 7.
- The stale-calendar card (`StaleCard`, and PromptService making it): Home says it.
- The second start button ("Take notes" beside "Join and take notes"): one primary, one ghost.
- "Stop current note and join / start": the label stays Start notes; one helper line "Stops notes on Weekly sync".
- The guest line on the card: when, title and time are enough.
- Stays: the meeting card, the call-detected card, Dismiss (ghost), "Taking notes · Open Roger".

### Banners and warnings (`app/BannerSlot.tsx`, `components/capture/WarningBanner.tsx`, `calendar/CalendarStatusBanner.tsx`)

- Red and amber boxes (`.error`, `.notice`, `capture-warning` backgrounds): problem lines, ink and an icon (decision 4).
- Quiet capture warnings in the band (`loud: false`, "Call audio is silent… normal in a pause"): into Details.
- The theme-preference error (`themeError`): the page follows macOS anyway; it goes to the log.
- `CalendarStatusBanner.tsx` above every page: one quiet line in Home's Today.
- The "Call audio (them) since 4:59 PM" heading row: folded into the line, the time in `ink-subtle`.
- Stays: the capture error (lines not saved on this Mac included), the stop notice, loud warnings, the setup-check failure, and a new line when the server refused lines for good (`upload.rejected`, Traps).

### Tray menu (`main/app/trayMenu.ts`)

- "Calendar not updated": Home says it; Reconnect stays when Google refused.
- Renamed: "Start notes now" → Start notes, "Stop note" → Stop, tooltip "Roger: taking notes" → "Roger: recording".
- Stays: the next meeting, Start notes or Stop, Open Roger, Quit Roger.

## 2. Calls to sign off (pick pre-filled)

Signed off by Rahul on 2026-10-07: "OK on the redesign calls". All eight stand as written below.

1. Sidebar: **delete it**; a slim header (recording chip, Settings icon) and Home's "Earlier" list replace it. (Else: keep a sidebar of recent meetings only.)
2. Meeting page: **one column at every width, one tab row My notes · AI notes · Transcript · Chat.** (Else: the transcript as a side column above 1280 px.)
3. Capture status and level meters: **off the page; one Details dialog from the header** holds sources, uploads, the cost meter, recoveries, the report, echo lines and audio. (Else: a closed disclosure on the page.)
4. Colour for problems: **no red; ink text, an icon, the alert role, top position and the macOS notification**; Stop is the accent fill. (Else: one danger hue for loud capture warnings only.)
5. Auto-write after Stop: **off and the setting deleted**; Write notes is the one primary after Stop. (Else: keep auto-write; the primary reads "Writing notes…".)
6. "Which kind of call was this?" and its setting: **deleted**; Roger writes with its best guess (General when unsure) and "Write again as" in the ⋯ menu changes it.
7. Prompt panel: **drop Copy notice and the stale-calendar card**; one primary, Join and start notes (with a video link) or Start notes.
8. Icons: **about 10 Lucide icons as inline SVG in one file (ISC licence), no new package.** (Else: add `lucide-react`.)

## 3. Build split

Every task: its own worktree and test database, a `set -e` gate script
(`make check` + `pnpm --filter @roger/desktop build`), removing first, tests in the same commit.
A task edits only the files it owns; it may import from others. Waves run in order; tasks in a
wave run in parallel. One reviewer per M task, none on S. No screenshots until R10.

| Task | Size | Owns |
| --- | --- | --- |
| **Wave A, one at a time** | | |
| R0a Tokens | M | `theme/tokens.css` (OKLCH, both themes), `theme/tokens.test.ts` (OKLCH reader, the pinned pairings table, new token list), new `theme/tokenReads.test.ts` (every `var(--x)` is defined), the mechanical `var()` rename in every renderer `.css`, and the split of `calendar/calendar.css` into `today.css`, `calendarSettings.css`, `calendarNotice.css` |
| R0b Primitives | M | `styles.css` (type, space, radius, motion, reduced motion, focus, selection, `.btn`, problem line, tabs, menu, dialog, chip), `app/app.css` generic rules moved to `styles.css`, new `components/ui/` (`icons.tsx`, `Menu.tsx`, `Dialog.tsx`, `Tabs.tsx`), new `clock.ts` + test, the mechanical switch of every button class to `.btn` variants in all `.tsx` and their tests |
| **Wave B, parallel** | | |
| R1 Shell and Home | M | `app/AppLayout.tsx`, `app/Sidebar.tsx` (delete), `app/RecentMeetings.tsx` (delete), new `app/AppHeader.tsx`, new `app/Earlier.tsx`, `app/HomePage.tsx`, `app/app.css`, `app/labels.ts`, `app/ShellContext.tsx`, `app/router.ts`, `meeting/recentMeetings.css` (delete), `meeting/recentMeetingsKey.ts`, `calendar/TodaySection.tsx`, `NextMeetingCard.tsx`, `ConnectCalendarCard.tsx`, `todayGroups.ts`, `calendarFormat.ts`, `startRequest.ts`, `today.css` |
| R2 Meeting page frame | M | `meeting/MeetingPage.tsx`, `MeetingHeader.tsx`, `regions.tsx`, `panes.ts`, `meeting.css`, `meetingTimes.ts`, `liveMeeting.ts`, `useMeeting.ts`, `app/slotRegistry.ts`, `app/SlotOutlet.tsx`. Places the outlets: `meetingCaptureStatus` in the header's status line, `meetingAudioNote` and `meetingBanner` under the header, `meetingCaptureReport` inside its Details dialog. Calls Write notes through `notes/aiNotesActions.ts`'s existing exports (R4 keeps their names and signatures) |
| R6 Settings | S | `app/SettingsPage.tsx`, `settings/*`, `calendar/CalendarSettings.tsx`, `calendarSettingsStore.ts`, `calendarSettings.css` |
| R7 Set up Roger | S | `components/setup/*`, `app/SetupRoute.tsx`, `app/slots/m2-setup.ts` |
| R8 Prompt panel | S | `prompt/*`, `main/prompt/PromptService.ts`, `shared/calendar.ts` prompt card types, `shared/ipc/prompt.ts`, `preview/fakeRoger.ts` (this wave only) |
| R9 Notice, tray and main's words | S | `calendar/NoticeBanner.tsx`, `calendar/CalendarStatusBanner.tsx` (delete), `calendarNotice.css`, `app/slots/m5-calendar.ts`, `main/app/trayMenu.ts`, `main/capture/stopReasons.ts`, the message and `defaultMeetingTitle` in `main/capture/CaptureService.ts`, `main/detect/CallOffer.ts`, `shared/suggestTemplate.ts` (reads old and new titles) |
| **Wave C, parallel, after R2 merges** | | |
| R3 Capture details and banners | M | `components/capture/*` (`LevelMeter.tsx` deleted), `format.ts`, `app/BannerSlot.tsx`, `app/slots/m2-capture-status.ts`, `app/slots/m2-capture-details.ts`. The status line, the Details content, the gap line, the `upload.rejected` problem line (test first) |
| R4 Notes and AI notes | M | `notes/*` (`NotesSettings.tsx`, `TemplatePicker.tsx` deleted), `app/slots/m4-notes.ts`, `shared/preferences.ts` (the two notes keys), `main/notes/NotesGenerator.ts`, `preview/fakeRoger.ts` (this wave only) |
| R5 Transcript and chat | M | `transcript/*`, `chat/*`, `app/slots/m3-transcript.ts` |
| **Wave D** | | |
| R10 QA, words, close | M | new `e2e/redesign.qa.e2e.ts` (asserts at most one visible primary per view, `elementFromPoint` on it), the obsolete `e2e/*.qa.e2e.ts` it replaces, preview scenarios it needs, the gallery, the naming list into `CLAUDE.md`, new traps into `docs/design.md` |

## Tests

| What | Test |
| --- | --- |
| Every pinned pairing at AA, both themes; dark blocks identical; no fill as text | `theme/tokens.test.ts` |
| No literal colour anywhere in the renderer | `theme/noLiteralColours.test.ts` (unchanged) |
| Every `var(--x)` read is a defined token | `theme/tokenReads.test.ts` |
| 12-hour lowercase times, zone switch inside the test | `clock.test.ts` |
| A refused upload shows a problem line | `components/capture/*.test.ts` (R3) |
| Add or remove a term saves at once | `settings/vocabularyEditor.test.ts` |
| Stop writes no notes by itself; no "which kind" question | `main/notes/NotesGenerator.test.ts` |
| No stale card, no Copy notice in the prompt | `main/prompt/PromptService.test.ts`, `prompt/promptButtons.test.ts` |
| Old and new default titles both match a template memory | `shared/suggestTemplate.test.ts` |
| One primary per view, both themes, 1440 and 390 | `e2e/redesign.qa.e2e.ts` |

## Risks

| Risk | Signal | Response |
| --- | --- | --- |
| A removal hides a call that is not being saved | a failure scenario in the preview shows no problem line | R10 shoots offline, save failed and refused-upload states; house rule 1 wins |
| Wave B and C tasks break each other after merging | merged `make check` red | integration branch, gate run alone after each wave |
| A renamed shared type breaks the preview fake | `tsc` on `tsconfig.e2e.json` | `preview/fakeRoger.ts` has one owner per wave |
