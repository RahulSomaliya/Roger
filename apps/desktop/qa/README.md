# Browser QA

Roger's screens are checked in a browser, not in Electron: the **preview** runs the renderer in
Chrome with a fake `window.roger`, and **`qa/driver.ts`** opens it, checks it and shoots it. Every
QA gallery uses this one driver. The one QA script is `e2e/redesign.qa.e2e.ts`: every screen in its
states, both themes, at the window's two real sizes (1080 x 730 and 420 x 760), with the checks the
redesign and the sweep promise (at most one visible primary and the one `docs/design.md` names,
every problem line visible, no raw text outside Details, the header's Home and current gear, no
sideways scroll, no console error, nothing animating), and the behaviours: Back, Escape, what
main's Cmd+[ sends, focus on the h1, Appearance, no focus box). It replaced the per-milestone scripts, which selected classes
the redesign deleted.

## The preview

```bash
pnpm --filter @roger/desktop preview:renderer
# http://127.0.0.1:5173/?scenario=live-call&theme=dark
```

It loads the renderer's own entry (`src/renderer/src/main.tsx`) after putting the fake in place,
so it shows exactly what the app shows. Query parameters:

| Parameter  | Values                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `scenario` | `empty-mac` (the default), `past-meeting`, `live-call`, `api-offline`                                   |
| `theme`    | `light` or `dark`, given to the app as its stored `theme` preference; leave it out to follow the system |

| Scenario       | Main's state                                                                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty-mac`    | Roger has never recorded here: idle, nothing to upload                                                                                                                                        |
| `past-meeting` | A standup that has ended (`preview/fixtures/past-meeting.json`): its lines, all uploaded, the meter kept after Stop                                                                           |
| `live-call`    | A client call recording: 500 lines at once, then one every 200 ms with an interim before it, until Stop                                                                                       |
| `api-offline`  | The past meeting waiting to upload (the uploader backing off), Start failing on the speech-to-text token, and API requests (vocabulary, chat, answers marked `fromApi`) failing with ApiError |

`<html data-state>` is `loading`, then `ready` once the scenario is drawn, or `error` with the
reason in `data-error`. Line N of a scenario meeting has a fixed id, `segmentIdForLine(meetingId,
N)` from `preview/scenarios.ts`, so a script can cite "line 40" of the live call.

`window.__rogerPreview` drives the page from a script or DevTools:

| Member                           | What it does                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `emit(channel, payload)`         | Sends a main → renderer event on a real channel (`IpcChannel`), unchecked: send what the contract says                          |
| `failNextRequest(message, name)` | The next request rejects as if main's handler threw `name: message` (`Error`, or `ApiError`)                                    |
| `setApiOffline(offline)`         | Requests main answers from the Roger API (`vocabulary:*`, `chat:*`, answers marked `fromApi`) fail with ApiError, or work again |
| `stopScenario()`                 | Stops the scenario's timers (the live call's new lines) for a fixed frame                                                       |
| `settled()`                      | Resolves once requests are answered, subscriptions done and the page drawn                                                      |

**Errors cross IPC as text.** Electron sends the error's string, so `ipcRenderer.invoke` rejects
with a plain `Error`: `Error invoking remote method 'vocabulary:get': ApiError: <message>`. Renderer
code that checks `instanceof ApiError` is wrong in the app; the preview never hands one out either.

**Fakes.** The task that adds members to `src/shared/ipc/<feature>.ts` also writes the fake in
`preview/fakes/<feature>.ts`; the type check fails until it does. A fake answers through
`hub.request` and sends events with `hub.emit`, so scenarios and scripts can drive it. A fake that
answers reads (the meetings list, a meeting's lines) can record what the scenarios play on the
hub, as main's store records what it sends. The offline API fails the `vocabulary:` and `chat:`
channels (`API_CHANNEL_PREFIXES` in `preview/control.ts`), the two features whose every request
goes to the API; `preview/control.test.ts` fails if one of their channels lacks the prefix.

**A feature that is partly online marks its API answers.** Notes work offline from `notes.sqlite`,
but main fetches the template list (`GET /v1/note-templates`) and a run's stored docs live, so the
notes fake answers those through `fromApi` from `preview/control.ts`:
`hub.request(channel, fromApi('GET /v1/note-templates', () => templates))`. Offline, that request
fails as main's ApiError for the route; unmarked, the offline scenario shows a filled template
picker where the app shows an error. `failNextRequest` is no stand-in: it fails whichever request
comes next.

## The prompt panel's preview

The panel is its own page with its own preload, so it is not a scenario of the page above:
`http://127.0.0.1:5173/prompt.html?card=meeting-link` (cards: `preview/promptScenarios.ts`). It has
a fake `window.rogerPrompt` that records clicks on `window.__rogerPromptPreview.acts`, no
`window.roger`, and no `useTheme`: it follows the system colour scheme only, which `qa.openPrompt`
forces with the browser context. `<html data-preview="prompt">` tells `qa.settle()` there is no
`__rogerPreview` to wait on.

## A QA script

A QA script is a vitest file, `e2e/<task>.qa.e2e.ts`, so vitest compiles it and `expect` makes
each check a test. `make e2e-desktop` runs it with the Electron smoke test.

```ts
import { afterAll, beforeAll, it } from 'vitest';
import * as qa from '../qa/driver';

let run: qa.QaRun;
const gallery = new qa.Gallery('M4 notes', 'm4-t20');
beforeAll(async () => (run = await qa.startQa()));
afterAll(async () => {
  await run.close();
  await gallery.write({ Branch: 'p2/m4-t20' });
});

it('the live call in every theme and width', async () => {
  for (const theme of qa.QA_THEMES) {
    for (const width of qa.QA_WIDTHS) {
      const preview = await run.open({ scenario: 'live-call', theme, width });
      await qa.stopScenario(preview.page);
      await qa.expectVisible(preview.page, '[data-segment-id]:last-child', {
        within: '.transcript',
      });
      await qa.expectNoPageOverflow(preview.page);
      await gallery.shoot(
        preview.page,
        'Live call',
        `live-${theme}-${width}`,
        'The newest line shows',
      );
      qa.expectNoConsoleErrors(preview);
      await preview.close();
    }
  }
});
```

```bash
pnpm --filter @roger/desktop exec vitest run --config vitest.e2e.config.ts e2e/m4-t20.qa.e2e.ts
```

Shots and `shots.json` go to `ROGER_QA_OUT`, else `<tmp>/roger-qa/<slug>`, never into the repo.
`gallery.write()` adds to a `shots.json` already there (a shot of the same file is replaced), so a
script too long for one call runs in pieces, `-t "^home"`, `-t "^live"` and so on, each under about
8 minutes (a 10-minute stall limit kills a longer call). Clear the folder before a full run, or a
shot of a state that no longer exists stays in it. A screen that fails in a file the QA task does
not own goes in `KNOWN_FAILURES`: its shot is kept and marked `fail`, the run stays green, and the
run fails once the screen is fixed so the entry is removed.
`shots.json` is the manifest the gallery page is built from: `{ title, meta, groups: [{ name,
shots: [{ file, caption, check, note }] }] }`, `check` being `pass`, `warn` or `fail`. The gallery
is published as one page (an Artifact), never as loose PNG paths. Keep it under 12 MB: shoot PNG,
then write JPEG at quality about 55 with the 1080 shots scaled to about 900 px wide, light beside
dark in one image, and build the page with
`python3 ~/.claude/scripts/qa-gallery.py --manifest gallery.json -o <page>.html`. The first step is
`python3 -I qa/build-gallery.py <ROGER_QA_OUT> <ROGER_QA_OUT>/gallery.json` (needs Pillow, which this
Mac has): it pairs `<slug>-light-<size>.png` with its `-dark-` twin, writes the JPEGs to `jpg/` and
the manifest the page is built from.

## Rules the driver keeps, and why

- **Port 0.** The driver binds a free port itself and Vite answers on it. Vite's own `listen`
  reads port 0 as unset and takes 5173, and its middleware mode opens HMR on the fixed port 24678,
  so two runs would collide.
- **System Chrome.** `/Applications/Google Chrome.app` through playwright-core; nothing is
  downloaded. `ROGER_QA_CHROME` names another binary (Linux CI).
- **The theme is forced twice**, through the app's `theme` preference and the system scheme, and
  `openPreview` fails unless both agree. Headless Chrome inherits the Mac's appearance, so on a
  dark-mode Mac a "light" shot otherwise comes out dark.
- **Wait on the page, never the network.** `networkidle` never comes while the HMR socket is
  open. Wait for `html[data-state="ready"]` (the driver does), then `settle()`: it also waits for
  the app's subscriptions and finite animations, so a shot never catches a colour mid-fade.
- **Never `fullPage`.** It re-runs fill-mode CSS animations inside the capture. `screenshot()`
  grows the viewport to the document instead. `screenshotElement()` clips that page: never
  `locator.screenshot()`, which scrolls the page so the next click lands off its target.
- **The shell scrolls inside itself.** The app shell is one screen tall and scrolls in
  `.shell-page`, so growing to the document shows nothing below the fold. On a page in the shell,
  call `fitShellPage()` before `screenshot()` or `expectVisible()`: it grows the viewport until
  the column stops scrolling.
- **Visible means a person can see it.** `expectVisible()` checks the box, the viewport and
  `document.elementFromPoint` at its centre; a class or attribute check passes on an element drawn
  under an overlay. `elementFromPoint` skips `pointer-events: none`: check a disabled control's
  state instead.
- **The app's Content-Security-Policy.** `preview/index.html` carries `src/renderer/index.html`'s
  policy unchanged (`preview/index.test.ts` fails if they differ), so an image from another host or
  a fetch that skips main is refused and logged, as in Electron, and `expectNoConsoleErrors` fails.
- **Every gallery:** both themes, 1080 x 730 and 420 x 760 (`QA_THEMES`, `QA_WIDTHS`, `qaHeight`), no sideways page
  scroll, no console errors, and realistic data (long names, long lines, empty lists, many rows).
- **The prompt panel is shot on a screen, not a window.** `openPrompt` takes a 1440 x 900 screen
  (menu bar strip, a call behind it: `backdrop: 'dark' | 'light'`, the page's `?backdrop=`) and the
  panel sits where `promptBounds.ts` puts it; `Gallery.shootClip` crops the panel and a strip of the
  call around it. Theme there is the system scheme (the panel has no `useTheme`; main's
  `nativeTheme` does it in the app), so all four theme and backdrop pairs are shot.
- **`getPreferences()` in the preview always answers the forced theme.** A set reaches the fake and
  fires `PrefsChanged`, but the read-back is the forced one: assert a save by waiting for
  `onPreferenceChanged`, not by reading the preference back.
- **Words are main's.** `detectWarnings`, `START_FAILURE_SENTENCES`, `unsavedLinesWords`,
  `stopNotice` and `describeServerFailure` build the QA's status text, so a reworded message changes
  the shots and an unplain one fails `expectNoInternals` (`wordsOutsideDetails`, the list main's own
  tests use). Details is skipped by `startsWith('Details')` on the dialog's text: its title runs
  into the first row ("DetailsMicrophone"), so a `\b` after the word never matches.
