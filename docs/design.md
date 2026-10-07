# Roger: design system

Creed: **"Less, but better"** (Dieter Rams). Roger's job is to keep a call and give back clean
notes; the screen should feel like paper with one pen on it. Warm paper neutrals, one burnt-orange
accent, generous space, no decoration. **Your words are the loudest thing on every page**: your
notes, then the transcript, then the AI notes. Chrome is quiet; status is quiet until it matters.

This is the Course Player system (`~/Developer/course-player/docs/design.md`) adopted for Roger:
same method, same palette, tuned by hand for this app. It applies to every screen now and to all
future design work. The removal list and build order for the first pass: `docs/plans/redesign.md`.

**Rules that win every argument, in order.**

1. **Clarity of the next action.** One primary (accent-filled) button per view, and which one it
   is changes with the moment (table under Components).
2. **Honesty.** Success shows only after real success. A state is named truthfully. House rule 1
   holds on every screen: the person always sees when a call is not being saved.
3. **Respect for attention.** Details on demand: a click, hover or focus away, never on the page by
   default. Delete what nobody acts on or reads; do not CSS-hide it.
4. **Calm.** Problems are ink text, an icon and plain words, never a red box. Nothing blinks,
   pulses or bounces.
5. **Consistency.** One token set, one type scale, one spacing ladder, one radius set, one word
   per concept (Naming list).
6. **Access.** AA contrast on every surface in both themes, `:focus-visible` everywhere, status
   never by colour alone, keyboard for everything, motion off under reduced motion.
7. **Delight** only where it means something (a call kept, notes written).

Subtract before you add. A review round is about removing.

## Rahul's answers (2026-10-07, verbatim)

- Accent: same warm paper + burnt-orange as Course Player.
- Themes: both light and dark, each tuned by hand.
- Main action: Home = one "Start notes" button + today's meetings. Meeting page = your notes are
  loud; transcript and AI notes sit one click away. The one primary button changes with the
  moment: Start → Stop → "Write notes".
- Timing: now, lean (…; one screenshot check at the end). The elided part names models, which
  this repo's docs never do.

## Colour tokens

Every colour lives in `apps/desktop/src/renderer/src/theme/tokens.css` as an OKLCH custom
property, in three blocks: light (`:root`), macOS dark (`@media (prefers-color-scheme: dark)
:root:not([data-theme='light'])`) and forced dark (`:root[data-theme='dark']`). The two dark blocks
are identical. Components read `var(--name)`; a literal colour anywhere else in the renderer is a
bug, and `noLiteralColours.test.ts` fails on it.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `canvas` | `0.985 0.004 80` | `0.17 0.006 70` | page background |
| `surface` | `0.995 0.002 80` | `0.21 0.007 70` | inputs, the rare card. Dark: lighter = higher |
| `raised` | `0.995 0.002 80` | `0.25 0.008 70` | menus, dialogs, the prompt panel's card |
| `fill` | `0.955 0.006 80` | `0.26 0.008 70` | hover wash, citation chips, the tab track |
| `sunken` | `0.955 0.006 80` | `0.20 0.007 70` | a recessed panel inside a dialog. Dark: darker than `raised`, or it vanishes |
| `control` | `0.995 0.002 80` | `0.34 0.008 70` | the selected tab in the tab track |
| `line` | `0.90 0.008 80` | `0.30 0.008 70` | hairlines (low contrast on purpose) |
| `ink` | `0.22 0.01 70` | `0.93 0.008 80` | primary text, problem text |
| `ink-muted` | `0.45 0.012 70` | `0.72 0.01 75` | secondary text, icons, ghost buttons |
| `ink-subtle` | `0.52 0.012 70` | `0.66 0.01 75` | tertiary TEXT: times, offsets, interim words, echo lines |
| `accent` | `0.56 0.17 42` | `0.72 0.16 50` | FILL only: the primary button, the recording dot, focus |
| `accent-hover` | `0.52 0.165 41` | `0.76 0.15 52` | the primary button under the pointer |
| `on-accent` | `0.99 0.005 80` | `0.18 0.02 50` | text and icons on an accent fill. Dark: DARK ink |
| `accent-ink` | `0.48 0.15 40` | `0.80 0.13 55` | accent-hued TEXT: a link, the "check" mark on a cited AI line |
| `accent-soft` | `0.95 0.035 55` | `0.29 0.05 50` | the one tint: the transcript line a chip revealed, text selection |
| `ring` | = `accent` | = `accent` | focus ring |
| `scrim` | `0.22 0.01 70 / 0.4` | `0.08 0.004 70 / 0.6` | dialog backdrop |
| `e1`, `e2`, `e3` | shadows, see Elevation | | they hold colour, so they live here |

Hand-tuned from Course Player, each for a pairing Roger paints and Course Player does not:
light `ink-subtle` 0.53 → 0.52 (a timestamp on the revealed line read 4.51:1 on `accent-soft`);
dark `ink-subtle` 0.64 → 0.66 (4.25:1 on `accent-soft`, a fail); dark `control` 0.36 → 0.34
(`ink-muted` read 4.38:1 on it, a fail).

There is no red, amber or green. Stop is the accent fill. A problem is `ink` text with an icon.
A good state is words ("Saved on this Mac"), never a green dot.

### Pinned pairings (measured, WCAG 2, floored to one decimal)

`tokens.test.ts` computes every one of these from the OKLCH values and fails under 4.5:1 for text
or 3:1 for the non-text rows. Add a row before you paint a new pairing.

| Text | On | Light | Dark |
| --- | --- | --- | --- |
| `ink` | canvas · surface · raised · fill · sunken · control · accent-soft | 16.5 · 17.0 · 17.0 · 15.2 · 15.2 · 17.0 · 14.7 | 15.5 · 14.4 · 13.0 · 12.6 · 14.7 · 9.5 · 11.6 |
| `ink-muted` | the same seven | 7.1 · 7.3 · 7.3 · 6.5 · 6.5 · 7.3 · 6.3 | 7.7 · 7.1 · 6.4 · 6.2 · 7.3 · 4.7 · 5.7 |
| `ink-subtle` | canvas · surface · raised · fill · sunken · accent-soft | 5.2 · 5.4 · 5.4 · 4.8 · 4.8 · 4.7 | 6.1 · 5.6 · 5.1 · 4.9 · 5.8 · 4.6 |
| `accent-ink` | canvas · surface · raised · fill · accent-soft | 6.7 · 6.9 · 6.9 · 6.1 · 5.9 | 9.9 · 9.1 · 8.2 · 8.0 · 7.4 |
| `on-accent` | accent · accent-hover | 4.8 · 5.7 | 7.2 · 8.4 |
| `accent`, `ring` (3:1, non-text) | canvas · surface · raised · fill | 4.8 · 4.9 · 4.9 · 4.3 | 7.3 · 6.7 · 6.1 · 5.9 |

`line` is decorative (1.3:1) and never the only edge of a control: an input's border is `line`
plus its own `surface` against `canvas`, and focus adds `ring`.

### Rename table (old token → new; mechanical, then the screen tasks finish)

| Old | Reads | Becomes now | Then |
| --- | --- | --- | --- |
| `--bg` | 6 | `--canvas` | |
| `--panel` | 21 | `--surface` | most cards go; inputs, menus keep it |
| `--ink` | 44 | `--ink` | |
| `--muted` | 66 | `--ink-muted` | times and offsets move to `--ink-subtle` |
| `--line` | 42 | `--line` | |
| `--accent` | 21 | `--accent` (burnt orange) | fills only |
| `--on-accent` | 8 | `--on-accent` | dark value is dark ink now |
| `--accent-ink` | 6 | `--accent-ink` | |
| `--focus-ring` | 12 | `--ring` | |
| `--danger` | 11 | `--accent` | Stop is the primary; nothing else is filled |
| `--danger-ink` | 15 | `--ink` | plus an icon (Components, Problem line) |
| `--danger-bg` | 10 | `--fill` | deleted: problems have no box |
| `--warn` | 11 | `--ink-muted` | deleted with the words that replace it |
| `--warn-bg` | 8 | `--fill` | deleted |
| `--ok` | 6 | `--ink-muted` | deleted: a good state is words |
| `--ok-bg` | 2 | `--fill` | deleted |
| `--interim-ink` | 1 | `--ink-subtle` | |
| `--hidden-ink` | 2 | `--ink-subtle` | echo lines also carry the word "echo" |
| `--cited-bg` | 1 | `--accent-soft` | |
| `--recording` | 2 | `--accent` | a static dot plus the word "Recording" |
| `--sidebar-bg` | 1 | `--fill` | deleted with the sidebar |
| `--chip-bg` | 15 | `--fill` | |
| `--conflict-bg` | 1 | `--fill` | deleted: the conflict line is a problem line |
| (new) | | `--raised`, `--fill`, `--sunken`, `--control`, `--ink-subtle`, `--accent-hover`, `--accent-soft`, `--scrim`, `--e1`, `--e2`, `--e3` | |

## Type

System stack: `-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif` (SF Pro,
no font files; the prompt panel uses the same). Weights 400 and 600; 500 for buttons. No 650 or
700. Times, offsets and counters that tick or sit in a column use `font-variant-numeric:
tabular-nums`. Reading text (notes, AI notes, transcript, chat) is capped at 68ch.

| Step | px / line-height | Use |
| --- | --- | --- |
| `--text-xs` | 12 / 16, +0.06em caps | overlines (TODAY, EARLIER, NEXT), Details labels; uncapped for transcript offsets and chips |
| `--text-sm` | 14 / 20 | UI text, list rows, transcript lines, chat, helper text, small buttons |
| `--text-base` | 16 / 24 | the notes editors, buttons, dialog body |
| `--text-lg` | 18 / 28 | headings inside notes, Settings section titles |
| `--text-xl` | 20 / 28 | dialog titles |
| `--text-2xl` | 24 / 30, −0.015em | the meeting title, Home's next meeting |
| `--text-3xl` | 30 / 36, −0.02em | page titles: Settings, Set up Roger |

## Space, size, radius

The 4 px ladder only: `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-6`
24 · `--space-8` 32 · `--space-12` 48 · `--space-16` 64 · `--space-24` 96. More space between
groups than inside them. Fewer containers: whitespace and 1 px `line` hairlines, never a card
inside a card. The window opens 520 × 760 (`main/window.ts`, min 420): design at 520 first. Page
gutter 16 px under 720 px wide, 32 px above; Home and Settings sit in a 720 px column, the meeting
page in a 760 px one (68ch of 16 px text plus its gutters). One breakpoint: 720 px.

Radius: `--radius-md` 8 px (buttons, inputs, chips, menu items), `--radius-lg` 12 px (menus,
dialogs, the prompt card), `--radius-full` (the recording chip, dots). Never square and rounded
side by side.

## Elevation (role-based; dark mode leans on lighter surfaces)

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--e1` | `0 1px 2px ink/6%, 0 1px 3px ink/10%` | `0 1px 2px oklch(0 0 0 / 0.3)` | the primary button, the selected tab |
| `--e2` | `0 4px 8px ink/8%, 0 2px 4px ink/6%` | `0 4px 12px oklch(0 0 0 / 0.35)` | menus, the prompt card |
| `--e3` | `0 16px 32px ink/14%, 0 4px 8px ink/6%` | `0 16px 40px oklch(0 0 0 / 0.5)` | dialogs |

`ink` above is `oklch(0.22 0.01 70 / a)`.

## Motion

Motion explains a change; it never decorates. Only `opacity` and `transform` animate. Entrances
`--ease-out: cubic-bezier(0.22, 1, 0.36, 1)`; exits `--ease-in: cubic-bezier(0.4, 0, 1, 1)` at
about 70 % of the entrance. No bounce. Anything that can be on screen at first paint animates
from a visible state (`arrive` starts at 40 % opacity) with `backwards` fill. No colour
transition on a state indicator (the recording dot, a tab, a save state, the revealed line): a
screenshot catches it mid-fade. Under `prefers-reduced-motion: reduce`, `styles.css` zeroes every
duration and delay, and JS smooth scrolling asks `matchMedia` first. Success stays until read;
it is never a sub-second flash.

| Moment | What moves | Spec |
| --- | --- | --- |
| Hover, press on buttons and rows | background, opacity | 150 ms ease-out |
| A menu opens (⋯, Write again as) | opacity + 4 px rise from 0.98 scale | `pop-in` 200 ms; closes 140 ms ease-in |
| The Details or a confirm dialog | card rises (opacity + 12 px + 0.985 scale), scrim fades | `rise` 260 ms; `leave` 180 ms ease-in |
| A problem line arrives | opacity from 40 % + 4 px | `arrive` 300 ms; leaves 200 ms ease-in |
| A transcript line or streamed AI text arrives | nothing | text arrives at speaking pace; motion would never stop |
| An interim word turns final | nothing | `ink-subtle` → `ink` at once |
| A tab is picked | nothing | panes swap at once; they stay mounted (Traps) |
| A chip reveals its transcript line | scroll to centre; a static `accent-soft` tint | smooth scroll unless reduced motion; the tint never fades |
| Copy notice → "Copied" | the label swaps | stays until the line is dismissed |
| Recording | nothing | the dot is static |

## Components (one primary per view)

- **Buttons.** `.btn` with `data-variant`: `primary` (accent fill, `on-accent`, `--e1`, hover
  `accent-hover`), `secondary` (`surface`, 1 px `line`, `ink`), `ghost` (no fill, `ink-muted`,
  `fill` on hover). `data-size` `sm` 32 / `md` 40 / `lg` 48 px; `lg` only for Home's Start notes.
  Label first, verb first. Icons 16 px, stroke 1.5, `currentColor`.
- **Busy is not disabled.** A busy button keeps its full colour, says what it is doing
  ("Stopping…"), sets `aria-disabled="true"` and takes no clicks. `disabled` only means "nothing to
  do", and then the reason shows once, beside it.
- **Focus.** `outline: 2px solid var(--ring); outline-offset: 2px` on `:focus-visible`; inset
  (`-2px`) inside anything that scrolls or clips (the transcript, the chat log, menus).
- **Recording chip.** `--radius-full`, secondary look: a static 8 px accent dot, the word
  "Recording" and the elapsed time ("12m", tabular, updated every 15 s: a seconds counter is
  motion that never stops). In the app header on every page but the live meeting's own; a click
  opens that meeting. Its accessible name says it all: "Recording, 12 minutes".
- **Status line** (meeting header, while recording). "Recording · 12m · Details". A loud
  problem takes the line's place, in words ("Roger can't hear the call · since 4:59 pm"), so the
  editor below never moves. "Details" opens the Details dialog.
- **Problem line.** A 16 px icon (`ink`) + one sentence in `ink` + at most one secondary action.
  Loud: `role="alert"`, weight 600, top of the page. Quiet: `role="status"`, `ink-muted`. No box,
  no tint. It says what happened and what to do.
- **Tabs.** A segmented track (`fill`) with the selected tab on `control` + `--e1`, text `ink`;
  the others `ink-muted`. Arrow keys move between tabs. Never more than four.
- **Menu.** `raised`, `--radius-lg`, `--e2`; 32 px rows, ghost style. Holds what is used rarely
  (Write again as, Restore previous notes).
- **Dialog.** `raised`, `--e3`, max 512 px, over `scrim`; a `sunken` panel for a summary inside
  it. Esc and the × close it. Destructive steps confirm in place ("Delete audio?" then the same
  button reads "Delete").
- **Lists.** Rows show a title and one quiet fact (a time in `ink-subtle`, tabular, in a fixed
  left column). No badges, counts, progress bars or cards. A row's action appears on hover and
  focus in a fixed right column, so nothing moves.
- **Citation chip.** `fill`, `ink-muted`, 12 px tabular offset, `--radius-md`. A line the model
  flagged adds the word "check" in `accent-ink`.
- **Inputs.** 40 px, `surface`, 1 px `line`, `--radius-md`, `ring` on focus. Settings save on
  change or blur: no Save buttons. Checkboxes and radios are native with `accent-color:
  var(--accent)`.
- **Empty states are absent.** An empty list is no list. A placeholder in an input may say what
  goes there. No "Nothing here yet" panels.
- **Loading.** Nothing for a read that answers within a frame or two (main's reads do); a quiet
  "Loading…" line only where a network read can take seconds.

### The one primary, per screen and moment

| Screen | Moment | Primary | The rest |
| --- | --- | --- | --- |
| Home | idle | **Start notes** (`lg`); for the next meeting when it starts within 10 minutes or is on now, else a blank note | Connect Google Calendar (secondary), a row's Start notes on hover (ghost), Settings (ghost icon) |
| Home | recording | **Stop** (the live meeting shown above it) | the meeting title opens it |
| Meeting | starting | **Starting…** (busy) | |
| Meeting | recording | **Stop** | Copy notice (secondary), Details (ghost) |
| Meeting | stopping | **Stopping…** (busy) | |
| Meeting | stopped, no AI notes | **Write notes** | ⋯ menu |
| Meeting | writing | **Writing notes…** (busy) | Cancel (ghost) |
| Meeting | AI notes written | none: the notes are the loud thing | ⋯ menu: Write again as, Restore previous notes |
| Meeting | a past meeting while another records | none | |
| Settings | calendar not connected | **Connect Google Calendar** | |
| Settings | otherwise | none | Disconnect (ghost) |
| Set up Roger | a check fails | **the first failing check's fix** (Allow microphone, Test call audio, Relaunch Roger) | other fixes secondary |
| Set up Roger | all pass | **Done** | |
| Prompt panel | a meeting with a video link | **Join and start notes** | Start notes (ghost), Dismiss (ghost) |
| Prompt panel | no link, or a call detected | **Start notes** | Dismiss (ghost) |
| Prompt panel | taking notes | none | Open Roger (ghost) |
| Details dialog | | none | Transcribe again (secondary), Delete audio (ghost, confirms) |

## Copy

- Plain short words; sentence case; no full stop on a button or label. Labels say what happens,
  verb first: Start notes, Stop, Write notes, Copy notice, Transcribe again.
- Helper text explains a limit once, where it bites ("Up to 100 terms" only once the list nears
  it). One message says a thing once: never the same fact in a banner and a card.
- No internals outside Details: no ids, no "Postgres", "helper", "worklet", "stream", "API",
  "SQLite". Main's messages that carry them get a short title per kind in the renderer.
- A problem says what happened, then what to do: "Roger can't hear the call. Check the call plays
  on this Mac." Never "Error:", never blame.
- Clock times are 12-hour, lowercase: "9:14 am", never "09:14" or "9:14 AM". Durations "1h 23m".
  Transcript offsets "4:07", "1:02:05" over an hour. Dates "Wed 7 Oct".
- Confirm what mattered, truthfully: "Notes written", "Notice copied". "Saved" is not news.

### Naming list (one word per concept; goes into `CLAUDE.md`)

| Roger says today | Say |
| --- | --- |
| New note, Take notes, Start notes now, Join and take notes | **Start notes**; with a video link **Join and start notes** |
| Stop, Stop note, Stop recording, Stop current note and start | **Stop**; a start that ends another note says so once below the button: "Stops notes on Weekly sync" |
| Recording, Taking notes, Transcribing, "Roger: taking notes" | **Recording** (the state); Transcribing only inside Details |
| meeting, call, note (for the record), recording (noun) | **meeting** for what Roger keeps; **call** only for the live audio ("call audio", "the call") |
| My notes, Notes, notepad | **My notes** |
| AI notes, clean notes, generated notes | **AI notes** |
| Generate notes, Write AI notes | **Write notes** |
| Regenerate, Regenerate as which kind of call | **Write again as** |
| kind of call, template, meeting type | **template** (menus only) |
| Jargon list, vocabulary, keyterms, names | **Jargon list**; one entry is a **term** |
| Synced, Syncing, Saving…, Saved, Offline: saved on this Mac | nothing when saved; **Saved on this Mac** when offline; **Not saved** with the reason when it failed on this Mac; **Not saved to Roger** with the reason when the server refused the upload |
| Postgres, Roger server, the API | **Roger's server** (Details and Setup only) |
| Mic (me), Microphone | **microphone**; the transcript speaker is **Me** |
| Call audio (them) | **call audio**; the transcript speaker is **Them** |
| Retry, Try again, Ask again | **Try again** |
| Check again, Test again | **Check again** |
| Dismiss, Not now; Cancel (to close a notice) | **Dismiss** to close a notice; **Cancel** only to back out of something in progress |
| Re-run, re-transcribe, gap re-run | **Transcribe again** |
| Capture status, Capture report, capture details | **Details** |
| Recent | **Earlier** (Home's past meetings); **Today** (Home's calendar) |
| Untitled meeting, "Meeting 7 Oct 2026 17:01" | **Meeting at 5:01 pm** |
| Open Google again, Reconnect Google Calendar | **Connect Google Calendar**, **Reconnect** |
| Delete this meeting's audio | **Delete audio** |
| Set up Roger, setup, permissions | **Set up Roger** |

## Traps

- `theme/tokens.test.ts` reads only `#rrggbb` values and `rgb(r g b / a)` tints: an OKLCH token
  makes its `colour()` throw. Port JS Journey's `oklchToLinearRgb` (`~/Developer/js-journey/
  tests/theme-contrast.test.ts`); its output is already linear light, so luminance takes it with
  no gamma step. Its `PLANNED_TOKENS` pins the old names: replace it with this file's list. Its
  "hold nothing but colours" check allows any `--` property, so keep only colour tokens and the
  shadows (they hold colour) in `tokens.css`; space, type, radius and motion go in `styles.css`.
- Dark is written twice and the test compares the blocks: a hand-tuned dark value goes in both.
- Fill versus ink (`apps/desktop/CLAUDE.md`, M4-S2): one colour cannot be both a fill and text.
  `--accent` is a fill; accent-hued text reads `--accent-ink`. In dark the fill is a LIGHT orange
  under DARK `--on-accent`: an icon on the primary button is `currentColor`, never white.
  `tokens.test.ts` "never colour text with a fill token" keeps checking `color: var(--accent)`.
- An undefined `var(--old)` paints nothing and fails no test: after the rename a missed
  `var(--muted)` inherits its parent's colour in silence. A test fails on any `var(--x)` in the
  renderer that `tokens.css` or `styles.css` does not define.
- `noLiteralColours.test.ts` scans CSS, TS strings and HTML or SVG attributes: an inline icon
  uses `stroke="currentColor"`; a pasted SVG with `#000` fails the gate.
- "Subtle" is still text: `ink-subtle` failed AA in dark on `accent-soft` (4.25:1) before the
  tuning. Measure every text token on every surface it sits on after any colour change; the
  revealed transcript line is the Roger-only pairing.
- `fill` on `raised` vanishes in dark (Course Player's trap): a panel inside a dialog is `sunken`.
- Moving the capture status behind Details must not hide a call that is not being saved (house
  rule 1). A save failure reaches the page as `CaptureStatus.error` (the banner keeps it), and loud
  warnings keep `role="alert"` and main's macOS notification. But lines the server refused for
  good (`upload.rejected`) show today only in StreamStatus's "Postgres" row: derive a problem line
  from it, test first, before that row goes.
- A problem that appears mid-call must not move the editor under the person's cursor: on the
  meeting page loud problems take the header's status line, which always holds one line while
  recording.
- Tabs hide panes with `hidden`, never unmount them: the editor keeps unsaved text and save
  timers, and the citation navigator finds a chip's line in a hidden transcript (`regions.tsx`).
  CSS that sets `display` on an element with `hidden` overrides it: add `[hidden] { display:
  none }` beside it. A pane that is a grid row scrolls inside itself (M4-T20).
- Busy Stop today is `disabled={busy}` with `opacity: 0.55`: it reads as "can't". Busy is
  `aria-disabled` with full colour.
- Times: `formatClockTime` follows the Mac's 12 or 24 hour setting, and six more formatters
  exist (`calendarFormat.ts`, `meetingTimes.ts`, `promptFormat.ts`, main's `stopReasons.ts`,
  `CaptureService.ts`, `trayMenu.ts`). One renderer helper with `hourCycle: 'h12'`, built per
  call (an `Intl.DateTimeFormat` keeps the zone it was made in); main follows the same rule.
- The default title "Meeting 6 Oct 2026 09:30" is parsed by `shared/suggestTemplate.ts` to
  remember templates per title: a new default title needs that pattern changed, and old meetings
  keep the old form, so it must read both.
- The prompt panel is its own page (`prompt.html`): it imports `tokens.css` itself, its body
  stays transparent (the window is), and it has no `useTheme`, so it follows macOS even when the
  `theme` preference forces one.
- Unit tests pin copy and class names (`renderToStaticMarkup` output: "New note", "Regenerate",
  "Copy notice", `button stop`), and QA scripts select by class. Rename a word or class and its
  test in one commit. A test of a deleted component goes with it; a test of a behaviour that
  stays is kept, never skipped.
- A shared type change (a preference key, a prompt card kind) breaks `preview/fakeRoger.ts` and
  every test double typed as the whole type, in files the task does not own (M2-T2, M3-T4a).
- `scrollIntoView({ block: 'start' })` puts a line under a sticky header: centre it.
