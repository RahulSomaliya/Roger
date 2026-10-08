import { app, BrowserWindow, Notification } from 'electron';
import { type CaptureWarning, WARNING_NOTIFY_INTERVAL_MS } from '../../shared/capture';
import { parseAppRoute, type AppRoute } from '../../shared/ipc/app';
import { warningTitle } from '../capture/warnings';
import type { LogFields, Logger } from '../logger';

export interface NotificationContent {
  title: string;
  /** For people. Never transcript text: macOS shows it on the lock screen and in its history. */
  body: string;
  /**
   * Where a click on the notification goes (the meeting it is about). Left out: Roger's window
   * opens where it was, which is Home when nothing else is open.
   */
  route?: AppRoute;
}

/**
 * What the Notifier needs of Electron (electronNotifierPorts). Tests pass a fake: no test may post
 * a real macOS notification.
 */
export interface NotifierPorts {
  /**
   * Posts a macOS notification; `onFailed` runs if macOS refuses it or cannot show it, `onClick`
   * when the person clicks it.
   */
  show(content: NotificationContent, onFailed: (error: string) => void, onClick: () => void): void;
  /** Bounces the dock icon until Roger is activated. */
  bounceDock(): void;
  /** Badges the dock icon; '' clears it. */
  setDockBadge(text: string): void;
  /** True while Roger's main window has focus: the warning banner is in sight. */
  isFocused(): boolean;
}

export interface NotifierOptions {
  ports: NotifierPorts;
  logger: Logger;
  clock?: () => number;
  /**
   * Brings Roger's window forward on `route` (index.ts: navigation plus show and focus). Left out,
   * a click does nothing; a notification Roger posted must never be a dead end (sweep N-gap).
   */
  open?: (route: AppRoute) => void;
}

/** The dock badge while a notification could not be posted (BadgeCause says which). */
const FAILED_BADGE = '!';

/**
 * Why the dock shows FAILED_BADGE. A warning's lasts while a loud warning does and Roger is out of
 * focus: the status repeats the warning, and the banner shows it. A one-off's (M2-T17b's "the
 * call ended", M2-T19's test) lasts until Roger is in focus: no status repeats what it said, and
 * the statuses that follow (one every upload tick, 2 s) hold no warning, so clearing it with the
 * warnings would wipe it before anyone saw it.
 */
type BadgeCause = 'warning' | 'one-off';

/**
 * Where warnings reach a user who is not looking at Roger (M2 design, "Where warnings reach the
 * user"): a macOS notification for each loud warning spell while Roger is not in focus, at most
 * one every WARNING_NOTIFY_INTERVAL_MS per kind and source. A different kind or source always
 * posts: one limit for all would hide a second, different cut (a dead mic a minute after the
 * network went), and the exit check cuts three ways back to back.
 *
 * Electron 42+ posts through UNUserNotificationCenter, which wants a signed app; the self-signed
 * build is unverified, so a refusal (`failed`) bounces the dock and badges it instead. M2-T17b's
 * "the call ended" and M2-T19's test notification post through `notify`.
 */
export class Notifier {
  private readonly clock: () => number;
  /** Spells (kind, source and start) already posted, or held back by the limit, while they last. */
  private handled = new Set<string>();
  /** When each kind and source last posted (the rate limit's key). */
  private readonly lastPostedAtMs = new Map<string, number>();
  private readonly badgedFor = new Set<BadgeCause>();

  constructor(private readonly options: NotifierOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * Posts one notification now. If macOS refuses it, the dock bounces and shows a badge until
   * Roger is in focus.
   */
  notify(content: NotificationContent, fields: LogFields = {}): void {
    this.post(content, fields, 'one-off');
  }

  /**
   * Follows the status's warnings (`CaptureStatus.warnings`, every feature's): call it with each
   * status. A loud spell posts once, the first time it is seen while Roger is not in focus; a
   * spell that began while Roger was in focus posts when Roger leaves focus, if it still lasts.
   * It is also when the Notifier looks at focus to clear the dock badge (BadgeCause).
   * `meetingId` is the live meeting: a click on a warning's notification opens its page.
   */
  updateWarnings(warnings: readonly CaptureWarning[], meetingId: string | null = null): void {
    const { ports, logger } = this.options;
    const live = new Set<string>();
    for (const warning of warnings) {
      if (!warning.loud) continue;
      const spell = spellOf(warning);
      live.add(spell);
      if (this.handled.has(spell) || ports.isFocused()) continue;
      this.handled.add(spell);
      const key = limitKey(warning);
      const now = this.clock();
      const lastPostedAtMs = this.lastPostedAtMs.get(key);
      if (lastPostedAtMs !== undefined && now - lastPostedAtMs < WARNING_NOTIFY_INTERVAL_MS) {
        logger.info('warning notification held back: one of its kind and source went out lately', {
          kind: warning.kind,
          source: warning.source,
          sincePostedMs: now - lastPostedAtMs,
        });
        continue;
      }
      this.lastPostedAtMs.set(key, now);
      this.post(
        { title: warningTitle(warning), body: warning.message, ...meetingRoute(meetingId) },
        { kind: warning.kind, source: warning.source },
        'warning',
      );
    }
    // A spell that ended is forgotten: one that comes back is a new spell even if dated the same
    // (WarningSpells dates it in audio time), and the set stays as small as the warnings on screen.
    this.handled = new Set([...this.handled].filter((spell) => live.has(spell)));
    // Focus is asked only while a badge is up. Every status passes here, and the runtime's tests
    // (createCaptureRuntime.test.ts, ipc.test.ts) mock `electron` without BrowserWindow, so a
    // check on every status throws there.
    if (this.badgedFor.size === 0) return;
    const focused = ports.isFocused();
    if (live.size === 0 || focused) this.unbadge('warning');
    if (focused) this.unbadge('one-off');
  }

  private post(content: NotificationContent, fields: LogFields, cause: BadgeCause): void {
    const { ports, logger } = this.options;
    logger.info('posting a notification', { ...fields, title: content.title });
    const route = content.route ?? 'home';
    ports.show(
      content,
      (error) => {
        logger.warn('notification failed; bouncing the dock instead', {
          ...fields,
          title: content.title,
          error,
        });
        ports.bounceDock();
        if (this.badgedFor.size === 0) ports.setDockBadge(FAILED_BADGE);
        this.badgedFor.add(cause);
      },
      () => {
        logger.info('notification clicked', { ...fields, route });
        this.options.open?.(route);
      },
    );
  }

  /** The badge goes once no cause is left. */
  private unbadge(cause: BadgeCause): void {
    if (this.badgedFor.delete(cause) && this.badgedFor.size === 0) {
      this.options.ports.setDockBadge('');
    }
  }
}

/** The live meeting's page, or nothing when none runs (or its id is not one: never throw here). */
function meetingRoute(meetingId: string | null): { route: AppRoute } | Record<string, never> {
  const route = meetingId === null ? null : parseAppRoute(`meeting/${meetingId}`);
  return route === null ? {} : { route };
}

function limitKey({ kind, source }: Pick<CaptureWarning, 'kind' | 'source'>): string {
  return `${kind}/${source ?? 'none'}`;
}

function spellOf(warning: CaptureWarning): string {
  return `${limitKey(warning)}@${warning.since}`;
}

/** A window as the focus check reads it: Roger's main window is told apart by its page's id. */
interface FocusableWindow {
  readonly webContents: { readonly id: number };
}

/** Notifications kept alive for their click; far more than a person has on screen. */
const MAX_HELD_NOTIFICATIONS = 20;

/** The Notifier's ports on Electron, for the window `getMainWindow` returns. */
export function electronNotifierPorts(
  getMainWindow: () => FocusableWindow | null,
): NotifierPorts & { heldCount(): number } {
  // Held until it is clicked, closed or failed, NOT merely shown: Electron emits `click` only on a
  // live object, so a notification dropped at `show` can be collected before the person clicks it a
  // minute later, and the click (which opens its meeting) then does nothing.
  const pending = new Set<Notification>();
  return {
    heldCount: () => pending.size,
    show(content, onFailed, onClick) {
      if (!Notification.isSupported()) {
        onFailed('this Mac does not support notifications for Roger');
        return;
      }
      const notification = new Notification({ title: content.title, body: content.body });
      pending.add(notification);
      // Insertion order: past the cap the oldest is let go, so a Mac that never fires `close` cannot
      // grow this set without limit.
      if (pending.size > MAX_HELD_NOTIFICATIONS) {
        const oldest = pending.values().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      const settle = (): void => {
        pending.delete(notification);
      };
      notification.on('close', settle);
      notification.on('click', () => {
        settle();
        onClick();
      });
      notification.on('failed', (_event, error) => {
        settle();
        onFailed(error);
      });
      notification.show();
    },
    bounceDock() {
      app.dock?.bounce('critical');
    },
    setDockBadge(text) {
      app.dock?.setBadge(text);
    },
    isFocused() {
      const focused = BrowserWindow.getFocusedWindow();
      const main = getMainWindow();
      return focused !== null && main !== null && focused.webContents.id === main.webContents.id;
    },
  };
}
