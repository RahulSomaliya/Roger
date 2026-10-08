# M5. Calendar

**Phase:** 2 · **Status:** draft · **Owner:** Rahul · **Plan written:** 2026-10-06 · **Closed:** -

2026-10-08: Rahul removed the call notice end to end. Wherever this plan says "notice" (the Copy notice
button, the meeting page line, `notice.enabled`, `notice.text`, D3), read it as removed, not as a
requirement; Roger keeps the calendar reminder and nothing for the other people on the call.

## Goal

Roger knows the user's day. After one Google Calendar sign-in, the home screen lists today's
meetings, a small prompt appears a minute before each call, and one click starts a note whose title
and attendees come from the invite.

## Done when

- [ ] 20 calls in a row are started from the notification.

  **Before the streak starts**, M2's capture fixes are in the installed `/Applications/Roger.app`:
  M2-T1 (permission grants survive a relaunch), M2-T7, M2-T9 and M2-T10 (call audio through the
  signed `roger-audio` helper), M2-T19 (permission setup screen, every row green). With open at
  login, every reboot means a fresh launch before the next call, and the 2026-10-06 field report
  (mic asked on every launch, no call audio after a restart) would put a permission dialog on the
  first click or record calls with no "Them".

  Setup: finish "Owner setup: Google Cloud" below; in `.env` set `CALENDAR_PROVIDER=google`, the
  Google values and `CALENDAR_TOKEN_KEY`; `make dev-db && make migrate && make dev-api`;
  `make install-desktop`; open Roger, Connect Google Calendar, and check Settings shows "Open at
  login: On" and no "Calendar not updated" warning. Postgres restarts with Docker; the API does not,
  so run `make dev-api` after every reboot (the menu bar says "Calendar not updated since …" an hour
  after it stops). From then on, with Granola closed, start every calendar call only from the prompt.

  Roger logs every prompt-worthy event in `calendar.sqlite` → `prompts`, prompted or not, and
  Disconnect never clears it. A call that got no prompt gets a `missed` row with its reason
  (`disconnected`, `not_running`, `api_stale`, `policy`). An event that was not a call that took
  place (no-show, cancelled in the room) is marked by hand, and the line goes in the log below:
  `UPDATE prompts SET excluded_reason = '<why>' WHERE key = '<key>';`. Then:

  ```sh
  sqlite3 ~/Library/Application\ Support/Roger/calendar.sqlite < apps/desktop/scripts/calendar-streak.sql
  ```

  prints `streak` of at least 20 and `since`, the first call of the streak. Only `started` and
  `joined_and_started` count; `started_degraded`, `start_failed`, `dismissed`, `expired` and
  `missed` each restart it. Then check those meetings in Postgres:

  ```sql
  -- docker compose exec db psql -U postgres roger
  SELECT m.started_at, m.title, m.start_source,
         count(s.id) FILTER (WHERE s.source = 'mic')    AS me_lines,
         count(s.id) FILTER (WHERE s.source = 'system') AS them_lines
  FROM meetings m LEFT JOIN transcript_segments s ON s.meeting_id = m.id
  WHERE m.calendar_event_id IS NOT NULL AND m.calendar_provider = 'google'
    AND m.started_at >= '<since>'
  GROUP BY m.id ORDER BY m.started_at;
  ```

  Every row reads `notification`, with `me_lines` and `them_lines` both above 0.
  `calendar_provider = 'google'` keeps meetings made with the fake provider in the same dev
  database out of the count.
- [ ] Real-Mac checks on the installed build, once each, logged below:
  1. Login item (gates T11's default-on): connect, reboot. `getLoginItemSettings()` (logged at
     startup) reports `status: enabled` and `wasOpenedAtLogin: true`; Roger is in the menu bar with
     no window.
  2. Reboot → login launch → prompt → one click: both streams produce lines and no system
     permission dialog appears.
  3. Take notes over a full-screen Meet: the Meet Space stays in front, typing still lands in Meet,
     the menu bar icon shows recording.
  4. Main window hidden for at least 1 hour: the next prompt appears within 15 s of start minus
     the lead time.
  5. Closing the window mid-call keeps lines arriving for 2 minutes.
  6. `make dev-desktop` while Roger.app runs: both start, each with its own data folder.
- [ ] Real-key checks, once: (a) Disconnect in Settings, then Google Account → Security → Your
  connections to third-party apps no longer lists Roger, and `calendar-streak.sql` prints the same
  streak as before. (b) Connect, then remove Roger's access on that Google page: within 5 minutes
  Home shows "Reconnect Google Calendar" and the API log shows `calendar_reconnect_required`.
  (c) Connect again works. Run them between calls.
- [x] `make check` green, including the end-to-end test with the fake calendar
  (`apps/desktop/src/main/calendar/calendarFlow.test.ts`): fake event → prompt → one click → local
  meeting with title, attendees and `start_source = notification` → uploader create payload.

The 20-call check takes as many working days as it takes to hold 20 calls. Code can land in a day;
the milestone closes when the streak is logged. It runs alongside Gate 2.

## In scope

- Google Calendar sign-in from the desktop: system browser, loopback redirect, PKCE. The API
  exchanges the code and keeps the refresh token, encrypted.
- Primary calendar, read only, events from 36 hours ago to 36 hours ahead, refreshed every 5
  minutes and on wake; the desktop keeps the last answer locally and says loudly when it is stale.
- Home "Today" section: today's meetings, the next meeting, Start notes per meeting, a connect card.
- A prompt panel just before each call: title, time, attendees, Take notes, Join and take notes,
  Copy notice, Dismiss. The same panel shows M2's "call detected" offer (D5).
- ~~Notice to others on by default, with an editable message copied in one click.~~ Removed 2026-10-08.
- Each meeting started for an event stores its title, attendee list, event ids, scheduled times
  and how it was started (`start_source`) in Postgres.
- A durable prompt log: every prompt-worthy event and its outcome, including missed ones.
- Roger keeps running: closing the window hides it, a menu bar item, launch at login, and a dev
  build that never collides with the installed app.
- A fake calendar provider so every screen and test runs with no Google client.
- A Calendar section in Settings: account, reminder lead time, open at login (the notice on/off and text were removed 2026-10-08).
- The requirements for SHELL-0 (preferences store, `app:navigate`), built by M4-S2 and M4-S1 (D4).

## Out of scope

- Calendars other than primary; Outlook and Apple calendars. Not on the roadmap yet.
- Push from Google (`events.watch`): needs a public HTTPS URL. Revisit after M6 deploys the API.
- Google sign-in as the Roger login and per-user tokens: M6, reusing this OAuth client and token store.
- Posting the notice into the Meet chat automatically: M9 (Chrome extension).
- Speaker names from attendees: M9. Attendees in MCP output and filtering meetings by person: M7.
- Admin-locked notice settings, recording whether the notice was sent: M11.
- Detecting a call from mic use, stopping by itself at the end of a call: M2 (it feeds M5's panel).
- The app shell (sidebar, routes, Home frame, meeting page, Settings page): M4-S1 to M4-S4b (D4).
  M5 mounts its screens into it (T13) and builds none of it.
- A LaunchAgent that keeps the API up: the API moves to the cloud in M6.
- A polished "listening" light, notarized build: M11.

## Design

| Decision | Choice | Alternative | Why |
| --- | --- | --- | --- |
| Where the Google refresh token lives | The API, in Postgres, encrypted. The desktop runs the browser step and hands the API the one-time code and PKCE verifier; it never sees a Google token. | Desktop main process, Electron `safeStorage` (Keychain) | House rule 3: the desktop only ever holds the Roger API token. M6 brings Google sign-in and the cloud on the same OAuth client, so sign-in can add the calendar scope later (`include_granted_scopes`) into the same store; one sign-in then serves every Mac and the web page; revoking on sign-out happens in one place; Google push becomes possible once the API is public. **Phase 2 cost:** the calendar stays fresh only while the local API and Postgres run, and nothing starts the API at login. Postgres gets `restart: unless-stopped`; prompts keep coming from the local copy for up to 36 h; after 1 h with no successful refresh the menu bar, the panel and Home say "Calendar not updated since …" (T7, T9b, T11, T12). **Owner decision D1.** |
| Token encryption | Postgres `pgcrypto`: `pgp_sym_encrypt(token, CALENDAR_TOKEN_KEY)`; the key lives only in API settings. The engine is created with `hide_parameters=True`. | `cryptography` (Fernet) in Python | `cryptography` is in `uv.lock` only as a dependency of `pyjwt`; declaring it needs a re-lock, which fails under the machine's uv `exclude-newer` pin (C2). pgcrypto ships with Postgres, is a trusted extension since 13, and is in `postgres:16-alpine` and every managed Postgres we would pick in M6. The token and the key are bind parameters, and any `DBAPIError` (unique violation, dropped connection, missing extension) renders `[parameters: (...)]` into the text that `middleware.py` logs with `logger.exception`; `hide_parameters` stops that. Postgres 16 logs no bind values on error by default (`log_parameter_max_length_on_error = 0`). |
| OAuth flow | Authorization code + PKCE (S256). Redirect to `http://127.0.0.1:<random port>/oauth/callback`, a one-request server in desktop main; the URL opens in the default browser with `shell.openExternal`. | Login inside a BrowserWindow; a custom URL scheme | Google refuses sign-in in embedded webviews, no longer supports custom URI schemes for desktop apps, and names the loopback IP as the method for macOS. `127.0.0.1`, not `localhost`: Google warns that `localhost` trips some firewalls. ([Google, OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)) Flow shape from openwhispr `src/helpers/oauthLoopbackFlow.js` (MIT). |
| OAuth client | Google "Desktop app" client; id and secret in API settings; the secret goes to the token endpoint | "Web application" client | A Desktop client accepts any loopback port. Google still requires the secret at the token endpoint for this client type and says installed apps cannot keep it, so it is configuration, not a security boundary. It stays on the API all the same. |
| Scopes | `openid email https://www.googleapis.com/auth/calendar.events.readonly` | `calendar.readonly`; `calendar.events.owned.readonly` | The narrowest documented scope that reads invites on the primary calendar. `calendar.readonly` reads every calendar the user can see, not only events. `events.owned.readonly` is narrower but it is not proven to include events other people invited you to; revisit when the app goes for Google verification (M11). `email` names the account in Settings and comes in the ID token. |
| ID token | Read `email` from the payload with stdlib `base64` and `json` only, without verifying the signature. A ruff `banned-api` rule refuses `jwt` and `cryptography` anywhere in the API. | Verify with Google's keys; `import jwt` | The API receives it straight from Google's token endpoint over TLS while authenticating with the client secret, which Google says is enough ([Google, OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)). `pyjwt` and `cryptography` are installed only because `mcp` pulls in `pyjwt[crypto]` (`uv.lock`); importing them adds an undeclared dependency (C2) that breaks silently if `mcp` drops it. `TID` is already selected in ruff, so the ban costs one config block. |
| Consent screen audience | **Owner decision 2026-10-06: External, open to any Google account, not limited to linkt.ai.** Start in publishing status Testing (`GOOGLE_OAUTH_AUDIENCE=external_testing`: up to 100 test users, refresh tokens expire after 7 days, warned from day 6); move to In production (`external_production`) once Google verifies the app for the sensitive calendar scope (privacy policy, homepage, domain, demo video; owner task, M11 at the latest). Until verified, In production shows "Google hasn't verified this app" and caps new users at 100. `internal` stays a valid value. | External, publishing status Testing, test users | Internal needs no test users and no Google review for sensitive scopes, and its refresh tokens do not expire on a timer. External in Testing issues refresh tokens that expire after 7 days ([Google, refresh token expiration](https://developers.google.com/identity/protocols/oauth2)). Internal needs the right to create a project under linkt.ai and a linkt.ai calendar; when either fails, `GOOGLE_OAUTH_AUDIENCE=external_testing` makes the API return `expires_hint = connected_at + 7 days`, and from day 6 the menu bar and Home say "Reconnect Google Calendar before <date>". **Owner decision D2.** |
| Polling or push | The desktop asks the API every 5 min, on wake, on window focus (at most every 30 s), right after connect, and before showing a prompt when its copy is older than 2 min. At launch, one catch-up fetch from the previous run's last tick (at most 6 days back, below the API's 7-day limit) feeds the missed-prompt log only. The API calls Google live: `events.list` on `primary` with `singleEvents=true`, `orderBy=startTime`, `eventTypes=default`, `maxAttendees=100`, following `nextPageToken`. Failures back off x2 up to 30 min. | `events.watch` push channels; `syncToken` incremental sync | Push needs a public HTTPS URL with a valid certificate and sends no event data anyway, only a "go fetch" signal ([Google, push](https://developers.google.com/workspace/calendar/api/guides/push)). The API is on 127.0.0.1 until M6. A three-day window is one small request; a sync token adds state for nothing. Interval and backoff from openwhispr `calendarSyncInterval.js` and `googleCalendarManager.js`. |
| Where events are kept | Not on the API. The API normalises and returns them; the desktop keeps the last good answer in its own `calendar.sqlite` | An events table on the API synced from Google | Prompts must fire with the API down or the Mac offline (house rule 1 in spirit). Nothing in M5 queries events on the server; M7 adds a table when MCP needs one. |
| Time zones and the window | The API returns timed events as UTC instants (Google's offsets resolved) and all-day events as plain dates (`start_date`, `end_date`, end exclusive). Prompts run on instants. "Today" is grouped by local date in the renderer. Main fetches now − 36 h to now + 36 h. | Main computes "today"; now − 12 h to now + 36 h | Instants make prompt timing safe across DST and travel. The renderer follows a macOS time zone change; main may keep the zone it started in, so main never decides what "today" is, and fetches wide enough that today in any zone is inside the window (at 23:30 IST the 10:00 standup is 13.5 h back). openwhispr pads its window by 48 h for this reason (`googleCalendarManager.js` `ALL_DAY_TIMEZONE_PADDING_MS`). anarlog `crates/calendar/src/convert.rs` turns all-day dates into midnight UTC, which moves them a day back west of UTC: not copied. |
| Which events get a prompt | Timed, not cancelled (never returned), self response not `declined`, and evidence of a call: another attendee, `attendees_omitted`, or a video link someone typed into the location or description. A conference-data link alone (`hangoutLink`, entry points) is not evidence. Tentative and unanswered still prompt. `eventTypes=default` already drops focus time, out of office, working location, birthdays and Gmail items. | Another attendee or any video link | A solo block is not a call: openwhispr `calendarReminderScheduler.js` `isReminderEligible`. Many Workspace orgs add a Meet link to every new event, so "any video link" prompts for solo Focus and Lunch blocks; auto-add only writes conference data, never the location or description, so a typed Zoom link on a solo block still prompts. A declined call is not attended. |
| Video link | The API's `normalize.py` takes `video_link` from the first allowlisted URL in the location, then the description, then `hangoutLink`, then video entry points, and records where it came from (`video_link_source`; `conference` means nothing was typed). Typed links come first because Workspace auto-adds a Meet link: conference-first would hide a Zoom link pasted into a solo block (no prompt, since only a typed source is evidence) and make Join open the empty Meet room (M5-T2). The host allowlist exists twice, `services/calendar/video_links.py` and the desktop's `src/shared/meetingLinks.ts`, each pointing at the other, and the desktop re-checks before opening. | Conference data only | Zoom and Teams invites often carry the link only in the location or description; openwhispr does `extractMeetingUrl([location, description])` (`googleCalendarManager.js`, `meetingJoinUrl.js`). |
| Recurring events | Expanded by Google (`singleEvents=true`); each instance has its own id. Prompt key is `<event id>@<start instant>`. | One prompt per series | A moved instance prompts at its new time and a deleted one never does. Key shape from anarlog `apps/desktop/src/services/event-notification/index.ts`. |
| The prompt | Roger's own small panel: a BrowserWindow with `type: 'panel'`, `focusable: false`, `acceptFirstMouse: true`, shown with `showInactive()`, always on top at level `screen-saver`, on all spaces including full-screen ones, top right of the display under the cursor | Electron `Notification` (Notification Center) | Electron's macOS notifications use UNNotification, which needs a signed app, can be silenced by Focus, and in the default banner style shows its buttons only on hover; there is no room for attendees or the notice. anarlog (`crates/notification-macos`, an NSPanel) and openwhispr (`windowConfig.js` `NOTIFICATION_WINDOW_CONFIG`) both use their own panel. `acceptFirstMouse` makes the first click press the button: one click, not two. The panel never takes focus from the call. |
| When the prompt shows | From 1 minute before start (setting: 0, 1, 2, 5 or 10) until start + 10 min, Dismiss, or an action. A 10 s tick reads the local copy; waking from sleep ticks at once. From 2 min before the next due prompt until it shows, the scheduler holds `powerSaveBlocker.start('prevent-app-suspension')`. Every prompt-worthy event gets a `prompts` row: shown, its outcome, or `missed` with a reason. | One `setTimeout` per meeting (openwhispr) | A tick over a small local list survives sleep, clock changes and zone changes with no timer bookkeeping (anarlog ticks every 30 s). With the window hidden, App Nap may coalesce a background app's timers, so a 1-minute lead could become "Started 2 min ago"; the blocker covers only the minutes that matter. A restart never shows a prompt twice. Waking 4 minutes into a call still offers "Started 4 min ago". |
| Prompt log | `prompts` rows are keyed by account and event key and never deleted; Disconnect clears only `events` and `fetch_state`. Each tick and at launch, an event after the account's first connect whose start + 10 min has passed with no row gets `missed` with the first matching reason: `disconnected` (no connection then), `not_running` (no Roger run covered start − lead), `api_stale` (the event first reached the cache after start − lead), `policy` (Roger ran with the event cached and still showed nothing; `detail` names the rule). A click is logged `starting`, then `started` or `joined_and_started` once both sources deliver audio and both speech streams are open, within 20 s; otherwise `started_degraded` with the source, or `start_failed`. At launch, a `starting` row left by a crash becomes `start_failed` and every card left unanswered becomes `expired` (a restart never shows a card twice, so nothing else would settle one still in its window), both with reason `app_exit`. After a launch or a wake, `missed` rows from the local copy wait until that stretch's refresh has settled, so a call cancelled meanwhile gets no row; a failed refresh falls back to the copy with a warning (T9a, as built). The streak is one query, `apps/desktop/scripts/calendar-streak.sql`, which its test also runs. | Clear the log on Disconnect; log only shown prompts; log `started` when `CaptureService.start` resolves | The exit check needs durable, honest evidence. The events cache is replaced on every poll, so a call with no prompt left no trace. M1's `start` resolves with a dead "Them" stream. M2's silence warnings are not used for the outcome: before the others join, call audio is legitimately silent. The Postgres check (lines from both sources) covers a stream that delivers only zeros. |
| One click starts the note | The prompt tells main; main logs the action, sends `app:navigate` to the meeting route and hands the renderer a start request; the renderer runs its normal start path. A prompt action never calls `show()` or `focus()`. If the window is hidden it is ordered in with `showInactive()`; if real-Mac check 3 shows that still pulls the Space away from a full-screen call, the window stays hidden and the panel shows "Taking notes · Open Roger" for 5 s. The menu bar icon shows recording either way. While a note is recording, the button reads "Stop current note and start". "Join and take notes" also opens the event's Meet, Zoom or Teams link (host allowlist), then starts. A request waits in main up to 60 s for a window that is still loading. | Show the main window on the meeting page; main starts capture by itself | `show()` activates Roger: over a full-screen Meet macOS switches Spaces away from the call, and after "Join" it covers the tab that just opened, undoing the panel's `focusable: false`. Audio capture lives in the renderer (`useCapture` → `AudioCaptureController`), so the renderer must run it. Join links are opened only for known hosts: openwhispr `meetingJoinUrl.js`. |
| Roger keeps running | Closing the window hides it; the renderer and any recording keep running (`backgroundThrottling: false`). Roger lives in the menu bar; Cmd+Q or the menu's Quit ends it. Open at login turns on when the calendar first connects (packaged builds only, once real-Mac check 1 passes), with a toggle in Settings. A login launch is detected with `app.getLoginItemSettings().wasOpenedAtLogin` and starts with the window hidden; when that reads false the window shows, which is only cosmetic. A dev build sets `userData` to "Roger Dev" before `requestSingleInstanceLock`. | Quit when the last window closes (today); `openAsHidden` | A prompt needs a running app, and today closing the window quits and ends a recording (the landed cost guard G4 stops it on the window's `close`; T11 moves that stop to a real close). `openAsHidden` does nothing on macOS 13+ and is gone from Electron 44's `Settings` type; openwhispr `autoStartPolicy.js` reads `wasOpenedAtLogin` for the same reason. macOS 13+ registers login items through SMAppService, and registration from a build signed without an Apple team id is unverified here, hence check 1. A login item can wait for approval: Settings shows `requires-approval` with the path System Settings → General → Login Items & Extensions (macOS 15+). `productName` is "Roger" in dev and packaged builds, so both used the same `userData` and the same single-instance lock (Electron keys it on `userData`): with Roger.app always in the menu bar, `make dev-desktop` would quit at once, and two copies would share `roger.sqlite` and `calendar.sqlite`. A dev build must never register Electron.app as a login item. |
| Linking a meeting to its event | The meeting create carries `start_source` and an optional `calendar_event` (event id, iCal UID, recurring event id, scheduled start and end, attendees). The API stores the ids on `meetings` and attendees in `meeting_attendees`. `start_source` includes `call_detected` for M2. | A JSON snapshot column; linking after the fact | One create keeps idempotency simple (house rule 7). A table lets M7 and M8 filter by person and M9 attach a speaker name per attendee. The iCal UID is the same for every invitee, so from M6 two teammates' notes of one call can be matched. `start_source` turns the exit check into a query. M5 owns the `meetings` column and its check constraint, so M2's value lands in the same migration rather than a second one. |
| Manual start near a meeting | A start from Home "New note", the menu bar or a call-detected card links to an event only when exactly one prompt-worthy event is running or starts within 5 min. Applied by a `StartRequestEnricher` that T9c injects into `CaptureService.start`. | Never link a manual start | Title and attendees still come from the invite when the prompt was missed. Two overlapping calls link nothing rather than the wrong one. `CaptureService` cannot see the calendar cache, so the rule reaches it through one injected port. |
| Notice to others | **Removed 2026-10-08.** On by default. The prompt has "Copy notice"; the meeting page shows a banner with the same button until copied or dismissed. The text is a setting. Copy goes through Electron `clipboard` in main, which works from the unfocused panel. | Post it into the Meet chat for the user | The roadmap asks M5 for a reminder and a one-click message; posting into Meet is M9's extension. **Owner decision D3** for the wording. |
| Fake provider | `CALENDAR_PROVIDER=fake` (the default). Its authorization URL is the desktop's own redirect with `code=fake`, so the whole browser round trip runs with no Google. Its events are anchored to the API's start time (stable between polls): a call 2 min after start with three attendees and a Meet link, an all-day item, a declined call, a solo block with an auto-added Meet link, a solo block with a Zoom link in the location, a moved recurring instance, one tomorrow. `FAKE_CALENDAR_FILE` replaces them with a JSON file. | Mocks in tests only | C4: build, QA and demo every screen with no Google client. Restart the API for a fresh "call in 2 minutes". |
| Who owns the prompt panel | M5 builds one `PromptService` and one panel. Every source feeds it through `PromptService.offer` (see "Prompt feed shared with M2"); M2's call detection builds no card or notification of its own. | M2 and M5 each build a prompt | Two panels for one call is the obvious bug, and an M2 click would store the call as `call_detected` and break the streak. openwhispr routes calendar and audio detection through one engine (`meetingDetectionEngine.js` `_handleDetection`) that attaches the running or imminent calendar event to an audio detection (`_findCalendarEvent`). **Owner decision D5.** |
| Who owns the app shell | M4-S1 to M4-S4b (M4 D6), in waves 1 to 3. This plan's SHELL-0 spec is folded in: `app:navigate` is M4-S1's and the `PreferencesStore` is M4-S2's. "SHELL" here means M4-S1 to M4-S4b. | Two foundation tasks outside the milestones (this plan's first draft) | Every Phase 2 plan said the shell was owned elsewhere, so nobody would build it. M4's ids are numbered and land in waves 1 to 3, before any M5 task that needs them (`phase-2-build-order.md`). **Owner decision D4 (OD-19).** |

Default notice text: "Hi all, I'm using Roger to transcribe this call for my notes. Let me know if
you'd rather I didn't."

### Sign-in

```
desktop main                                  API                                Google
1 verifier, challenge, state; listen 127.0.0.1:0
2 POST /v1/calendar/google/authorization ───▶ builds URL (client id, scopes)
                                         ◀─── authorization_url
3 openExternal(url)  (only https://accounts.google.com/, or its own redirect in fake mode)
                         user consents in the default browser ─────────────────────▶
4 GET 127.0.0.1:<port>/oauth/callback?code&state ◀──────────────────────────────── redirect
  check state, answer "You can close this tab", close the port
5 POST /v1/calendar/google/connection ──────▶ code + verifier + secret ─────────▶ /token
  {code, code_verifier, redirect_uri}         check scope, read email,       ◀──── refresh token
                                              store encrypted
```

### Every day

```
API  GET /v1/calendar/events ──▶ Google events.list (access token cached in memory, refreshed)
 ▲ every 5 min, on wake, on focus; stale after 1 h without success
desktop main: CalendarSync ──▶ calendar.sqlite (events, fetch_state, connections_log, prompts, runs)
              ReminderScheduler (10 s tick) ──offer──▶ PromptService ──▶ PromptWindow (panel)
              M2 CallDetector ─────────────offer──▶ PromptService
              Take notes ──▶ app:navigate + start request ──▶ renderer start(request) ──▶ CaptureService
              ──▶ roger.sqlite meeting (title, link, start_source) ──▶ uploader ──▶ POST /v1/meetings
```

### Prompt feed shared with M2 (D5)

```ts
type PromptOffer =
  | { source: 'calendar'; eventKey: string }                            // ReminderScheduler
  | { source: 'call_detected'; app: { bundleId: string; name: string } }; // M2-T17
```

`PromptService.offer` applies these rules to a `call_detected` offer, in order, one test each in
`PromptService.test.ts`:

1. Dropped while a note is starting or recording.
2. Dropped while a calendar card for an attachable event is showing, or when one was acted on
   (any action, Dismiss included) in the last 15 min.
3. If exactly one prompt-worthy event is running or starts within 5 min (the manual-start rule),
   that event's calendar card shows now, logged with `shown_by = 'call_detected'`. A click is a
   `notification` start, as for any calendar card. openwhispr attaches the active event or one
   starting within 5 min (`meetingDetectionEngine.js`, `IMMINENT_THRESHOLD_MS`).
4. Otherwise a call-detected card: "Zoom is using the mic", Take notes (`start_source =
   call_detected`), Dismiss.

A calendar card that comes due while a call-detected card shows replaces it. M2's 10-minute cooldown
after a dismiss stays in M2's `CallDetector`, before `offer`. A call-detected card with no event is
logged with `source = 'call_detected'` and never counts toward the streak.

Edits to `M2-capture-you-can-trust.md`, applied on 2026-10-06 with `phase-2-build-order.md`:
M2-T17b calls `PromptService.offer` and builds no notification or card, and depends on M5-T9b;
M2-T20b drops its call-detected card (M5-T10 renders both kinds); M2's shell needs name M4-S1
and M4-S4; M2's risk row on shared files points at the build order.

### Cross-plan file order

Superseded by section 3.1 of `phase-2-build-order.md`, which wins where this table differs.
There, shared IPC lives in per-feature modules, `index.ts` has named slots, and M5-T5 also
follows M2-T3 and M4-T22.

| File | Order |
| --- | --- |
| `src/shared/capture.ts`, `src/shared/ipc/capture.ts` and its bridge | M2-T2, then M5-T5 |
| `src/main/capture/CaptureService.ts`, `src/main/index.ts`, `src/main/ipc.ts` | M2-T4 (seams, composition root), then M5-T5, then M5-T9c and M5-T11 (one block each in `index.ts`; whichever merges second rebases) |
| `src/renderer/src/state/useCapture.ts` | M2-T12, then M5-T5 (`start(request)` as a thin wrapper over the existing start), then M3-T9, which keeps the wrapper |
| `src/main/window.ts` | M2-T12, then M5-T11 |
| `src/main/lifecycle.ts` (the landed `RecordingLifecycle`) | P2-F1 (quit hooks), M2-T12, M2-T18, then M5-T11 (a hide never stops the recording; the public `quitting` getter) |
| `roger.sqlite` migrations | M1's migration 3 (`stt_usage`, landed), M2-T3's migration 4, then M5-T5's migration 5 (M3-T19b's 6 follows) |
| Alembic | `0004_calendar`, `down_revision = "0003"`, fixed (M3 is `0002`, M4 is `0003`) |

### API contract changes (`docs/api-contract.md`, in the same commits as the code)

New error codes (P2-F2 adds them to the error table with their error classes; the "only `409`"
sentence is gone, because M4 adds `409`s of its own):

| HTTP | code | When |
| --- | --- | --- |
| 424 | `calendar_reconnect_required` | Google refused the stored refresh token or a used or expired sign-in code (`invalid_grant`), or the user did not grant calendar access. The message says what to do. |
| 502 | `calendar_provider_error` | Google is unreachable or answered with an error we cannot use |

New entities:

```ts
type StartSource = "manual" | "notification" | "home" | "tray" | "call_detected";
type ResponseStatus = "accepted" | "tentative" | "declined" | "needs_action";

interface CalendarAttendee {
  email: string;
  display_name: string | null;
  response_status: ResponseStatus;
  is_self: boolean;
  is_organizer: boolean;          // rooms and other resources are never listed
}

interface CalendarEvent {
  provider: "google" | "fake";
  id: string;                      // instance id for a recurring event
  ical_uid: string | null;
  recurring_event_id: string | null;
  title: string;                   // "" when the invite has none
  status: "confirmed" | "tentative"; // cancelled events are never returned
  all_day: boolean;
  start: string | null;            // instant; null when all_day
  end: string | null;
  start_date: string | null;       // "2026-10-06" when all_day
  end_date: string | null;         // exclusive
  self_response: ResponseStatus | "organizer" | "unknown";
  attendees: CalendarAttendee[];
  attendees_omitted: boolean;      // Google left some out (privacy or more than 100)
  video_link: string | null;       // allowlisted hosts only
  video_link_source: "conference" | "location" | "description" | null;
  html_link: string | null;
}

interface CalendarConnection {
  provider: "google" | "fake";
  account_email: string;
  status: "active" | "reconnect_required";
  connected_at: string;
  expires_hint: string | null;     // connected_at + 7 d when GOOGLE_OAUTH_AUDIENCE=external_testing (Google; null for fake)
  last_error: string | null;
}

interface MeetingCalendarEvent {
  provider: "google" | "fake";
  event_id: string;
  ical_uid: string | null;
  recurring_event_id: string | null;
  scheduled_start: string;         // instant
  scheduled_end: string;
  attendees: CalendarAttendee[];   // at most 200, in invite order
}

// Meeting gains:
//   start_source: StartSource;
//   calendar_event: MeetingCalendarEvent | null;
```

New and changed endpoints (all need the bearer token and resolve the `Principal` first):

| Endpoint | Request | Response |
| --- | --- | --- |
| `POST /v1/calendar/google/authorization` | `{redirect_uri, code_challenge, state}`; `redirect_uri` must be `http://127.0.0.1:<port>/...` | `200 {authorization_url}` |
| `POST /v1/calendar/google/connection` | `{code, code_verifier, redirect_uri}` | `201 CalendarConnection`; replaces an existing one. `424` when calendar access was not granted, `502` when Google fails. |
| `GET /v1/calendar/connection` | | `200 {connection: CalendarConnection \| null}` |
| `DELETE /v1/calendar/connection` | | `204`; revokes at Google (a failed revoke is logged, the row is still deleted); repeatable |
| `GET /v1/calendar/events?from=<instant>&to=<instant>` | window at most 7 days, `from < to` | `200 {items: CalendarEvent[], fetched_at}`, ordered by start. `404` with no connection, `424`, `502`. |
| `POST /v1/meetings` | adds optional `start_source` (default `manual`) and `calendar_event` | `Meeting` with both fields. A re-send with a different link returns the stored row unchanged, as for `title` today. |
| `GET /v1/meetings`, `GET /v1/meetings/{id}`, transcript | | each `Meeting` carries `start_source` and `calendar_event`; a page loads attendees in one extra query, never one per meeting |

### Postgres (one Alembic revision, `0004_calendar`, down `0003`)

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;          -- downgrade leaves the extension in place
calendar_connections (id uuid pk, workspace_id uuid fk, user_id uuid null,  -- user_id arrives in M6
                      provider text check in ('google','fake'), account_email text, scopes text,
                      refresh_token bytea null,     -- pgp_sym_encrypt; null only for the fake provider
                      status text check in ('active','reconnect_required'), last_error text null,
                      connected_at, created_at, updated_at,
                      unique nulls not distinct (workspace_id, user_id))
meetings            += start_source text not null default 'manual'
                         check in ('manual','notification','home','tray','call_detected'),
                       calendar_provider text null, calendar_event_id text null,
                       calendar_ical_uid text null, calendar_recurring_event_id text null,
                       scheduled_start_at timestamptz null, scheduled_end_at timestamptz null
meeting_attendees   (id uuid pk, workspace_id uuid fk, meeting_id uuid fk on delete cascade,
                     position int, email text, display_name text null, response_status text,
                     is_self bool, is_organizer bool, unique (meeting_id, position))
```

No new index on `meetings`: M5 adds no query that filters by event. The `(meeting_id, position)`
unique index serves the one attendee query. `expires_hint` is computed, not stored.

### Desktop storage

- `roger.sqlite` (shared with M2 and M4): one new migration entry adds `meetings.start_source`
  (default `manual`, the same five values as a `CHECK`) and `meetings.calendar_event_json`. The
  uploader sends both with the create.
- `calendar.sqlite` (new, M5 only, its own `user_version`):
  - `events`: the last good window, replaced atomically on each poll; `first_seen_at` per key is
    carried over by the replace.
  - `fetch_state`: last success, last error, stale since.
  - `connections_log` (account, connected_at, disconnected_at): never cleared.
  - `prompts` (account, key, source, event id, title, scheduled start, shown_at, shown_by, action,
    reason, detail, meeting id, decided_at, excluded_reason; primary key account + key): never
    cleared. Actions: `starting`, `started`, `joined_and_started`, `started_degraded`,
    `start_failed`, `dismissed`, `expired`, `missed`.
  - `runs` (started_at, last_tick_at): one row per app run, updated each tick.

  Disconnect clears `events` and `fetch_state` only. A separate file keeps M5 out of the shared
  migration list and makes the log easy to query for the exit check.

The streak query, `apps/desktop/scripts/calendar-streak.sql` (T9a), is the one the owner runs and
the one `PromptLog.test.ts` runs; instants are stored as `YYYY-MM-DDTHH:MM:SS.sssZ`, so they sort
as text:

```sql
WITH calls AS (
  SELECT scheduled_start, IFNULL(action, 'open') AS action FROM prompts
  WHERE source = 'calendar' AND excluded_reason IS NULL
    AND account_email = (SELECT account_email FROM connections_log ORDER BY connected_at DESC LIMIT 1)
    AND julianday(scheduled_start, '+10 minutes') <= julianday('now')   -- closed prompts only
),
last_break AS (
  SELECT MAX(scheduled_start) AS at FROM calls
  WHERE action NOT IN ('started', 'joined_and_started')
)
SELECT COUNT(*) AS streak, MIN(scheduled_start) AS since
FROM calls, last_break
WHERE action IN ('started', 'joined_and_started')
  AND (last_break.at IS NULL OR scheduled_start > last_break.at);
```

### New settings

| App | Setting | Default |
| --- | --- | --- |
| API | `CALENDAR_PROVIDER` | `fake` |
| API | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | required when `google` |
| API | `GOOGLE_OAUTH_AUDIENCE` | `external_testing` (owner decision: open to everyone); `external_testing` turns on `expires_hint`; `external_production` after Google verification; `internal` for a Workspace-only project |
| API | `CALENDAR_TOKEN_KEY` | required when `google`, at least 32 characters (`openssl rand -hex 32`) |
| API | `FAKE_CALENDAR_FILE` | empty: built-in fake events |
| Desktop prefs | `calendar.reminderLeadMinutes` | 1 |
| Desktop prefs | ~~`notice.enabled`, `notice.text`~~ removed 2026-10-08 (a stored value stays in the file and is ignored) | |
| Desktop prefs | `app.openAtLogin` | `auto` (on at first connect); `on`, `off` once the user chooses |

The preference keys, defaults and validators live once in `src/shared/calendarPrefs.ts` (T8) and are
registered with M4-S2's `PreferencesStore` (its `register(specs)` registry) by T9a.

### App shell: SHELL-0 and SHELL (D4)

C7 needs one owner for the app shell. Resolved on 2026-10-06 (`phase-2-build-order.md`, OD-19): the
shell is M4-S1 to M4-S4b. The SHELL-0 spec below is kept as the requirement M5 places on them:
`app:navigate` is built by M4-S1 and the preferences store by M4-S2, at M4's paths
(`main/preferences/PreferencesStore.ts`, `main/preferences/preferences-ipc.ts`,
`shared/ipc/prefs.ts`, `main/navigation.ts`, `shared/ipc/app.ts`), not the paths listed here.

- **SHELL-0 (now M4-S1 and M4-S2). Preferences store and `app:navigate`.** Requirement only.
  Specified here in full because M5 is the first plan it blocks. Owns
  `src/main/prefs/PreferencesStore.ts` (a key registry, `registerPreferences(schema)` with a
  default and validator per key; `get`, `set` that refuses unknown keys and bad values naming the
  key; `onChange`; `preferences.json` in `userData`, written to a temp file and renamed),
  `src/shared/prefs-ipc.ts` (`prefs:get-all`, `prefs:set`, `prefs:changed`),
  `src/main/prefs/prefsIpc.ts` (only the main window may call), `src/main/navigation.ts`
  (`app:navigate` from main to the renderer with a route from a closed set, `home`, `settings`,
  `meeting/<id>`; queued until the renderer sends `app:ready`, delivered once, dropped after 60 s),
  their preload and `roger.d.ts` lines, and the creation lines in `index.ts`. `preferences.json` is
  separate from `config.json`, which holds startup settings read once (M1, M2). In M1's single
  window the renderer listens to `app:navigate` and ignores routes it lacks.
  Tests (`PreferencesStore.test.ts`, `navigation.test.ts`): unknown key and bad value refused; a
  torn write keeps the last good file; one change event per set; navigate queued until ready, then
  delivered once; another sender refused.
- **SHELL (now M4-S1 to M4-S4b).** Sidebar (Home, recent meetings), routes, Home with section
  slots, the meeting page frame with regions and a banner slot, Settings with section slots, theme tokens light and dark.
  Scoped by the union of the shell needs in M2, M3, M4 and M5. Depends on SHELL-0. If it must sit
  in a milestone, M4 (its D6): the meeting page is most of it.

What M5 needs from each:

| Need | From | Used by |
| --- | --- | --- |
| `PreferencesStore` with IPC get, set and change events | M4-S2 | M5-T9a, T9b, T11, T12 |
| `app:navigate` to the meeting route | M4-S1 | M5-T9b |
| Routes for Home, `/meetings/:id`, Settings | M4-S1 | M5-T13 |
| A Home section slot, a Settings section slot, a banner slot on the meeting page | M4-S1, M4-S4 | M5-T13 |
| Theme tokens for light and dark | M4-S2 | M5-T10, T12 |

### Owner setup: Google Cloud (about 10 minutes)

1. Sign in at console.cloud.google.com with the account that should own Roger's Google project.
   Project picker → **New project**, name "Roger", Create. (No organization needed: the owner
   decided on 2026-10-06 that any Google account may connect, not only linkt.ai.)
2. **APIs & Services → Library**, search "Google Calendar API", **Enable**.
3. **Menu → Google Auth platform → Branding → Get started.** App name "Roger", user support email
   yours. **Audience: External** (D2). Contact email yours. Agree, Create. Then **Audience → Test
   users → Add users**: add everyone who will connect for now (100 at most). Keep publishing
   status Testing and `GOOGLE_OAUTH_AUDIENCE=external_testing` (step 6). Google shows "Google
   hasn't verified this app" at sign-in (Continue), and a connection lasts 7 days; Roger warns from
   day 6. To open it to anyone without the weekly reconnect: Branding needs a homepage and privacy
   policy on a verified domain, then **Audience → Publish app** and submit verification for the
   calendar scope; set `GOOGLE_OAUTH_AUDIENCE=external_production` once it is approved.
4. **Data Access → Add or remove scopes:** `openid`, `.../auth/userinfo.email`,
   `.../auth/calendar.events.readonly`. Save.
5. **Clients → Create client → Application type: Desktop app**, name "Roger desktop", Create.
   **Download the JSON now**: Google shows the client secret only once, at creation.
6. In the repo-root `.env` (never committed): `CALENDAR_PROVIDER=google`,
   `GOOGLE_OAUTH_CLIENT_ID=...`, `GOOGLE_OAUTH_CLIENT_SECRET=...`,
   `CALENDAR_TOKEN_KEY=$(openssl rand -hex 32)`. Keep the key: losing it means reconnecting.
7. `make migrate && make dev-api`, then Roger → Settings → Calendar → Connect Google Calendar.
   Connect the calendar you take calls on, with an account listed as a test user.
8. Only if sign-in says the app is blocked by your admin: Google Admin → Security → Access and data
   control → API controls → Manage third-party app access → add the client id as Trusted.

### Decisions for the owner

| Id | Question | Recommendation | Alternative |
| --- | --- | --- | --- |
| D1 | Where does the Google refresh token live? | The API, pgcrypto-encrypted, so the desktop keeps holding only the Roger token and M6 reuses the store. Phase 2 cost: `make dev-api` must run; Roger says loudly when the calendar goes stale | Desktop Keychain via `safeStorage`: no API hop and no stale risk, but bends house rule 3 and has to move to the server in M6 |
| D2 | Consent screen audience | **Decided by the owner 2026-10-06:** External, open to any Google account. Testing first (test users, reconnect every 7 days, warned from day 6), In production after Google verification | Internal under the linkt.ai org (no expiry, linkt.ai accounts only) |
| D3 | Notice wording | **Moot since 2026-10-08: the notice was removed.** The default above, on by default, reviewed by Linkt's legal view before Gate 2. M2 keeps call audio on the Mac for 7 days; legal may want the notice to say so. | Wait for legal before shipping any text |
| D4 | Who owns the app shell | M4-S1 to M4-S4b (M4 D6), with SHELL-0's spec folded into M4-S1 and M4-S2; M5 only mounts a Home section, a Settings section and a meeting banner (T13). Revised 2026-10-06 in `phase-2-build-order.md` (OD-19) | Two foundation tasks outside the milestones (this plan's first draft) |
| D5 | Who owns the prompt panel | M5, with `PromptService.offer` that M2's call detection feeds, and M2-T17 and M2-T20 changed to match | M2 owns it and M5 feeds it |

## Work items

Each task owns its files, writes its tests first, and lists what it waits for. SHELL-0 and SHELL are
now M4-S1, S2, S4 and S4b (D4). Waves and the order of shared files are in
`phase-2-build-order.md`, which wins where this list differs.

| Id | Title | App | Size | Depends on |
| --- | --- | --- | --- | --- |
| (SHELL-0) | Built by M4-S1 (`app:navigate`) and M4-S2 (preferences) | desktop | - | - |
| M5-T1 | Calendar settings, schema and migration | api | M | - |
| M5-T2 | Calendar providers: Google over httpx, and fake | api | M | - |
| M5-T3 | Calendar routes, encrypted token store, contract | api | M | T1, T2 |
| M5-T4 | Meetings carry their calendar event and start source | api | S | T1 |
| M5-T5 | Start requests carry title, source and event link | desktop | M | T4, T8, M2-T2, M2-T3, M2-T3b, M2-T4, M2-T12, M4-T22 |
| M5-T6 | Google sign-in and calendar IPC | desktop | M | T3, T5, T7, T8 |
| M5-T7 | Calendar sync, local cache, stale state | desktop | M | T8 |
| M5-T8 | Calendar types, ports, preference keys, reminder rules (pure) | desktop | S | - |
| M5-T9a | Reminder scheduler and prompt log | desktop | M | T7, T8, M4-S2 |
| M5-T9b | PromptService, prompt feed, consent notice, prompt IPC | desktop | M | T5, T8, T9a, M4-S1, M4-S2 |
| M5-T9c | Calendar wiring and the end-to-end flow | desktop | M | T6, T9a, T9b |
| M5-T10 | Prompt panel window and cards | desktop | M | T9b |
| M5-T11 | Keep running: menu bar, hide on close, open at login, dev data folder | desktop | M | T5, T6, T7, M4-S2, M2-T4, M2-T12, M2-T13 |
| M5-T12 | Home "Today", Calendar settings, banners (standalone) | desktop | M | T6, T7, T9b, T11, M4-S2 |
| M5-T13 | Mount the calendar screens in the shell, QA gallery | desktop | S | T10, T12, M4-S1, M4-S3, M4-S4 |

Waves (from `phase-2-build-order.md`): T8 in wave 0; T1, T2 and T7 in wave 1; T3, T4 and T9a in
wave 2; T5 in wave 4 (after M2-T3b, M2-T4, M2-T12 and M4-T22); T6 and T9b in wave 5; T9c, T10 and
T11 in wave 6; T12 in wave 7; T13 in wave 8.

- [x] **M5-T1** Owns `apps/api/src/roger_api/migrations/versions/0004_calendar.py` (revision
  `0004`, `down_revision = "0003"`, fixed; P2-F2's stub), the calendar models in
  `db/models_calendar.py` and the new `Meeting` columns in `db/models.py`, the calendar settings
  (including `GOOGLE_OAUTH_AUDIENCE`) and their validator in `config_calendar.py` (P2-F2's
  `CalendarSettings` mixin), the Calendar section of `.env.example`, `tests/test_calendar_schema.py`
  and `tests/test_calendar_config.py`, and `restart: unless-stopped` on `db` in
  `docker-compose.yml` (D1). The `start_source` check carries all five values.
- [x] **M5-T2** Owns `apps/api/src/roger_api/services/calendar/{provider,google,fake,normalize,video_links}.py`,
  (`CalendarProviderError` and `CalendarReconnectRequiredError` are already in `errors.py`, from
  P2-F2), fixtures under
  `tests/fixtures/calendar/`, and the `[tool.ruff.lint.flake8-tidy-imports.banned-api]` block in
  `apps/api/pyproject.toml` (`jwt` and `cryptography`, with the reason). `CalendarProvider`
  protocol: `authorization_url`, `exchange_code`, `refresh`, `revoke`, `list_events`. Auth URL adds
  `access_type=offline`, `prompt=consent`, `include_granted_scopes=true`. The ID token payload is
  decoded with stdlib `base64` and `json` only. Video link order: location, description,
  `hangoutLink`, video entry points (typed links first; see Design, "Video link"), through
  `video_links.py` (comment points at the desktop's `meetingLinks.ts`). Uses the `httpx` already
  declared; no new dependency.
- [x] **M5-T3** Owns `services/calendar/{connections,events}.py`, `routers/calendar.py`,
  `schemas/calendar.py`, `services/calendar/runtime.py` (`open_calendar_runtime(settings)`, which
  P2-F2's lifespan already enters, plus the FastAPI getters; `app.py` and `dependencies.py` are not
  edited), the calendar
  section and error rows of `docs/api-contract.md`, a pointer to the Google setup in
  `apps/api/README.md`, and `hide_parameters=True` in `db/engine.py` with a comment that says why
  and points at `services/calendar/connections.py` (whose comment points back). Access tokens live
  in memory per connection until 60 s before expiry; a Google `401` forces one refresh and one
  retry. `expires_hint` from `GOOGLE_OAUTH_AUDIENCE`.
- [x] **M5-T4** Owns the calendar parts of `schemas/meetings.py`, `services/meetings.py`,
  `routers/meetings.py` and the meetings section of `docs/api-contract.md`. `StartSource` carries
  `call_detected`. Attendees load in one `WHERE meeting_id IN (...)` query per page.
- [x] **M5-T5** Owns `StartSource` (five values), `StartCaptureRequest` and `title` on
  `CaptureStatus` in `src/shared/capture.ts`; the `capture:start` payload,
  `capture:start-requested` and `capture:take-pending-start` in `src/shared/ipc/capture.ts`, its
  bridge and preview fake, `src/main/ipc.ts`, `src/main/ipc-validation.ts`;
  `CaptureService.start(request)` with an optional injected `StartRequestEnricher` port, and
  `requestStart(request)` / `takePendingStart()` (a request expires after 60 s); `roger.sqlite`
  migration 5 (after M2-T3's migration 4; 3 is M1's `stt_usage`), `findMeetingIdsByEventIds` in
  the store; the create payload in `TranscriptUploader.ts` and `ApiClient.createMeeting`, and in
  `ApiClient.ts` the optional `price_per_hour_usd_without_keyterms` on `SttTokenResponse.stream`
  (M3-T4b and the bench's `credentials.ts` read it; phase-2 build order, section 10). Edits
  `src/renderer/src/state/useCapture.ts` after M2-T12: `start(request)` as a thin wrapper over the
  existing start (it keeps the landed `followMain` call and the status re-read on focus), and
  taking a pending request on mount. Edits `CaptureService.ts` after M2-T4 and M4-T22, and
  `TranscriptUploader.ts` after M2-T3b and M4-T22. `start(request)` keeps the landed cost guards:
  a requested start passes `SttOpenBudget` like a pressed one, and a refusal (a third quick start
  in a minute) reaches `PromptService` as the start's outcome. As built: the enricher is set once
  with `capture.setStartRequestEnricher(fn)` (T9c's slot runs after the runtime is built; a second
  set throws) and runs on every start that makes a meeting, never on a resume; its answer is
  checked again, and a throw or a refused answer is logged and the start goes on with the request
  as it came. `requestStart` and the enricher's answer have their title cut to fit
  (`fitMeetingTitle`); a window's own over-long title is refused at the IPC. A Start that arrives
  during a Stop waits for it, then starts; one that meets a recording starting or running joins it
  and only logs that its request was not applied, so T9b stops a recording note first. A title
  blank as the API reads it (U+001C to U+001F included) gets the default title. No channel serves
  `findMeetingIdsByEventIds` yet: T6 adds it (assigned after wave 4).
- [x] **M5-T6** Owns `src/main/calendar/oauthLoopback.ts`, `src/main/calendar/CalendarAccount.ts`,
  `src/main/api/calendarClient.ts` (implementing T8's `CalendarApiPort` on P2-F1's `http.ts`,
  DELETE included), `src/shared/ipc/calendar.ts` (account status, connect, disconnect, events, sync
  state including stale and `expires_hint`) with its bridge and preview fake,
  `src/main/calendar/calendarIpc.ts`. Assigned after wave 4 (T5 built the store read, nothing
  serves it): a channel in `shared/ipc/calendar.ts` that answers the newest local meeting started
  for each of a list of event ids, through a port T9c fills with the transcript store's
  `findMeetingIdsByEventIds`, for T12's Open note.
  Opens only `https://accounts.google.com/` URLs, or its own redirect in fake mode. A second
  Connect cancels the first. Times out after 3 minutes. Connect and disconnect go through T7's `CalendarSync.connected(accountEmail)`
  and `disconnected()`, which write `connections_log`; never the cache's `recordConnected` or
  `recordDisconnected` directly, or an answer in flight writes a disconnected account's events back.
- [x] **M5-T7** Owns `src/main/calendar/CalendarSync.ts` and `src/main/calendar/SqliteCalendarCache.ts`
  (`calendar.sqlite`: the schema of every table above; methods for `events`, `fetch_state` and
  `connections_log`). Window: now − 36 h to now + 36 h. Catch-up fetch at launch (from 10 min
  before the last tick: Google lists events that end after `timeMin`). Single-flight refresh,
  backoff from 1 min x2 to 30 min, stops on `424` until the next connect (a launch still asks once:
  the dev build and the installed app share one API). Disconnect clears `events` and `fetch_state`
  only. Sync state turns `stale` once the last success is over 1 h old (checked on wake too).
- [x] **M5-T8** Owns `src/shared/calendar.ts` (event, attendee, connection, state, prompt card,
  offer, meeting link types), `src/shared/calendarPrefs.ts` (preference keys, defaults,
  validators), `src/main/calendar/ports.ts` (`CalendarApiPort`), `src/main/calendar/reminderPolicy.ts`
  (prompt-worthiness, due window, one clear match, `missedReason`), `src/shared/meetingLinks.ts`
  (video host allowlist; comment points at the API's `video_links.py`). Pure code only.
- [x] **M5-T9a** Owns `src/main/calendar/ReminderScheduler.ts` (10 s tick, `powerMonitor` resume,
  fresh check before showing with a 5 s fallback, the `prevent-app-suspension` blocker from 2 min
  before the next due prompt until it shows), `src/main/calendar/PromptLog.ts` (`prompts` and
  `runs`: shown, actions, `missed` rows each tick and at launch, the `app_exit` clean-up at
  launch, run heartbeat), `apps/desktop/scripts/calendar-streak.sql`, and
  `registerCalendarPreferences(store)` (built in `main/calendar/calendarPreferences.ts`) for M4-S2's
  `PreferencesStore` (called from T9c's slot; the
  `PreferenceValues` types and the preview fake's calendar keys are already done by M4-S2).
- [x] **M5-T9b** Owns `src/main/prompt/PromptService.ts` (cards; `offer` with the D5 rules; actions
  start, join and start, copy notice, dismiss, expire; `app:navigate` plus a `revealWindow` port
  that calls `showInactive()` only when the window is hidden and never `show()` or `focus()`; the
  outcome from `CaptureStatus` within 20 s; a "Calendar not updated since …" card once per stale
  spell), `src/main/calendar/consentNotice.ts`, `src/shared/ipc/prompt.ts` (P2-F1's stub; not
  part of `RogerApi`),
  `src/main/prompt/promptIpc.ts` (accepts the prompt window as sender, nothing else).
- [x] **M5-T9c** Owns `src/main/calendar/createCalendarRuntime.ts`, `[slot M5-T9c]` in
  `src/main/index.ts`, the `StartRequestEnricher` it injects into `CaptureService`
  (one clear match), and `src/main/calendar/calendarFlow.test.ts`. Also passes M4's template rule
  the invite's attendees: the optional `attendees` getter on the `new NotesGenerator` call in
  `[slot M4-T16 notes]`, read from the local meeting's `calendar_event_json` (build order,
  section 10, "From wave 3"). And T6's event-to-meeting port: pass it the transcript store's
  `findMeetingIdsByEventIds`, and reword that method's doc in `store/TranscriptStore.ts` (which
  says no channel serves it) to name T6's channel ("From wave 4").
- [x] **M5-T10** Owns `src/main/prompt/PromptWindow.ts`, `src/main/prompt/promptBounds.ts`,
  `src/preload/prompt.ts` (exposes only `window.rogerPrompt`), `src/renderer/prompt.html`,
  `src/renderer/src/prompt/*`; adds the second preload and page to `electron.vite.config.ts`;
  in `page-policy.ts` the prompt page counts as the app for navigation but gets no `media`.
  Calendar card: "Starting in 1 min" or "Started 3 min ago", title, time range, "Jane, Ali and 3
  others", Join and take notes (only with a video link), Take notes, Copy notice (when on),
  Dismiss. Call-detected card, stale-calendar card, and the 5 s "Taking notes · Open Roger" state.
  As built, `index.ts` first did not construct `PromptWindow` or call `registerPromptIpc` (no task
  owned that slot), and `startKeepRunning` got `calendar: null`; the Phase 2 docs pass wired both
  (build order "Open items after Phase 2", items 1 and 2).
- [x] **M5-T11** Owns `src/main/app/{tray,trayMenu,loginItem,loginItemPolicy,windowLifecycle,userDataPath}.ts`
  (named `windowLifecycle.ts`, not `lifecycle.ts`: the landed `src/main/lifecycle.ts` is the
  recording's `RecordingLifecycle`),
  `src/shared/ipc/loginItem.ts` with its bridge and preview fake, `src/main/app/loginItemIpc.ts`,
  `build/trayTemplate.png`, `build/trayRecordingTemplate.png`, `build/trayWarningTemplate.png` and
  their `@2x`, and two slots in `src/main/index.ts`. `[slot M5-T11 userData]`: `userData` set to
  "Roger Dev" when not packaged, before `requestSingleInstanceLock`, with a comment saying why it
  must come first, and never when `ROGER_E2E=1` or `--user-data-dir` already set it (M2-T13's
  slot comes first and leaves `const e2e` in scope: read `e2e.on`, and
  `app.commandLine.hasSwitch('user-data-dir')`, which Electron honours by itself; register no login
  item while `e2e.on`, or macOS shows a "background item added" notice). `[slot M5-T11 lifecycle]`:
  `window-all-closed` no longer quits; `activate` shows the window; login launch from
  `wasOpenedAtLogin`. Edits `src/main/window.ts` after M2-T12: close hides, `backgroundThrottling:
  false`. Edits `src/main/lifecycle.ts` (wave 6, after M2-T12 and M2-T18): today `watchWindow` stops
  the recording on the window's `close` event (cost guard G4, reason `window-closed`), which still
  fires when the close is turned into a hide; it now stops only when the window is really closed
  (`closed`, which with close-hides happens only while quitting), with a test that a hide keeps
  recording. Quit still goes through `RecordingLifecycle`; the tray's Quit calls `app.quit()` and
  adds no stop of its own. Close hides unless quitting, and only `RecordingLifecycle` knows a quit
  is under way (its `quitState` is private, and P2-F1 forbids another `before-quit` listener), so
  T11 adds a public `quitting` getter to `lifecycle.ts` (true once a quit was requested) and the
  close handler in `window.ts` hides only while it is false. Without it the close that `app.quit()`
  sends after the stop is turned into a hide, which cancels the quit and Roger never exits; say
  that in a comment at the close handler. Menu: next meeting, Start notes now, Stop note while
  recording, "Calendar not updated since …" when stale, "Reconnect Google Calendar (before <date>)"
  when needed, Open Roger, Quit Roger. Icon states: idle, recording, warning. Default-on at first
  connect ships only after real-Mac check 1 passes; until then `app.openAtLogin` defaults to `off`.
  Adds the dev-data failure-log line to `apps/desktop/CLAUDE.md`.
- [x] **M5-T12** Owns `src/renderer/src/calendar/*`: `TodaySection`, `NextMeetingCard`,
  `ConnectCalendarCard`, `CalendarSettings` (open at login status and toggle, with
  `requires-approval` and its System Settings path), `NoticeBanner`, `CalendarStatusBanner`
  (stale, reconnect, reconnect before <date>), `useCalendar`, `todayGroups.ts`, `calendarFormat.ts`.
  Standalone components; T13 mounts them. Start notes shows from 15 min before start to the end;
  Open note when a local meeting already has the event (T6's channel, asked again when the
  recording's meeting changes). After the first connect a line says "Roger
  will open at login so it can remind you" with Undo. Colours from theme tokens only.
- [x] **M5-T13** Owns `renderer/src/app/slots/m5-calendar.ts` (Home section, Settings section,
  meeting banner), and the QA script (on M4-S3's `qa/driver.ts`, playwright-core) and gallery for
  the screens below.
- [x] Each task proposes the traps it hit as failure-log lines in its hand-off note; the controller
  appends them once per wave, each to the file its trap belongs in (`CLAUDE.md`,
  `apps/desktop/CLAUDE.md` or `apps/api/CLAUDE.md`).
- [ ] Exit check: 20 calls, logged below.

## Tests

Tests are named per behaviour. API tests run against the real Postgres test database and mock
Google with `httpx.MockTransport`, as `test_stt_token.py` does for AssemblyAI and Deepgram.

| What | Test |
| --- | --- |
| Migration builds the models; pgcrypto present; one connection per workspace and user even with `user_id` NULL; unknown `start_source` refused by the database, `call_detected` accepted; attendees go with their meeting | `apps/api/tests/test_migrations.py`, `tests/test_calendar_schema.py` |
| Google provider needs client id, secret and a 32+ character key; fake needs none; audience is `external_testing` (default), `external_production` or `internal` | `tests/test_calendar_config.py` |
| Auth URL carries client id, loopback redirect, S256 challenge, state, offline access, exact scopes | `tests/test_calendar_google.py::test_authorization_url_is_exact` |
| Code exchange sends code, verifier, secret and redirect; reads the email from the ID token with stdlib decoding; refuses a grant without the calendar scope (`424`, "tick the box") | `test_calendar_google.py::test_exchange_*` |
| No module in the API imports `jwt` or `cryptography` | ruff `TID251` in `make check`, plus `tests/test_calendar_google.py::test_no_jwt_or_cryptography_import` (walks `roger_api` with `ast`) |
| Refresh `invalid_grant` is reconnect-required; `5xx` and timeouts are provider errors | `test_calendar_google.py::test_refresh_*` |
| Event listing asks for primary, single events, default type, offsets on both bounds; follows page tokens; refuses a repeated page token (anarlog `crates/calendar/src/fetch.rs`) | `test_calendar_google.py::test_list_events_*` |
| Normalising: offsets to UTC; all-day keeps its dates and is never midnight UTC; cancelled dropped; declined kept as declined; organizer self is `organizer`; rooms dropped; `attendeesOmitted` kept; empty title; recurring id kept | `tests/test_calendar_normalize.py` |
| Video link: a Zoom link in the location wins, then a Teams link in the description, then `hangoutLink`, then entry points, each with its `video_link_source`; a typed link beats an auto-added Meet link; a lookalike host in the description is ignored | `tests/test_calendar_normalize.py::test_video_link_*`, `tests/test_calendar_video_links.py` |
| Fake: auth URL is the redirect with `code=fake` and the same state; events stable between calls; file override | `tests/test_calendar_fake.py` |
| Every calendar route is `401` without the token | `tests/test_calendar_api.py::test_calendar_routes_require_auth` |
| Non-loopback `redirect_uri` is `422`; `127.0.0.1` with any port is accepted | `test_calendar_api.py::test_authorization_*` |
| The refresh token is stored encrypted: the raw column never contains it; the key reads it back | `test_calendar_api.py::test_refresh_token_is_encrypted_at_rest` |
| Connecting again replaces the connection; another workspace's connection is invisible; `expires_hint` is `connected_at + 7 d` only for a Google connection under `external_testing` | `test_calendar_api.py::test_connection_*` |
| No connection `404`; expired access token refreshed once and cached; `invalid_grant` → `424` and status `reconnect_required`; Google `500` → `502`, status unchanged; window over 7 days or reversed `422` | `test_calendar_api.py::test_events_*` |
| Disconnect revokes and deletes; a failed revoke still deletes and logs; a second disconnect is `204` | `test_calendar_api.py::test_disconnect_*` |
| No code, verifier or token ever reaches a log line | `test_calendar_api.py::test_secrets_never_logged` (structlog `capture_logs`) |
| A real Postgres error during the connection upsert (the test passes an unknown `provider`, so the check constraint fails on the statement that carries the token and the key) puts neither in captured logs or the `500` response | `test_calendar_api.py::test_db_error_never_leaks_token_or_key` |
| Create with an event stores ids, times, attendees in order; `start_source` defaults to `manual`; `call_detected` accepted; bad value `422`; over 200 attendees `422`; re-send with another link returns the stored row unchanged; a page loads attendees in one extra query; attendees never cross workspaces | `tests/test_meetings_calendar.py` |
| Start request validation: unknown source refused, `call_detected` accepted; title over 500; over 200 attendees; bad instants | `apps/desktop/src/main/ipc-validation.test.ts` |
| Title and link from the request are stored; default title without one; the enricher runs on every start; a pending request is taken once and expires after 60 s | `src/main/capture/CaptureService.test.ts` |
| An existing `roger.sqlite` upgrades in place; old meetings read as `manual` with no link; an unknown source is refused | `src/main/store/SqliteTranscriptStore.test.ts` |
| The create sends `start_source` and `calendar_event` in snake_case | `src/main/upload/TranscriptUploader.test.ts`, `src/main/api/ApiClient.test.ts` |
| Loopback: binds 127.0.0.1 on a random port; resolves on matching state; a request without a code keeps waiting; wrong state fails; `access_denied` fails with "You cancelled the Google sign-in"; only the first callback counts; timeout and abort close the port; the browser page never shows the code | `src/main/calendar/oauthLoopback.test.ts` (real HTTP requests) |
| Only Google or its own redirect is opened; API errors become visible messages; a second Connect cancels the first | `src/main/calendar/CalendarAccount.test.ts` |
| Refresh cadence (5 min, wake, focus throttle); window is now − 36 h to now + 36 h; catch-up fetch at launch from the last tick, at most 6 days back; atomic replace drops deleted events and keeps `first_seen_at`; failure keeps the last good list with its time; backoff and reset; `424` stops polling; single-flight; `stale` after 1 h without success and cleared by the next success | `src/main/calendar/CalendarSync.test.ts` |
| Disconnect clears `events` and `fetch_state` but keeps `prompts`, `runs` and `connections_log`; prompts of two accounts stay apart | `src/main/calendar/SqliteCalendarCache.test.ts` |
| All-day, declined and solo blocks never prompt; a solo block with only a conference-data Meet link does not prompt; a solo block with a Zoom link in the location does; tentative does; due from start − lead to start + 10 min, once per key; a moved instance prompts again; re-accepting brings a prompt back; logged outcomes never repeat; two calls in one minute share one card; one clear match links, two overlapping link nothing; `missedReason` picks `disconnected`, `not_running`, `api_stale`, `policy` in that order | `src/main/calendar/reminderPolicy.test.ts` |
| Prompt timing gives the same answer under `TZ=America/Los_Angeles` and `TZ=Asia/Kolkata` and across a DST change | `reminderPolicy.test.ts::test_timing_is_instant_based` |
| Join links: Meet, Zoom (`/j/`), Teams accepted; `meet.google.com.evil.io` and plain `http` refused; the same table of URLs as the API test | `src/shared/meetingLinks.test.ts` |
| Due event shows one prompt; not again on the next tick or after restart; a stale list refreshes first and falls back after 5 s; the blocker starts 2 min before the next due prompt and stops once it shows; a passed event with no row gets `missed` with its reason, at a tick and at launch; events before the account's first connect never get `missed`; at launch a `starting` row from a crashed run becomes `start_failed` and an unanswered closed card `expired` | `src/main/calendar/ReminderScheduler.test.ts`, `src/main/calendar/PromptLog.test.ts` |
| The streak query: 20 `started` rows give 20; a `missed`, `dismissed`, `started_degraded` or NULL-action row restarts it; an excluded row is skipped; `call_detected` rows and the other account's rows are ignored; open rows (start + 10 min not passed) are ignored | `src/main/calendar/PromptLog.test.ts::calendar-streak.sql` (runs the script file) |
| Take notes → start request with `notification`, title and attendees; `started` only once both sources deliver and both streams are open; a dead "Them" logs `started_degraded` with `system`; mic denied logs `start_failed` and keeps the card; Join opens only allowlisted links; while recording it stops first; expires at start + 10; Copy notice copies the current text and keeps the card; notice off shows no notice; a prompt action never calls `show()` or `focus()`, and `showInactive()` only when the window is hidden; one stale card per spell | `src/main/prompt/PromptService.test.ts` |
| The D5 rules: `call_detected` dropped while recording; dropped while a calendar card shows or within 15 min of one being acted on; one running or imminent event shows its calendar card (`shown_by = call_detected`) and a click stores `notification`; no event shows a call-detected card that stores `call_detected`; a due calendar card replaces a call-detected card | `src/main/prompt/PromptService.test.ts::offer_*` |
| End to end with fakes and a fake clock: prompt → one click → local meeting with link → upload payload; a manual start near one event is linked by the enricher | `src/main/calendar/calendarFlow.test.ts` |
| Panel placement: top right with a 16 px margin, on the display under the cursor, clamped on a display with a negative origin | `src/main/prompt/promptBounds.test.ts` |
| The prompt page navigates as the app but gets no `media` | `src/main/page-policy.test.ts` |
| Card text: "Starting in 1 min", "Started 3 min ago", "Jane, Ali and 3 others", "Untitled meeting", "Zoom is using the mic" | `src/renderer/src/prompt/promptFormat.test.ts` |
| Close hides unless quitting, and a hide never stops the recording (the landed `window-closed` stop fires only on a real close); `quitting` is false until a quit is requested and true from then on; Cmd+Q with the window open does quit (the close sent during the quit is not turned into a hide); quit still stops capture and closes the store through `RecordingLifecycle`; a login launch (`wasOpenedAtLogin`) stays hidden, any other launch shows the window; reopening shows the window | `src/main/app/windowLifecycle.test.ts`, `src/main/lifecycle.test.ts` |
| A dev build's data folder is "Roger Dev" and a packaged build's is "Roger" | `src/main/app/userDataPath.test.ts` |
| Menu model: next meeting line, Start notes now, Stop note while recording, stale line, Reconnect (with date), Quit; icon idle, recording, warning | `src/main/app/trayMenu.test.ts` |
| Login item never registered when not packaged; turned on at first connect unless the user turned it off; reports `requires-approval` | `src/main/app/loginItemPolicy.test.ts` |
| Today grouping by local date; at 23:30 in `TZ=Asia/Kolkata` a 10:00 event still shows; an event over midnight shows on both days; all-day strip on top; declined greyed last; Start notes window; Open note when linked | `src/renderer/src/calendar/todayGroups.test.ts` |
| "Calendar not updated since 09:12"; "Reconnect before Tue 14 Oct" from 24 h before `expires_hint` (day 6), nothing before, nothing when it is null | `src/renderer/src/calendar/calendarFormat.test.ts` |
| Screens (prompt: one card, two cards, long title, 40 attendees, notice off, recording, call detected, stale; Home: not connected, empty day, 8 events, reconnect, stale; Settings including `requires-approval`; banner) in light and dark, scripted checks plus shots into one QA gallery | playwright-core (`qa/driver.ts`, M4-S3) against the preview harness with a fake `window.roger` / `window.rogerPrompt` (T13) |
| On a real Mac: the six checks under "Done when"; the panel shows over full-screen Meet and does not take focus; the first click starts the note | manual, recorded in the exit check log |

## Risks

| Risk | Signal | Response |
| --- | --- | --- |
| Refresh token expires weekly (External + Testing) | Home and the menu bar say "Reconnect before <date>" from day 6 | Google verification, then `external_production` (D2). Until then reconnect on day 6, between calls. |
| No prompt because Roger was not running (quit, crash, login item waiting for approval) | A `missed` row with `not_running` | Menu bar presence, open at login with its approval state in Settings, M2's crash work. The streak restarts. |
| The local API is not running (D1's Phase 2 cost) | "Calendar not updated since …" in the menu bar, the panel and Home after 1 h; `missed` rows with `api_stale` | Prompts keep coming from the local copy for up to 36 h; `restart: unless-stopped` brings Postgres back; start `make dev-api` after a reboot. A LaunchAgent for the API was not chosen: the API moves to the cloud in M6. |
| A capture problem passes as a good start | `started_degraded` rows; a meeting with `them_lines = 0` | Streak starts only after M2-T1, T7, T9, T10, T19; `started` needs both sources live; the Postgres check needs lines from both. |
| A mic or system audio dialog on the first click | Seen in real-Mac check 2 | M2-T1 and M2-T19 before the streak; the dialog would break "one click", so the check is logged. |
| The panel takes focus or covers Meet's controls | Typing lands in the wrong place; a click is ignored | `focusable: false`, `showInactive()`, `acceptFirstMouse`, top right; real-Mac check in T10. |
| Showing the main window pulls the user out of a full-screen call | Real-Mac check 3 | Never `show()` or `focus()` from a prompt; if `showInactive()` still moves Spaces, the window stays hidden and the panel offers "Open Roger". |
| App Nap delays the tick with the window hidden | A prompt later than 15 s in real-Mac check 4 | `prevent-app-suspension` from 2 min before the next due prompt; widen to the whole working day if the check still fails. |
| A hidden window throttles capture after the user closes it mid-call | Lines stop after the window closes | `backgroundThrottling: false`; real-Mac check 5. |
| Login item from a build without an Apple team id does not register or does not report `wasOpenedAtLogin` | Real-Mac check 1 fails | Default-on stays off; Settings explains the manual step; the window showing at login is cosmetic. Developer ID in M11. |
| User unticks calendar access on Google's consent screen | Connect fails | `424` with "Connect again and tick 'View events on all your calendars'". |
| Last-minute changes | A prompt for a cancelled call, or none for a call added 1 min before | Fresh check before showing; 5-min poll; manual start and M2's detection still link (one clear match). |
| Solo blocks prompt, or a real call does not | Prompts for Focus blocks; `missed` rows with `policy` | Conference-data links alone are not evidence; typed links are; tune in `reminderPolicy.ts` from the log. |
| Travel across time zones | Today list off until the renderer reloads | Prompts run on instants; grouping happens in the renderer, which follows the macOS zone; the 72 h window covers today in any zone. |
| Conflicts with M2, M3 and M4 on shared files | Merge conflicts | `phase-2-build-order.md` section 3.1; the fixed Alembic chain (`0004`); small, separate files for everything M5-only (`calendar.sqlite`, `shared/ipc/{prompt,calendar,loginItem}.ts`). |
| Two prompts for one call (M2 detection and M5 calendar) | Double panel; a call stored as `call_detected` | One `PromptService.offer` with the D5 rules; M2-T17b and M2-T20b changed on 2026-10-06. |
| The shell (M4-S1 to S4b) is late | M5 screens not in the sidebar | Only T13 waits for it; the shell is scheduled in waves 1 to 3. |
| Secrets in error text | A token or the key in a log line | `hide_parameters=True`; the DB-error test; the happy-path log test. |
| Notice wording is not enough legally | Legal review before Gate 2 | D3; the text is a setting, so changing it needs no release. |
| Dev and packaged builds share the app name | A dev run registers Electron.app at login, quits at once, or shares the SQLite files | `loginItemPolicy` refuses when not packaged; dev `userData` is "Roger Dev", set before the lock; tests pin both; failure-log line. |

## Exit check log

Not run yet.

## Review

Engineer: pending.
