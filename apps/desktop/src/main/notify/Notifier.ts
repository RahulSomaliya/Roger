import { app, BrowserWindow, Notification } from 'electron';
import { type CaptureWarning, WARNING_NOTIFY_INTERVAL_MS } from '../../shared/capture';
import { warningTitle } from '../capture/warnings';
import type { LogFields, Logger } from '../logger';

export interface NotificationContent {
  title: string;
  /** For people. Never transcript text: macOS shows it on the lock screen and in its history. */
  body: string;
}

/**
 * What the Notifier needs of Electron (electronNotifierPorts). Tests pass a fake: no test may post
 * a real macOS notification.
 */
export interface NotifierPorts {
  /** Posts a macOS notification; `onFailed` runs if macOS refuses it or cannot show it. */
  show(content: NotificationContent, onFailed: (error: string) => void): void;
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
}

/** The dock badge while a warning could not be posted. */
const FAILED_BADGE = '!';

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
  private badged = false;

  constructor(private readonly options: NotifierOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Posts one notification now. If macOS refuses it, the dock bounces and shows a badge. */
  notify(content: NotificationContent, fields: LogFields = {}): void {
    const { ports, logger } = this.options;
    logger.info('posting a notification', { ...fields, title: content.title });
    ports.show(content, (error) => {
      logger.warn('notification failed; bouncing the dock instead', {
        ...fields,
        title: content.title,
        error,
      });
      ports.bounceDock();
      ports.setDockBadge(FAILED_BADGE);
      this.badged = true;
    });
  }

  /**
   * Follows the status's warnings (`CaptureStatus.warnings`, every feature's): call it with each
   * status. A loud spell posts once, the first time it is seen while Roger is not in focus; a
   * spell that began while Roger was in focus posts when Roger leaves focus, if it still lasts.
   */
  updateWarnings(warnings: readonly CaptureWarning[]): void {
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
      this.notify(
        { title: warningTitle(warning), body: warning.message },
        { kind: warning.kind, source: warning.source },
      );
    }
    // A spell that ended is forgotten: one that comes back is a new spell even if dated the same
    // (WarningSpells dates it in audio time), and the set stays as small as the warnings on screen.
    this.handled = new Set([...this.handled].filter((spell) => live.has(spell)));
    if (this.badged && (live.size === 0 || ports.isFocused())) {
      ports.setDockBadge('');
      this.badged = false;
    }
  }
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

/** The Notifier's ports on Electron, for the window `getMainWindow` returns. */
export function electronNotifierPorts(getMainWindow: () => FocusableWindow | null): NotifierPorts {
  // Held until macOS answers, so a notification is not collected with its `failed` listener
  // before the answer comes.
  const pending = new Set<Notification>();
  return {
    show(content, onFailed) {
      if (!Notification.isSupported()) {
        onFailed('this Mac does not support notifications for Roger');
        return;
      }
      const notification = new Notification({ title: content.title, body: content.body });
      pending.add(notification);
      const settle = (): void => {
        pending.delete(notification);
      };
      notification.on('show', settle);
      notification.on('close', settle);
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
