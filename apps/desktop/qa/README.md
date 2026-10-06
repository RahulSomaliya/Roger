# Browser QA

Phase 2's screens are checked in a browser, not in Electron: the **preview** runs the renderer in
Chrome with a fake `window.roger`, and **`qa/driver.ts`** opens it, checks it and shoots it. Every
QA gallery (M2, M3, M4, M5) uses this one driver.

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
`shots.json` is the manifest the gallery page is built from: `{ title, meta, groups: [{ name,
shots: [{ file, caption, check, note }] }] }`, `check` being `pass`, `warn` or `fail`. The gallery
is published as one page (an Artifact), never as loose PNG paths.

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
- **Visible means a person can see it.** `expectVisible()` checks the box, the viewport and
  `document.elementFromPoint` at its centre; a class or attribute check passes on an element drawn
  under an overlay. `elementFromPoint` skips `pointer-events: none`: check a disabled control's
  state instead.
- **The app's Content-Security-Policy.** `preview/index.html` carries `src/renderer/index.html`'s
  policy unchanged (`preview/index.test.ts` fails if they differ), so an image from another host or
  a fetch that skips main is refused and logged, as in Electron, and `expectNoConsoleErrors` fails.
- **Every gallery:** both themes, 1440 and 390 wide (`QA_THEMES`, `QA_WIDTHS`), no sideways page
  scroll, no console errors, and realistic data (long names, long lines, empty lists, many rows).
