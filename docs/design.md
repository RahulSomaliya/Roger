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
| `fill-raised` (sweep, built by T0) | = `fill` | lighter than `raised`, about `0.31 0.008 70` | hover and pressed wash on a `raised` surface (menu rows, the prompt card's ghost buttons): `fill` vanishes there in dark |
| `edge` (sweep, built by T0) | = `line` | about `0.36 0.008 70` | the 1 px edge of a floating surface over another app (the prompt card), where the system shadow cannot show in dark |

Added by the redesign sweep (2026-10-08, `docs/plans/redesign-sweep.md`): the two rows above. T0
measures them, pins `ink` and `ink-muted` on `fill-raised` in the pairings table and writes both dark
blocks; the values here are its starting point.

Hand-tuned from Course Player, each for a pairing Roger paints and Course Player does not:
light `ink-subtle` 0.53 → 0.52 (a timestamp on the revealed line read 4.51:1 on `accent-soft`);
dark `ink-subtle` 0.64 → 0.66 (4.25:1 on `accent-soft`, a fail); dark `control` 0.36 → 0.34
(`ink-muted` read 4.38:1 on it, a fail).

There is no red, amber or green. Stop is the accent fill. A problem is `ink` text with an icon.
A good state is words ("Saved on this Mac"), never a green dot.

### Pinned pairings (measured, WCAG 2, every ratio floored to one decimal)

`tokens.test.ts` computes every one of these from the OKLCH values and fails under 4.5:1 for text
or 3:1 for the non-text rows. Add a row before you paint a new pairing.

| Text | On | Light | Dark |
| --- | --- | --- | --- |
| `ink` | canvas · surface · raised · fill · sunken · control · accent-soft | 16.5 · 17.0 · 17.0 · 15.1 · 15.1 · 17.0 · 14.7 | 15.5 · 14.4 · 13.0 · 12.6 · 14.7 · 9.5 · 11.6 |
| `ink-muted` | the same seven | 7.1 · 7.3 · 7.3 · 6.5 · 6.5 · 7.3 · 6.3 | 7.7 · 7.1 · 6.4 · 6.2 · 7.2 · 4.7 · 5.7 |
| `ink-subtle` | canvas · surface · raised · fill · sunken · accent-soft | 5.2 · 5.4 · 5.4 · 4.8 · 4.8 · 4.7 | 6.1 · 5.6 · 5.1 · 4.9 · 5.8 · 4.5 |
| `accent-ink` | canvas · surface · raised · fill · accent-soft | 6.7 · 6.9 · 6.9 · 6.1 · 5.9 | 9.8 · 9.1 · 8.2 · 8.0 · 7.4 |
| `on-accent` | accent · accent-hover | 4.8 · 5.7 | 7.2 · 8.4 |
| `accent`, `ring` (3:1, non-text) | canvas · surface · raised · fill | 4.7 · 4.9 · 4.9 · 4.3 | 7.3 · 6.7 · 6.1 · 5.9 |

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
inside a card. The window opens landscape, about 1080 × 730 (min 420 × 520): design at 1080
first, then check 420. The page grid has three widths (Window and layout, below); the meeting
page's column is 760 px (68ch of 16 px text plus its gutters) at every width above 720. (Changed by
the redesign sweep, 2026-10-08: the rule was "520 × 760, design at 520 first". Until task T3 of
`docs/plans/redesign-sweep.md` lands, `main/window.ts` still opens 520 × 760.)

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
| A prompt card arrives (sweep) | opacity 0 → 1, `translateX(12px)` → 0 | `slide-in` 240 ms ease-out, after the window shows |
| A prompt card leaves (sweep) | opacity → 0, `translateX(12px)` | 170 ms ease-in; main hides the window only after the page reports height 0, 400 ms fallback |
| A page changes (sweep) | nothing | pages swap at once; focus moves to the new page's `h1` |

## Components (one primary per view)

- **Buttons.** `.btn` with `data-variant`: `primary` (accent fill, `on-accent`, `--e1`, hover
  `accent-hover`), `secondary` (`surface`, 1 px `line`, `ink`), `ghost` (no fill, `ink-muted`,
  `fill` on hover). `data-size` `sm` 32 / `md` 40 / `lg` 48 px; `lg` only for Home's Start notes.
  Label first, verb first. Icons 16 px, stroke 1.5, `currentColor`.
- **Busy is not disabled.** A busy button keeps its full colour, says what it is doing
  ("Stopping…"), sets `aria-disabled="true"` and takes no clicks. `disabled` only means "nothing to
  do", and then the reason shows once, beside it.
- **Focus.** `outline: 2px solid var(--ring); outline-offset: 2px` on `:focus-visible`; inset
  (`-2px`) inside anything that scrolls or clips (menus, the tab track). Large reading and writing
  regions (the transcript log, the chat log, My notes) never draw a box: keyboard focus there is a
  2 px `--ring` line along the region's left edge, and My notes shows its caret and nothing else
  (added by the redesign sweep; Rahul, 2026-10-08, on the orange box around the transcript: "that
  weird highlight ring, lets remove it").
- **Recording chip.** `--radius-full`, secondary look: a static 8 px accent dot, the word
  "Recording" and the elapsed time ("12m", tabular, updated every 15 s: a seconds counter is
  motion that never stops). In the app header on every page but the live meeting's own; a click
  opens that meeting. Its accessible name says it all: "Recording, 12 minutes".
- **Status line** (meeting header, while recording). "Recording · 12m". A loud problem takes the
  line's place, in words ("Roger can't hear the call · since 4:59 pm"; with two streams in
  trouble it names the first and adds "· +1 more"), so the editor below never moves. Details is
  a ghost button among the header's actions (beside Stop, Write notes and the ⋯ menu), not part of
  the line.
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
  flagged adds the word "check" in `accent-ink`. The offset is the API's own `label` (`mm:ss`,
  "00:15", `h:mm:ss` past an hour: `docs/api-contract.md`, the citation node), stored in the notes
  doc and shown as it is. Transcript offsets are written "4:07", so one moment reads two ways on
  the Notes and Transcript tabs. That is deliberate: the chip's label is part of the contract and
  of every doc already stored, and the renderer does not rewrite it.
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
| Meeting | stopped, no AI notes | **Write notes** | Details (ghost); the ⋯ menu only once AI notes exist |
| Meeting | writing | **Writing notes…** (busy) | Cancel (ghost) |
| Meeting | AI notes written | none: the notes are the loud thing | ⋯ menu: Write again as, Restore previous notes |
| Meeting | a past meeting while another records | none | |
| Settings | calendar not connected | **Connect Google Calendar** | |
| Settings | connected, Google refused or is about to expire the grant | **Reconnect** | Disconnect (ghost) |
| Settings | otherwise | none | Disconnect (ghost) |
| Set up Roger | a check fails | **the first failing check's fix** (Allow microphone, Open Microphone settings, Open System Audio settings, Check again, Relaunch Roger) | other fixes secondary; **Later** (ghost) is the way out, there is no header |
| Set up Roger | all pass | **Done** | Later is gone |
| Prompt panel | a meeting with a video link | **Join and start notes** | Start notes (ghost), Dismiss (× icon, top right; sweep) |
| Prompt panel | no link, or a call detected | **Start notes** | Dismiss (× icon, top right; sweep) |
| Prompt panel | taking notes | none | Open Roger (ghost) |
| Settings | Appearance (sweep) | none | System · Light · Dark, a segmented control |
| Details dialog | | none | Transcribe again (secondary), Delete audio (ghost, confirms) |

## Window and layout (added by the redesign sweep, 2026-10-08)

The redesign designed the pages and skipped the window around them. These rules cover it; the
build is `docs/plans/redesign-sweep.md` (T3 to T6). Decisions D1, D2 and D6 there are Rahul's; the
rules below are written with their pre-filled picks and change if he picks otherwise.

- **The window.** Opens about 1080 × 730, clamped to the work area less 48 px each way, centred on
  the display under the cursor; minimum 420 × 520. It remembers its bounds per Mac and restores them
  only onto a connected display. Its `backgroundColor` is the theme's `canvas`, so nothing flashes at
  show or resize.
- **Title bar (D1).** No system title bar row: `hiddenInset`, the traffic lights inside the header
  row. The header is the window's drag region; every control in it is `no-drag`; its left 80 px hold
  nothing but the lights.
- **Page grid.** Three widths: 960 px and up (the landscape window): 48 px gutter, Home, Settings and
  Set up Roger 880 px, the meeting page 760 px; 720 to 959: 32 px gutter, 720 px and 760 px; under
  720: 16 px gutter, full width. Content starts at the column's left edge; a column narrower than
  the window is centred, and the full-width header above it is what makes the side space read as
  margins, not emptiness.
- **Home at 960 and up (D2).** Two top-aligned columns, 64 px apart: the hero (overline, title,
  hours, Start notes) and the calendar line or Connect on the left; Today, then Earlier on the right
  (360 px). With nothing in either list the right column is absent. Under 960 they stack.
- **The meeting page** keeps one column and one tab row at every width. Its panes span the column, so
  their right edge is the header actions' right edge; reading text is capped at 68ch inside them. A
  busy state that adds a control (Cancel) adds it on the LEFT of the primary, so the primary never
  moves under the pointer.
- **Settings at 720 and up.** Rows in two columns: a 240 px label column (label 600, helper
  `ink-muted`) and the control. Under 720 they stack.
- **A page that fails to draw** is replaced, under the header and the banner, by one problem line and
  Reload (secondary): Stop and the recording chip stay one click away.

## Navigation (added by the redesign sweep, 2026-10-08)

Every place is one step from Home and one step back. Rahul: "I don't have a way to go back to home
screen".

- **The header, every page.** Left: on Home the wordmark "Roger" as text; on every other page **‹
  Home** (ghost `sm`: the `arrow-left` icon and the word Home; the "‹" in these docs stands for the
  icon). Right: the recording chip (not on the live meeting's
  own page), then Settings (ghost icon). The current place is shown by more than colour: the gear on
  Settings has the `fill` wash and `aria-current="page"`. With D6, Set up Roger has the header too.
- **Keyboard.** Cmd+[ goes Home from anywhere (every page is one level under Home, so Back is Home);
  Escape does the same on Settings and Set up Roger when focus is not in a text field, never on the
  meeting page (it would leave the notes mid-sentence); Cmd+, opens Settings; Cmd+N starts notes. Stop
  has no shortcut: ending a recording is a click.
- **The app menu** names every place: Roger › Settings…, Set up Roger…; File › Start notes, Stop;
  Go › Home. The shipped build has no Reload, Force Reload or Developer Tools (Cmd+R mid-call reloads
  the page that captures audio).
- **Focus** moves to the new page's `h1` on every navigation; the window title names the page.
- **Settings holds what a person comes for**, in this order: Appearance, Calendar, Jargon list, Mac
  (Open Roger at login, Open Set up Roger). Nothing a person sets lives only in the app menu.

## Appearance (added by the redesign sweep, 2026-10-08)

- Settings' first section: **Appearance**, a segmented control **System · Light · Dark** (a
  `radiogroup` in the tab track's look; arrow keys move and choose), saved on change.
- Main applies the `theme` preference with `nativeTheme.themeSource`, so the main window, the prompt
  panel, menus, dialogs and scrollbars change together. The prompt panel needs no theme code of its
  own: it follows `prefers-color-scheme`, which `themeSource` sets. (This replaces the Trap "it follows
  macOS even when the `theme` preference forces one" once T3 lands.)

## Prompt panel (added by the redesign sweep, 2026-10-08)

The top-right meeting alert: one question, answered in one click or ignored, in Home's words. It
never takes focus (a non-activating panel), so its keyboard path is Cmd+N and the menu bar.

- **Window.** 360 px wide, 16 px from the top and right of the work area of the display under the
  cursor; height follows its cards, top edge anchored; cards stack newest first with 8 px transparent
  gaps; the system shadow, refreshed with `invalidateShadow()` after every resize.
- **Card.** `raised`, `--radius-lg`, 1 px `edge`, 16 px padding. Overline (12 px caps, `ink-muted`):
  "Roger · Starting in 1 min" (Home's `startLabel`); title 16/24 600, two lines then an ellipsis;
  hours 14/20 `ink-subtle`, "3:27 pm to 3:57 pm"; 12 px, then the buttons (`sm`). Dismiss is an ×
  icon button (32 px, accessible name "Dismiss") at the top right. A call Roger noticed: "Roger ·
  Now", title "Call in Zoom". After a start, for 5 s: one row, the static dot, "Recording · <title>",
  Open Roger. Another meeting recording: "Stops notes on Weekly sync" under the buttons.
- **Failures** are a loud problem line between the hours and the buttons, in plain words; never
  main's or a vendor's text.
- **Lifetimes.** A calendar card from start − lead until 10 min after the start; a call card 10 min;
  the Recording row 5 s.
- **Motion.** In the Motion table: `slide-in` 240 ms, out 170 ms; main waits for the page's exit
  before it hides the window.
- **QA** shoots it at its real place (top right of a display frame, under a menu bar strip, over a
  light and a dark call), never centred on a stage.

## Notifications, the menu bar and other macOS surfaces (added by the redesign sweep, 2026-10-08)

- **One word list.** A notification's title is the same headline the page shows for that warning
  (`shared/captureWords.ts`, T2); its body is main's message, which follows Copy and the Naming list
  like any page text. Never transcript text (lock screen, history).
- **A click opens the place it is about** (the meeting of a warning). Only the call-ended stop, the
  loud warnings and Set up Roger's test post one.
- **The menu bar item** follows the naming list; it may say "Reconnect Google Calendar" in full (a
  menu has no context to lean on). Its icon is a template glyph: idle, recording, and recording with a
  loud warning; the calendar grant's warning never outranks recording.
- **The app icon, About, the dock** carry Roger's own icon (decision D3). The only dock badge is "!"
  when macOS refuses notifications.
- **Native dialogs and pages Roger serves** (the Google sign-in return page, the fatal start box)
  speak plainly and say what to do; the sign-in page uses the paper canvas and the system font in both
  themes.
- **Permission prompts** use the naming list: microphone, call audio.

## Words from main (added by the redesign sweep, 2026-10-08)

- Main writes every sentence a person reads in plain words with the next step, on the page, the
  banner, the prompt panel, a notification, a menu or a Set up Roger row. Vendor names with codes,
  HTTP statuses, routes, errnos, ids and the words helper, stream, worklet, Postgres, API, SQLite go
  to the log and to a detail field (`errorDetail`) that only Details shows.
- `describeError` is the renderer's last net, not the plan: it rewrites only the API client's
  shapes. A new failure gets its sentence where it is made (`main/capture/errorWords.ts`).
- A time that ticks never rides in a message ("in 12 s"): it re-renders the line every second.

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
  Transcript offsets "4:07", "1:02:05" over an hour (a citation chip keeps the API's "00:15":
  see Citation chip). Dates "Wed 7 Oct" everywhere: Home's Earlier and the meeting page's time
  line ("Mon 5 Oct, 3:00 pm to 3:03 pm") both come from `meetingDayLabel`, English whatever the
  Mac's language. Every error line goes through `describeError`: a few plain words per kind
  ("Roger could not reach its server."), never a route, an address or a vendor's text.
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
| system audio (permission prompt), Mic (me), "the call audio helper" (sweep) | **call audio**, **microphone**; the helper is never named outside Details |
| the recording, a recording (noun) (sweep) | **the meeting**, or **notes** ("Roger stopped the notes on Weekly sync") |
| Start (in "press Stop, then Start again") (sweep) | **Start notes** |
| clean notes (sweep) | **AI notes** |
| Back, Go back, the wordmark as the way Home (sweep) | **‹ Home** |
| Theme, Dark mode, Light mode (sweep) | **Appearance**: **System**, **Light**, **Dark** |
| Untitled meeting, for an invite with no title (sweep) | **Meeting at 3:27 pm**, the title the meeting will get |

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
- QA (R10, `e2e/redesign.qa.e2e.ts`): a check that scrolls moves what the shot shows. A visibility
  helper that called `scrollIntoView` put the transcript on its first line while the check before
  it had proved it sat on the newest. The checks never scroll; the shell is grown to its content
  (`qa.fitShellPage`) so everything a check reads is in the viewport already.
- QA finds the primary two ways, by `data-variant="primary"` and by a computed background equal to
  the accent fill, so a control that skipped `.btn` is still counted. A busy primary has
  `pointer-events: none`, so `elementFromPoint` skips it: assert its `aria-disabled` and its label
  instead. With a modal `<dialog>` open only its own controls count, the page behind is inert.
- The prompt panel is not a scenario of the main preview: it is its own page
  (`preview/prompt.html?card=meeting-link`, states in `preview/promptScenarios.ts`), has no fake
  `window.roger`, and follows the system scheme only, so QA forces the theme with the browser's
  colour scheme, not a preference. It sits on a `fill` stage as wide as the real window (360 px).
- A menu anchored `right: 0` of its trigger left the window when the trigger sat at the left edge:
  at 390 the header's actions wrap under the title, and the ⋯ menu opened 142 px off screen with
  its labels cut. Fixed in R13: `Menu` flips to the other edge when the list would not fit
  (`menuPlacement.ts`), and QA's `expectMenuInWindow` fails any open menu outside the window. Check
  a menu at 390, not only at 1440.
- Raw API text reached the page (a failed jargon save read "Not saved: PUT /v1/vocabulary failed:
  connect ECONNREFUSED 127.0.0.1:8000"). Fixed in R13: `describeError` (`app/describeError.ts`)
  maps the API client's message shapes to plain words, and every error line uses it. A new
  `Error` text shown on the page goes through it; copy rule: no routes, verbs or errnos outside
  Details.
- Lines the server refused for good show in the banner on every page except the meeting page whose
  header already says it (`m2-capture-status.ts`: `CaptureWarnings` and `RefusedLines` both decide
  through `captureStatusFor`). A person who stops a call and stays on Home is told.
- A failed note keeps its failed state while a retry is out (`NotesSync`): `syncing` written over
  `refused` made the "Not saved to Roger" line blink off during every retry.

Added by the redesign sweep (2026-10-08, `docs/plans/redesign-sweep.md`):

- A surface outside the main window is still a surface. The redesign restyled every page and left
  the prompt panel, notifications, the menu bar, the app menu, the app icon, the window and the
  sign-in page as they were; R8 only removed things from the panel. Any design pass lists them
  (the sweep's inventory) before it starts.
- QA that feeds the page invented copy proves nothing about the words. The redesign's QA warning read
  "Roger can't hear the call. Check the call plays on this Mac." while main sends "Call audio has been
  silent for 3 minutes. ... press Stop, then Start again." A QA fixture for main's text imports main's
  own messages.
- QA at sizes the window never has: the gallery was 1440 and 390 while the window opened at 520, and
  the 360 px prompt panel was shot "at 1440" on a centred stage. Shoot the window's real sizes and the
  panel at its real place.
- `describeError` passes any text it does not recognise: "xAI: rejected with HTTP 401" reached the
  banner of the installed app through `CaptureStatus.error`, which never went through it at all.
  Plain words are made where the failure is (Words from main).
- `fill` on `raised` vanishes in dark, and the trap above was written for panels inside dialogs: the
  same pairing is the ghost hover of the prompt card and the menu rows. Hover on a raised surface reads
  `fill-raised`.
- The API's calendar provider defaulted to `fake`: a press of Connect against a local API signs in as
  `you@example.com` in an instant, and its scripted "Weekly sync" then pops the prompt panel all day on
  a real Mac. A demo source is labelled as one and never the default.
- With `titleBarStyle: 'hiddenInset'` the header is the drag region: a control without `no-drag`
  drags the window instead of clicking, and anything in the left 80 px sits under the traffic lights.
- The prompt panel cannot animate out if main hides its window the moment the state empties
  (`PromptWindow.sync`): main waits for the page's height-0 report, with a fallback timer.
