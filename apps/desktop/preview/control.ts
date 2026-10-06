import type { Unsubscribe } from '../src/shared/ipc';
import { FakeHub } from './fakes/hub';
import type { ScenarioId, StopScenario } from './scenarios';

/**
 * How the preview stands in for main beyond what each fake does: which theme is stored, whether
 * the Roger API answers, and the `window.__rogerPreview` handle QA scripts drive (qa/driver.ts).
 */

/** A theme the page is forced into; null follows the system, as the app does by default. */
export type ForcedTheme = 'light' | 'dark';

/**
 * The class name an error crossing IPC keeps: main's own errors are `Error`, its API clients throw
 * `ApiError` (src/main/api/http.ts).
 */
export type MainErrorName = 'Error' | 'ApiError';

/**
 * M4-S2's request for every stored preference, answered as a record by key (`PreferenceValues`).
 * The forced theme rides on it so the app's own `theme` preference picks the theme, as a
 * preferences.json holding it would. control.test.ts fails once S2's channels exist without it.
 */
export const PREFS_GET_ALL_CHANNEL = 'prefs:get-all';

/**
 * Features whose every request main answers from the Roger API: the jargon list (M3-T8,
 * `vocabulary:get` and `vocabulary:set`) and chat, whose history and answers live only in
 * Postgres. Matched by name, so a channel those features add later fails offline too. Meetings,
 * preferences and capture answer from main's own state and keep working offline: their screens
 * learn the API is away from status events, which a script pushes with `emit`.
 *
 * Notes are both. Main keeps each meeting's docs in notes.sqlite, so loading and saving them works
 * offline, but the template list (`GET /v1/note-templates`) and a run's stored docs ("Restore
 * previous notes", `GET /v1/meetings/{id}/runs/{run_id}`) exist only in the API: notesClient
 * (M4-T14) fetches them live. The notes fake marks those answers with fromApi(), or the offline
 * scenario shows a template picker full of templates where the app shows an ApiError.
 */
const API_CHANNEL_PREFIXES = ['vocabulary:', 'chat:'] as const;

/** What main's API client says when nothing answers at the API's address (`make dev-api`). */
const API_UNREACHABLE = 'connect ECONNREFUSED 127.0.0.1:8000';

/** How long settled() waits for requests and subscriptions to stop before it calls the page busy. */
const SETTLE_ROUNDS = 50;

export function reachesApi(channel: string): boolean {
  return API_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix));
}

/** Answers marked by fromApi(), with the route main calls for each. */
const apiRoutes = new WeakMap<() => unknown, string>();

/**
 * Marks a fake's answer as one main fetches from the Roger API on `route` (method and path, such
 * as `GET /v1/note-templates`), for a feature whose other requests main answers from its own state.
 * While the API is offline, PreviewHub fails a request with this answer as main's ApiError for that
 * route. The mark rides on the answer, not the channel, so a fake marks it from its own file:
 * `hub.request(channel, fromApi(route, () => templates))`. On a plain FakeHub it changes nothing.
 */
export function fromApi<T>(route: string, answer: () => T): () => T {
  apiRoutes.set(answer, route);
  return answer;
}

/** The route main calls for this request, or null when main answers it from its own state. */
function apiRoute(channel: string, answer: () => unknown): string | null {
  return apiRoutes.get(answer) ?? (reachesApi(channel) ? channel : null);
}

/**
 * Main's ApiError message for a request nothing answered (`${method} ${path} failed: reason` in
 * src/main/api/http.ts). `request` is the method and path, or the channel when the preview does
 * not know which route main would call.
 */
export function apiUnreachableMessage(request: string): string {
  return `${request} failed: ${API_UNREACHABLE}`;
}

/**
 * What the renderer sees when main's handler for `channel` throws. Electron sends the error's
 * text, never the object: ipcRenderer.invoke rejects with a plain Error, so renderer code that
 * checks `instanceof ApiError` is wrong in the app, and the preview never hands one out either.
 */
function invokeError(channel: string, name: MainErrorName, message: string): Error {
  return new Error(`Error invoking remote method '${channel}': ${name}: ${message}`);
}

export interface PreviewHubOptions {
  forcedTheme?: ForcedTheme | null;
  /** Resolves after the next painted frame; tests under Node pass a timer instead. */
  nextFrame?: () => Promise<void>;
}

/**
 * The hub the preview's fakes run on (FakeHub, P2-F1), plus main's state that no single fake owns:
 * the stored theme, an offline API, failures named like main's errors, and counts of requests and
 * subscriptions so a script can wait for the page to settle.
 */
export class PreviewHub extends FakeHub {
  private readonly forcedTheme: ForcedTheme | null;
  private readonly nextFrame: () => Promise<void>;
  // Not FakeHub's own queue: that one can only fail with `Error`, and this one also names ApiError.
  private readonly queuedFailures: { name: MainErrorName; message: string }[] = [];
  private apiOffline = false;
  private inFlight = 0;
  /** Requests and subscriptions so far: settled() waits until neither moves. */
  private started = 0;
  private subscribed = 0;

  constructor(options: PreviewHubOptions = {}) {
    super();
    this.forcedTheme = options.forcedTheme ?? null;
    this.nextFrame =
      options.nextFrame ??
      (() =>
        new Promise((resolve) => {
          requestAnimationFrame(() => {
            resolve();
          });
        }));
  }

  /** The next request, on any channel, rejects as if main's handler threw `name: message`. */
  override failNextRequest(message: string, name: MainErrorName = 'Error'): void {
    this.queuedFailures.push({ name, message });
  }

  /**
   * While offline, every request that main answers from the Roger API fails: a channel of an
   * API-only feature (reachesApi), or an answer a fake marked with fromApi().
   */
  setApiOffline(offline: boolean): void {
    this.apiOffline = offline;
  }

  override on(channel: string, listener: (payload: never) => void): Unsubscribe {
    this.subscribed += 1;
    return super.on(channel, listener);
  }

  override request<T>(channel: string, answer: () => T): Promise<T> {
    const route = this.apiOffline ? apiRoute(channel, answer) : null;
    const failure =
      this.queuedFailures.shift() ??
      (route === null
        ? null
        : { name: 'ApiError' as const, message: apiUnreachableMessage(route) });
    const reply =
      failure === null
        ? super.request(channel, this.stored(channel, answer))
        : Promise.reject(invokeError(channel, failure.name, failure.message));
    this.started += 1;
    this.inFlight += 1;
    return reply.finally(() => {
      this.inFlight -= 1;
    });
  }

  /**
   * Resolves once no request is in flight and none started, and no listener subscribed, over two
   * painted frames: the app has subscribed, asked main for what it shows and drawn the answers.
   * Requests alone are not enough: React subscribes in effects that may run a frame after it
   * renders, before the app's first request, and an event sent then reaches nobody. Rejects if
   * requests keep starting (a poll every frame), so a script never waits on a page that cannot
   * settle.
   */
  async settled(): Promise<void> {
    for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
      const startedBefore = this.started;
      const subscribedBefore = this.subscribed;
      await this.nextFrame();
      await this.nextFrame();
      if (
        this.inFlight === 0 &&
        this.started === startedBefore &&
        this.subscribed === subscribedBefore
      ) {
        return;
      }
    }
    throw new Error(
      `The preview did not settle: requests or subscriptions kept starting for ${SETTLE_ROUNDS * 2} frames (${this.inFlight} requests in flight)`,
    );
  }

  /** The answer as main would give it with this preview's stored preferences. */
  private stored<T>(channel: string, answer: () => T): () => T {
    const theme = this.forcedTheme;
    if (theme === null || channel !== PREFS_GET_ALL_CHANNEL) return answer;
    return () => {
      const values = answer();
      if (typeof values !== 'object' || values === null) {
        throw new Error(
          `${PREFS_GET_ALL_CHANNEL} answered ${typeof values}, not the preferences by key: cannot force the theme`,
        );
      }
      return { ...values, theme };
    };
  }
}

/** `window.__rogerPreview`: what a QA script (qa/driver.ts) or a person in DevTools can drive. */
export interface PreviewControl {
  /** The scenario the page started with. */
  readonly scenario: ScenarioId;
  /**
   * Sends a main → renderer event on a real channel (IpcChannel), as webContents.send would. The
   * payload is not checked: send what the contract says.
   */
  emit(channel: string, payload: unknown): void;
  /** The next request rejects as if main's handler threw `name: message` (`Error` by default). */
  failNextRequest(message: string, name?: MainErrorName): void;
  /** Takes the Roger API away or brings it back for the requests main answers from it. */
  setApiOffline(offline: boolean): void;
  /** Stops the scenario's timers, such as the live call's new lines: a fixed frame to shoot. */
  stopScenario(): void;
  /** Resolves once the page's requests are answered and drawn (PreviewHub.settled). */
  settled(): Promise<void>;
}

declare global {
  interface Window {
    __rogerPreview?: PreviewControl;
  }
}

export function installPreviewControl(
  target: Pick<Window, '__rogerPreview'>,
  options: { hub: PreviewHub; scenario: ScenarioId; stop: StopScenario },
): void {
  const { hub, scenario, stop } = options;
  target.__rogerPreview = {
    scenario,
    emit: (channel, payload) => {
      hub.emit(channel, payload);
    },
    failNextRequest: (message, name) => {
      hub.failNextRequest(message, name);
    },
    setApiOffline: (offline) => {
      hub.setApiOffline(offline);
    },
    stopScenario: stop,
    settled: () => hub.settled(),
  };
}
