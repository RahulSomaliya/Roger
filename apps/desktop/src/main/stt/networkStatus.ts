import { errorMessage, type Logger } from '../logger';

/**
 * How often main asks whether the Mac is online (M2 design, "STT reconnect"): Wi-Fi turned off
 * suspends speech-to-text within a second, well inside the exit check's 10 s warning.
 */
export const NETWORK_POLL_MS = 1_000;

/** What the poll suspends and resumes: the live CaptureSession, handed over in the T6 slot. */
export interface NetworkFollower {
  suspendStreams(reason: 'offline'): void;
  resumeStreams(reason: 'offline'): void;
}

export interface NetworkStatusOptions {
  /** Electron's `net.isOnline()` in the app. */
  isOnline: () => boolean;
  logger: Logger;
  /** Tests only; the app polls every NETWORK_POLL_MS. */
  pollMs?: number;
}

/**
 * Main's own view of the network, for speech-to-text (M2-T6). `ws` gets no prompt error when the
 * Mac's network goes down: a socket looks open while the audio sent into it is lost, until the
 * core's ping deadline (4 to 5 s) or TCP (minutes) notices. Polled here every second, `false`
 * suspends both sources at once (their sockets terminated, nothing reopened or fetched until it is
 * back), and back online each source reopens with its next chunk.
 *
 * Polled in main rather than taken from the renderer's `offline` event: the renderer may be
 * reloading (M2-T12) exactly when the network matters. Electron says `false` is a strong sign
 * that remote sites cannot be reached and `true` proves little, which is why the ping deadline
 * stays the check for a network that is up but not getting through.
 *
 * It follows one recording at a time (the T6 slot of createCaptureRuntime.ts: `follow` at
 * `started`, `stop` at `ended`), and polls only then: the session it suspends exists only while one
 * runs.
 */
export class NetworkStatus {
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private follower: NetworkFollower | null = null;
  /** The last reading this recording, so the follower hears each change once. */
  private online = true;

  constructor(private readonly options: NetworkStatusOptions) {
    this.pollMs = options.pollMs ?? NETWORK_POLL_MS;
  }

  /**
   * Polls for this recording, at once and then every pollMs, until stop(). It starts from online:
   * Start's sessions just opened, so the network was there a moment ago.
   */
  follow(follower: NetworkFollower): void {
    this.stop();
    this.follower = follower;
    this.online = true;
    this.poll();
    this.timer = setInterval(() => {
      this.poll();
    }, this.pollMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.follower = null;
  }

  /**
   * One reading. Runs on a timer, so nothing may escape it: a throw from a timer callback would
   * be an uncaught exception in main. A failed check keeps the last reading (logged), so the next
   * poll reads the network again. A change the follower threw on is logged and never sent again:
   * the reading has moved on, so the next poll sees no change (and suspendStreams records its
   * reason before it touches a source, so a second call would do nothing).
   */
  private poll(): void {
    const follower = this.follower;
    if (follower === null) return;
    let online: boolean;
    try {
      online = this.options.isOnline();
    } catch (error) {
      this.options.logger.error('network check failed', { error: errorMessage(error) });
      return;
    }
    if (online === this.online) return;
    this.online = online;
    try {
      if (online) {
        this.options.logger.info('network back: speech-to-text resumes');
        follower.resumeStreams('offline');
      } else {
        this.options.logger.warn('network offline: speech-to-text suspended');
        follower.suspendStreams('offline');
      }
    } catch (error) {
      this.options.logger.error('network change not applied', {
        online,
        error: errorMessage(error),
      });
    }
  }
}
